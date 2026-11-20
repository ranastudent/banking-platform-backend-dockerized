import { prisma } from "../../config/prisma";
import { cacheGroups, cacheService } from "../../services/cache.service";
import { AppError } from "../../errors/AppError";
import { ErrorCode } from "../../errors/errorCodes";
import type { RegisterInput } from "../schemas/auth.schema";
import { hashPassword } from "../utils/password";
import { sendPendingRegistrationOtp } from "./otp.service";

const PENDING_REGISTRATION_TTL_MS = 30 * 60 * 1000;

const isUniqueConstraintError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "P2002";

export const registerUser = async (input: RegisterInput) => {
  const email = input.email.trim().toLowerCase();
  const phone = input.phone?.trim() || null;

  await prisma.pendingRegistration.deleteMany({
    where: { expiresAt: { lte: new Date() } },
  });

  const [existingUser, existingPhoneUser] = await Promise.all([
    prisma.user.findUnique({
      where: { email },
      select: { id: true },
    }),
    phone
      ? prisma.user.findUnique({
          where: { phone },
          select: { id: true },
        })
      : Promise.resolve(null),
  ]);

  if (existingUser) {
    throw new AppError("Email is already registered", 409, ErrorCode.CONFLICT);
  }

  if (existingPhoneUser) {
    throw new AppError("Phone number is already registered", 409, ErrorCode.CONFLICT);
  }

  const passwordHash = await hashPassword(input.password);
  const expiresAt = new Date(Date.now() + PENDING_REGISTRATION_TTL_MS);

  let pendingRegistration: { id: string; email: string; expiresAt: Date };
  try {
    pendingRegistration = await prisma.$transaction(async (tx) => {
      // A new registration attempt for the same unverified email rotates the
      // pending data and OTP. Verified users are never modified here.
      await tx.pendingRegistration.deleteMany({ where: { email } });

      return tx.pendingRegistration.create({
        data: {
          name: input.name.trim(),
          email,
          phone,
          passwordHash,
          expiresAt,
        },
        select: {
          id: true,
          email: true,
          expiresAt: true,
        },
      });
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new AppError(
        "Email or phone number is already registered or pending verification",
        409,
        ErrorCode.CONFLICT,
      );
    }
    throw error;
  }

  await sendPendingRegistrationOtp(pendingRegistration.id, email);

  return {
    email: pendingRegistration.email,
    status: "PENDING_VERIFICATION" as const,
    expiresAt: pendingRegistration.expiresAt,
    message: "Registration OTP sent. Verify your email to complete registration.",
  };
};
