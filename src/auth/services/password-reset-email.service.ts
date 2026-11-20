import { sendEmail } from "../../utils/mailer";

export const sendPasswordResetOtpEmail = async (
  email: string,
  otp: string,
): Promise<void> => {
  await sendEmail({
    to: email,
    subject: "Your Banking Platform password reset OTP",
    html: `
      <div>
        <h2>Password reset verification</h2>
        <p>We received a request to reset your Banking Platform password.</p>
        <p>Your password reset OTP is:</p>
        <h1>${otp}</h1>
        <p>This OTP expires in 10 minutes and can only be used once.</p>
        <p>If you did not request this, ignore this email. Your password will remain unchanged.</p>
      </div>
    `,
  });
};
