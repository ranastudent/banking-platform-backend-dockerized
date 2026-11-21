import { prisma } from "../../config/prisma";
import { writeAuditLog } from "../../audit/audit.service";
import type { AuditContext } from "../../audit/audit.types";
import { cacheGroups, cacheService } from "../../services/cache.service";
import { AppError } from "../../errors/AppError";
import { ErrorCode } from "../../errors/errorCodes";
import type { VerifyEmailInput } from "../schemas/verifyEmail.schema";
import { compareOtp } from "../utils/otpHash";
import { createWelcomeMultiCurrencyAccount } from "./create-welcome-account.service";

const MAX_OTP_ATTEMPTS = 5;

const invalidOtp = (message = "Invalid verification OTP") =>
  new AppError(message, 400, ErrorCode.BAD_REQUEST);

/**
 * New registrations are held outside the users table until OTP verification.
 * The legacy branch below remains only to let accounts created by older
 * application versions complete their existing email verification.
 */
export const verifyEmail = async (input: VerifyEmailInput, auditContext: AuditContext = {}) => {
  const email = input.email.trim().toLowerCase();
  const pending = await prisma.pendingRegistration.findUnique({
    where: { email },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      passwordHash: true,
      expiresAt: true,
    },
  });

  if (pending) {
    const now = new Date();
    if (pending.expiresAt <= now) {
      await prisma.pendingRegistration.delete({ where: { id: pending.id } });
      throw invalidOtp("Registration has expired. Please register again.");
    }

    const otpRecord = await prisma.pendingRegistrationOtp.findFirst({
      where: { pendingRegistrationId: pending.id, verifiedAt: null },
      orderBy: { createdAt: "desc" },
    });

    if (!otpRecord || otpRecord.expiresAt <= now || otpRecord.attempts >= MAX_OTP_ATTEMPTS) {
      throw invalidOtp(
        otpRecord?.attempts && otpRecord.attempts >= MAX_OTP_ATTEMPTS
          ? "Verification OTP has been locked due to too many failed attempts"
          : "Verification OTP is missing or expired",
      );
    }

    const valid = await compareOtp(input.otp, otpRecord.otpHash);
    if (!valid) {
      const updated = await prisma.pendingRegistrationOtp.updateMany({
        where: {
          id: otpRecord.id,
          verifiedAt: null,
          attempts: { lt: MAX_OTP_ATTEMPTS },
          expiresAt: { gt: now },
        },
        data: { attempts: { increment: 1 } },
      });
      if (updated.count !== 1) {
        throw invalidOtp("Verification OTP has been locked or expired");
      }
      throw invalidOtp();
    }

    try {
      const createdUser = await prisma.$transaction(async (tx) => {
        const claimed = await tx.pendingRegistrationOtp.updateMany({
          where: {
            id: otpRecord.id,
            verifiedAt: null,
            attempts: { lt: MAX_OTP_ATTEMPTS },
            expiresAt: { gt: now },
          },
          data: { verifiedAt: now },
        });

        if (claimed.count !== 1) {
          throw invalidOtp("Verification OTP has already been used or expired");
        }

        const user = await tx.user.create({
          data: {
            name: pending.name,
            email: pending.email,
            phone: pending.phone,
            passwordHash: pending.passwordHash,
            status: "ACTIVE",
            emailVerifiedAt: now,
          },
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            role: true,
            status: true,
            emailVerifiedAt: true,
            createdAt: true,
          },
        });

        // New CUSTOMER registrations receive one multi-currency demo account.
        // Account, balances, funding transactions, ledger entries and audit
        // records commit atomically with user creation and OTP consumption.
        if (user.role === "CUSTOMER") {
          await createWelcomeMultiCurrencyAccount(tx, user.id, auditContext);
        }

        await writeAuditLog(
          {
            userId: user.id,
            action: "USER_REGISTERED",
            resource: "USER",
            resourceId: user.id,
            description: "User registered after successful email OTP verification.",
            ...auditContext,
            metadata: { role: user.role, status: user.status },
          },
          tx,
        );

        await tx.pendingRegistration.delete({ where: { id: pending.id } });
        return user;
      });

      await cacheService.invalidateGroup(cacheGroups.adminUsers);
      return createdUser;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "P2002"
      ) {
        throw new AppError(
          "Email or phone number is already registered",
          409,
          ErrorCode.CONFLICT,
        );
      }
      throw error;
    }
  }

  // Backward-compatible verification for inactive users created before this
  // OTP-first registration workflow was deployed.
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, status: true, emailVerifiedAt: true },
  });

  if (!user) {
    throw new AppError("Registration not found or expired", 404, ErrorCode.NOT_FOUND);
  }
  if (user.emailVerifiedAt) {
    throw new AppError("Email is already verified", 409, ErrorCode.CONFLICT);
  }

  const legacyOtp = await prisma.emailVerificationOtp.findFirst({
    where: { userId: user.id, verifiedAt: null },
    orderBy: { createdAt: "desc" },
  });

  if (
    !legacyOtp ||
    legacyOtp.expiresAt <= new Date() ||
    legacyOtp.attempts >= MAX_OTP_ATTEMPTS
  ) {
    throw invalidOtp("Verification OTP is missing, expired, or locked");
  }

  const validLegacyOtp = await compareOtp(input.otp, legacyOtp.otpHash);
  if (!validLegacyOtp) {
    await prisma.emailVerificationOtp.updateMany({
      where: {
        id: legacyOtp.id,
        verifiedAt: null,
        attempts: { lt: MAX_OTP_ATTEMPTS },
      },
      data: { attempts: { increment: 1 } },
    });
    throw invalidOtp();
  }

  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const claimed = await tx.emailVerificationOtp.updateMany({
      where: {
        id: legacyOtp.id,
        verifiedAt: null,
        attempts: { lt: MAX_OTP_ATTEMPTS },
        expiresAt: { gt: now },
      },
      data: { verifiedAt: now },
    });
    if (claimed.count !== 1) throw invalidOtp("Verification OTP has already been used");

    return tx.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: now, status: "ACTIVE" },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        status: true,
        emailVerifiedAt: true,
        createdAt: true,
      },
    });
  });

  return result;
};
