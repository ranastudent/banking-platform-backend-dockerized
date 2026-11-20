import { prisma } from "../../config/prisma";
import { generateOtp } from "../utils/otp";
import { hashOtp } from "../utils/otpHash";
import { sendRegistrationOtpEmail } from "./email.service";

const OTP_TTL_MS = 10 * 60 * 1000;

export const sendPendingRegistrationOtp = async (
  pendingRegistrationId: string,
  email: string,
): Promise<void> => {
  const otp = generateOtp();
  const otpHash = await hashOtp(otp);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await prisma.pendingRegistrationOtp.create({
    data: {
      pendingRegistrationId,
      otpHash,
      expiresAt,
    },
  });

  await sendRegistrationOtpEmail(email, otp);
};

/**
 * Legacy helper retained for tests and pre-existing inactive accounts.
 * New registrations must use sendPendingRegistrationOtp.
 */
export const sendRegistrationOtp = async (
  userId: string,
  email: string,
): Promise<void> => {
  const otp = generateOtp();
  const otpHash = await hashOtp(otp);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await prisma.emailVerificationOtp.create({
    data: { userId, otpHash, expiresAt },
  });

  await sendRegistrationOtpEmail(email, otp);
};
