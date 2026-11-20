import "../setup";
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const emailMock = vi.hoisted(() => ({
  sendPasswordResetOtpEmail: vi.fn(),
}));

vi.mock("../../auth/services/password-reset-email.service", () => emailMock);

import app from "../../app";
import { prisma } from "../../config/prisma";
import { hashPassword, comparePassword } from "../../auth/utils/password";
import { generateRefreshToken } from "../../auth/utils/jwt";
import { hashRefreshToken } from "../../auth/utils/refreshTokenHash";

describe("Password reset OTP API", () => {
  const initialPassword = "InitialPassword123!";
  const resetPasswordValue = "UpdatedPassword456!";
  const prefix = "password-reset-integration-";

  beforeEach(async () => {
    emailMock.sendPasswordResetOtpEmail.mockReset();
    emailMock.sendPasswordResetOtpEmail.mockResolvedValue(undefined);

    await prisma.passwordResetOtp.deleteMany({
      where: { user: { email: { startsWith: prefix } } },
    });
    await prisma.passwordResetToken.deleteMany({
      where: { user: { email: { startsWith: prefix } } },
    });
    await prisma.refreshToken.deleteMany({
      where: { user: { email: { startsWith: prefix } } },
    });
    await prisma.user.deleteMany({
      where: { email: { startsWith: prefix } },
    });
  });

  const createActiveUser = async (email: string) =>
    prisma.user.create({
      data: {
        name: "Password Reset Test User",
        email,
        passwordHash: await hashPassword(initialPassword),
        status: "ACTIVE",
        emailVerifiedAt: new Date(),
      },
    });

  it("sends a password-reset OTP to an eligible account without exposing account existence", async () => {
    const email = `${prefix}${Date.now()}@example.com`;
    const user = await createActiveUser(email);

    const response = await request(app)
      .post("/api/v1/auth/reset-password/request")
      .send({ email });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.message).toContain("If an eligible account exists");
    expect(emailMock.sendPasswordResetOtpEmail).toHaveBeenCalledTimes(1);

    const emailCall = emailMock.sendPasswordResetOtpEmail.mock.calls[0];
    if (!emailCall) throw new Error("Expected password reset OTP email");
    const [sentEmail, otp] = emailCall;
    expect(sentEmail).toBe(email);
    expect(otp).toMatch(/^\d{6}$/);

    const stored = await prisma.passwordResetOtp.findFirst({
      where: { userId: user.id },
    });
    expect(stored).not.toBeNull();
    expect(stored?.otpHash).not.toBe(otp);
    expect(stored?.consumedAt).toBeNull();
    expect(stored?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("returns the same generic response for an unknown email", async () => {
    const response = await request(app)
      .post("/api/v1/auth/reset-password/request")
      .send({ email: `${prefix}missing@example.com` });

    expect(response.status).toBe(200);
    expect(response.body.data.message).toContain("If an eligible account exists");
    expect(emailMock.sendPasswordResetOtpEmail).not.toHaveBeenCalled();
  });

  it("requires valid OTP before resetting password, then revokes refresh tokens and prevents token reuse", async () => {
    const email = `${prefix}${Date.now()}@example.com`;
    const user = await createActiveUser(email);

    const refreshToken = generateRefreshToken({
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
    });
    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashRefreshToken(refreshToken),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    await request(app)
      .post("/api/v1/auth/reset-password/request")
      .send({ email });

    const emailCall = emailMock.sendPasswordResetOtpEmail.mock.calls[0];
    if (!emailCall) throw new Error("Expected password reset OTP email");
    const [, otp] = emailCall;

    const invalidOtp = await request(app)
      .post("/api/v1/auth/reset-password/verify-otp")
      .send({ email, otp: "000000" });
    expect(invalidOtp.status).toBe(400);

    const verifyResponse = await request(app)
      .post("/api/v1/auth/reset-password/verify-otp")
      .send({ email, otp });
    expect(verifyResponse.status).toBe(200);
    expect(verifyResponse.body.success).toBe(true);

    const resetToken = verifyResponse.body.data.resetToken as string;
    expect(resetToken).toMatch(/^[a-f0-9]{64}$/);

    const response = await request(app)
      .post("/api/v1/auth/reset-password")
      .send({ token: resetToken, password: resetPasswordValue });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);

    const updatedUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    expect(await comparePassword(resetPasswordValue, updatedUser!.passwordHash)).toBe(true);
    expect(await comparePassword(initialPassword, updatedUser!.passwordHash)).toBe(false);

    const storedRefreshToken = await prisma.refreshToken.findFirst({
      where: { userId: user.id },
    });
    expect(storedRefreshToken?.revokedAt).not.toBeNull();

    const reusedResponse = await request(app)
      .post("/api/v1/auth/reset-password")
      .send({ token: resetToken, password: "AnotherPassword789!" });
    expect(reusedResponse.status).toBe(400);
    expect(reusedResponse.body.error.code).toBe("BAD_REQUEST");

    const reusedOtpResponse = await request(app)
      .post("/api/v1/auth/reset-password/verify-otp")
      .send({ email, otp });
    expect(reusedOtpResponse.status).toBe(400);
  });

  it("removes the legacy forgot-password endpoint", async () => {
    const response = await request(app)
      .post("/api/v1/auth/forgot-password")
      .send({ email: `${prefix}legacy@example.com` });
    expect(response.status).toBe(404);
  });

  it("rejects malformed reset payloads", async () => {
    const response = await request(app)
      .post("/api/v1/auth/reset-password")
      .send({ token: "invalid", password: "short" });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });
});
