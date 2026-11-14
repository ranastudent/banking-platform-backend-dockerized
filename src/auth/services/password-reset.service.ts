import { createHash, randomBytes } from "node:crypto";

import { prisma } from "../../config/prisma";
import { AppError } from "../../errors/AppError";
import { ErrorCode } from "../../errors/errorCodes";
import { writeAuditLog, writeSecurityAuditLogSafely } from "../../audit/audit.service";
import type { AuditContext } from "../../audit/audit.types";
import { hashPassword } from "../utils/password";
import type {
  ForgotPasswordInput,
  ResetPasswordInput,
} from "../schemas/password-reset.schema";
import { sendPasswordResetEmail } from "./password-reset-email.service";

const RESET_TOKEN_TTL_MS = 15 * 60 * 1000;
const GENERIC_FORGOT_RESPONSE = {
  message: "If an eligible account exists for this email, password reset instructions will be sent.",
};

const hashResetToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

export const requestPasswordReset = async (
  input: ForgotPasswordInput,
  auditContext: AuditContext = {},
): Promise<typeof GENERIC_FORGOT_RESPONSE> => {
  const email = input.email.trim().toLowerCase();

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      status: true,
      emailVerifiedAt: true,
    },
  });

  // Do not disclose whether an account exists, is verified, or is active.
  if (!user || user.status !== "ACTIVE" || !user.emailVerifiedAt) {
    await writeSecurityAuditLogSafely({
      action: "PASSWORD_RESET_REQUESTED",
      resource: "USER",
      userId: user?.id ?? null,
      success: true,
      ...auditContext,
      metadata: { eligibleAccount: false },
    });
    return GENERIC_FORGOT_RESPONSE;
  }

  const token = randomBytes(32).toString("hex");
  const tokenHash = hashResetToken(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + RESET_TOKEN_TTL_MS);

  await prisma.$transaction(async (tx) => {
    // Only the newest outstanding reset link remains usable.
    await tx.passwordResetToken.updateMany({
      where: {
        userId: user.id,
        consumedAt: null,
      },
      data: { consumedAt: now },
    });

    await tx.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
      },
    });

    await writeAuditLog(
      {
        action: "PASSWORD_RESET_REQUESTED",
        resource: "USER",
        resourceId: user.id,
        userId: user.id,
        description: "Password reset requested.",
        ...auditContext,
      },
      tx,
    );
  });

  // Email delivery failure must not reveal account existence through the API.
  // The user can safely request another link; no plaintext token is persisted.
  try {
    await sendPasswordResetEmail(user.email, token);
  } catch (error) {
    console.error("[auth] password reset email delivery failed", {
      requestId: auditContext.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return GENERIC_FORGOT_RESPONSE;
};

export const resetPassword = async (
  input: ResetPasswordInput,
  auditContext: AuditContext = {},
): Promise<{ message: string }> => {
  const tokenHash = hashResetToken(input.token);
  const now = new Date();

  const resetRecord = await prisma.passwordResetToken.findFirst({
    where: {
      tokenHash,
      consumedAt: null,
      expiresAt: { gt: now },
    },
    select: {
      id: true,
      userId: true,
    },
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

    // A generic error avoids disclosing whether a token was ever issued.
    throw new AppError(
      "Invalid or expired password reset token",
      400,
      ErrorCode.BAD_REQUEST,
    );
  }

  const passwordHash = await hashPassword(input.password);

  await prisma.$transaction(async (tx) => {
    // Conditional update makes the token single-use under concurrent requests.
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
      throw new AppError(
        "Invalid or expired password reset token",
        400,
        ErrorCode.BAD_REQUEST,
      );
    }

    await tx.user.update({
      where: { id: resetRecord.userId },
      data: { passwordHash },
    });

    // Revoke all existing sessions after a successful password reset.
    await tx.refreshToken.updateMany({
      where: {
        userId: resetRecord.userId,
        revokedAt: null,
      },
      data: { revokedAt: now },
    });

    await writeAuditLog(
      {
        action: "PASSWORD_RESET_COMPLETED",
        resource: "USER",
        resourceId: resetRecord.userId,
        userId: resetRecord.userId,
        description: "Password reset completed; active refresh tokens revoked.",
        ...auditContext,
        metadata: { refreshTokensRevoked: true },
      },
      tx,
    );
  });

  return { message: "Password has been reset successfully. Please log in again." };
};
