import { createHash, randomBytes } from "node:crypto";

import { prisma } from "../../config/prisma";
import { AppError } from "../../errors/AppError";
import { ErrorCode } from "../../errors/errorCodes";
import { writeAuditLog, writeSecurityAuditLogSafely } from "../../audit/audit.service";
import type { AuditContext } from "../../audit/audit.types";
import { hashPassword } from "../utils/password";
import { generateOtp } from "../utils/otp";
import { hashOtp, compareOtp } from "../utils/otpHash";
import type {
  RequestPasswordResetOtpInput,
  VerifyPasswordResetOtpInput,
  ResetPasswordInput,
} from "../schemas/password-reset.schema";
import { sendPasswordResetOtpEmail } from "./password-reset-email.service";

const OTP_TTL_MS = 10 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;

const GENERIC_REQUEST_RESPONSE = {
  message: "If an eligible account exists for this email, a password reset OTP will be sent.",
};

const hashResetToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

export const requestPasswordResetOtp = async (
  input: RequestPasswordResetOtpInput,
  auditContext: AuditContext = {},
): Promise<typeof GENERIC_REQUEST_RESPONSE> => {
  const email = input.email.trim().toLowerCase();
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, status: true, emailVerifiedAt: true },
  });

  // Keep the response identical for unknown, inactive, and eligible accounts.
  if (!user || user.status !== "ACTIVE" || !user.emailVerifiedAt) {
    await writeSecurityAuditLogSafely({
      action: "PASSWORD_RESET_REQUESTED",
      resource: "USER",
      userId: user?.id ?? null,
      success: true,
      ...auditContext,
      metadata: { eligibleAccount: false },
    });
    return GENERIC_REQUEST_RESPONSE;
  }

  const otp = generateOtp();
  const otpHash = await hashOtp(otp);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS);

  await prisma.$transaction(async (tx) => {
    await tx.passwordResetOtp.updateMany({
      where: { userId: user.id, consumedAt: null },
      data: { consumedAt: now },
    });

    await tx.passwordResetOtp.create({
      data: { userId: user.id, otpHash, expiresAt },
    });

    await writeAuditLog(
      {
        action: "PASSWORD_RESET_REQUESTED",
        resource: "USER",
        resourceId: user.id,
        userId: user.id,
        description: "Password reset OTP requested.",
        ...auditContext,
      },
      tx,
    );
  });

  try {
    await sendPasswordResetOtpEmail(user.email, otp);
  } catch (error) {
    // Do not disclose account existence via delivery errors.
    console.error("[auth] password reset OTP email delivery failed", {
      requestId: auditContext.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return GENERIC_REQUEST_RESPONSE;
};

export const verifyPasswordResetOtp = async (
  input: VerifyPasswordResetOtpInput,
): Promise<{ resetToken: string; expiresInSeconds: number }> => {
  const email = input.email.trim().toLowerCase();
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, status: true, emailVerifiedAt: true },
  });

  const now = new Date();
  if (!user || user.status !== "ACTIVE" || !user.emailVerifiedAt) {
    throw new AppError("Invalid or expired password reset OTP", 400, ErrorCode.BAD_REQUEST);
  }

  const otpRecord = await prisma.passwordResetOtp.findFirst({
    where: { userId: user.id, consumedAt: null, verifiedAt: null },
    orderBy: { createdAt: "desc" },
  });

  if (
    !otpRecord ||
    otpRecord.expiresAt <= now ||
    otpRecord.attempts >= MAX_OTP_ATTEMPTS
  ) {
    throw new AppError("Invalid or expired password reset OTP", 400, ErrorCode.BAD_REQUEST);
  }

  const isValid = await compareOtp(input.otp, otpRecord.otpHash);
  if (!isValid) {
    await prisma.passwordResetOtp.updateMany({
      where: {
        id: otpRecord.id,
        consumedAt: null,
        verifiedAt: null,
        attempts: { lt: MAX_OTP_ATTEMPTS },
        expiresAt: { gt: now },
      },
      data: { attempts: { increment: 1 } },
    });
    throw new AppError("Invalid or expired password reset OTP", 400, ErrorCode.BAD_REQUEST);
  }

  const resetToken = randomBytes(32).toString("hex");
  const tokenHash = hashResetToken(resetToken);
  const tokenExpiresAt = new Date(now.getTime() + RESET_TOKEN_TTL_MS);

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.passwordResetOtp.updateMany({
      where: {
        id: otpRecord.id,
        userId: user.id,
        consumedAt: null,
        verifiedAt: null,
        attempts: { lt: MAX_OTP_ATTEMPTS },
        expiresAt: { gt: now },
      },
      data: { verifiedAt: now, consumedAt: now },
    });

    if (claimed.count !== 1) {
      throw new AppError("Invalid or expired password reset OTP", 400, ErrorCode.BAD_REQUEST);
    }

    await tx.passwordResetToken.updateMany({
      where: { userId: user.id, consumedAt: null },
      data: { consumedAt: now },
    });

    await tx.passwordResetToken.create({
      data: { userId: user.id, tokenHash, expiresAt: tokenExpiresAt },
    });
  });

  return { resetToken, expiresInSeconds: RESET_TOKEN_TTL_MS / 1000 };
};

export const resetPassword = async (
  input: ResetPasswordInput,
  auditContext: AuditContext = {},
): Promise<{ message: string }> => {
  const tokenHash = hashResetToken(input.token);
  const now = new Date();

  const resetRecord = await prisma.passwordResetToken.findFirst({
    where: { tokenHash, consumedAt: null, expiresAt: { gt: now } },
    select: { id: true, userId: true },
  });

  if (!resetRecord) {
    await writeSecurityAuditLogSafely({
      action: "PASSWORD_RESET_FAILED",
      resource: "USER",
      userId: null,
      success: false,
      failureReason: "Invalid or expired reset token",
      ...auditContext,
    });
    throw new AppError("Invalid or expired password reset token", 400, ErrorCode.BAD_REQUEST);
  }

  const passwordHash = await hashPassword(input.password);

  await prisma.$transaction(async (tx) => {
    const consumed = await tx.passwordResetToken.updateMany({
      where: {
        id: resetRecord.id,
        tokenHash,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      data: { consumedAt: now },
    });

    if (consumed.count !== 1) {
      throw new AppError("Invalid or expired password reset token", 400, ErrorCode.BAD_REQUEST);
    }

    await tx.user.update({
      where: { id: resetRecord.userId },
      data: { passwordHash },
    });

    await tx.refreshToken.updateMany({
      where: { userId: resetRecord.userId, revokedAt: null },
      data: { revokedAt: now },
    });

    await writeAuditLog(
      {
        action: "PASSWORD_RESET_COMPLETED",
        resource: "USER",
        resourceId: resetRecord.userId,
        userId: resetRecord.userId,
        description: "Password reset completed after OTP verification; active refresh tokens revoked.",
        ...auditContext,
        metadata: { refreshTokensRevoked: true },
      },
      tx,
    );
  });

  return { message: "Password has been reset successfully. Please log in again." };
};
