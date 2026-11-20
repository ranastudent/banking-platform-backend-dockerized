import nodemailer from "nodemailer";

import { emailConfig } from "../config/email";

// Mailpit is a local development/test SMTP sink and does not require
// SMTP authentication. Real SMTP providers continue to use configured
// credentials.
const isLocalMailpit =
  ["mailpit", "localhost", "127.0.0.1", "::1"].includes(
    emailConfig.host.trim().toLowerCase(),
  );

const transporter = nodemailer.createTransport({
  host: emailConfig.host,
  port: emailConfig.port,
  secure: emailConfig.port === 465,
  ...(isLocalMailpit
    ? {}
    : {
        auth: {
          user: emailConfig.user,
          pass: emailConfig.password,
        },
      }),
});

export const sendEmail = async ({
  to,
  subject,
  html,
}: {
  to: string;
  subject: string;
  html: string;
}) => {
  await transporter.sendMail({
    from: `"${emailConfig.fromName}" <${emailConfig.from}>`,
    to,
    subject,
    html,
  });
};
