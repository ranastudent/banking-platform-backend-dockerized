import { sendEmail } from "../../utils/mailer";

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });

export const sendPasswordResetEmail = async (
  email: string,
  token: string,
): Promise<void> => {
  const resetPageUrl = process.env.PASSWORD_RESET_URL?.trim();
  const resetUrl = resetPageUrl
    ? `${resetPageUrl}${resetPageUrl.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`
    : null;
  const safeEmail = escapeHtml(email);

  await sendEmail({
    to: email,
    subject: "Reset your Banking Platform password",
    html: `
      <div>
        <h2>Password reset request</h2>
        <p>A password reset was requested for ${safeEmail}.</p>
        <p>This reset token expires in 15 minutes and can only be used once.</p>
        ${resetUrl
          ? `<p><a href="${escapeHtml(resetUrl)}">Reset your password</a></p>`
          : `<p>Use this reset token in your Banking Platform application:</p><p><code>${token}</code></p><p>Submit it to POST /api/v1/auth/reset-password with your new password.</p>`}
        <p>If you did not request this change, you can ignore this email. Your password will remain unchanged.</p>
      </div>
    `,
  });
};
