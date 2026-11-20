import { z } from "zod";

export const requestPasswordResetOtpSchema = z.object({
  email: z.string().trim().toLowerCase().email("Invalid email address"),
});

export const verifyPasswordResetOtpSchema = z.object({
  email: z.string().trim().toLowerCase().email("Invalid email address"),
  otp: z.string().regex(/^\d{6}$/, "OTP must be a 6-digit number"),
});

export const resetPasswordSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/i, "Invalid or expired password reset token"),
  password: z.string()
    .min(8, "Password must be at least 8 characters")
    .max(128, "Password must not exceed 128 characters"),
});

export type RequestPasswordResetOtpInput = z.infer<typeof requestPasswordResetOtpSchema>;
export type VerifyPasswordResetOtpInput = z.infer<typeof verifyPasswordResetOtpSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
