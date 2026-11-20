import { describe, expect, it, vi } from "vitest";

const { sendMailMock, createTransportMock } = vi.hoisted(() => {
  const sendMailMock = vi.fn().mockResolvedValue({
    messageId: "unit-test-message-id",
  });

  const createTransportMock = vi.fn((_options: Record<string, unknown>) => ({
    sendMail: sendMailMock,
  }));

  return { sendMailMock, createTransportMock };
});

vi.mock("nodemailer", () => ({
  default: {
    createTransport: createTransportMock,
  },
}));

import { emailConfig } from "../../config/email";
import { sendEmail } from "../../utils/mailer";

describe("Mailer", () => {
  it("creates the SMTP transport from configuration", () => {
    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: expect.any(String),
        port: expect.any(Number),
        secure: expect.any(Boolean),
      }),
    );

    const transportOptions = createTransportMock.mock.calls[0]?.[0];
    const isLocalMailpit = [
      "mailpit",
      "localhost",
      "127.0.0.1",
      "::1",
    ].includes(emailConfig.host.trim().toLowerCase());

    if (isLocalMailpit) {
      expect(transportOptions).not.toHaveProperty("auth");
    } else {
      expect(transportOptions).toHaveProperty("auth", {
        user: emailConfig.user,
        pass: emailConfig.password,
      });
    }
  });

  it("sends an email with the configured sender and supplied content", async () => {
    await expect(
      sendEmail({
        to: "test-recipient@example.invalid",
        subject: "Banking Platform - Mailer Unit Test",
        html: "<h2>Mailer unit test</h2>",
      }),
    ).resolves.toBeUndefined();

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        from: expect.stringContaining("Banking Platform"),
        to: "test-recipient@example.invalid",
        subject: "Banking Platform - Mailer Unit Test",
        html: "<h2>Mailer unit test</h2>",
      }),
    );
  });
});
