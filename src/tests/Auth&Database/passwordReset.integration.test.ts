import "../setup";
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const emailMock = vi.hoisted(() => ({
  sendPasswordResetEmail: vi.fn(),
}));

vi.mock("../../auth/services/password-reset-email.service", () => emailMock);

import app from "../../app";
import { prisma } from "../../config/prisma";
import { hashPassword, comparePassword } from "../../auth/utils/password";
import { generateRefreshToken } from "../../auth/utils/jwt";
import { hashRefreshToken } from "../../auth/utils/refreshTokenHash";

describe("Password reset API", () => {
  const initialPassword = "InitialPassword123!";
  const resetPasswordValue = "UpdatedPassword456!";
  const prefix = "password-reset-integration-";

  beforeEach(async () => {
    emailMock.sendPasswordResetEmail.mockReset();
    emailMock.sendPasswordResetEmail.mockResolvedValue(undefined);

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

  const createActiveUser = async (email: string) => {
    return prisma.user.create({
      data: {
        name: "Password Reset Test User",
        email,
        passwordHash: await hashPassword(initialPassword),
        status: "ACTIVE",
        emailVerifiedAt: new Date(),
      },
    });
  };

  it("returns a generic response and emails a reset token for an eligible account", async () => {
    const email = `${prefix}${Date.now()}@example.com`;
    const user = await createActiveUser(email);

    const response = await request(app)
      .post("/api/v1/auth/forgot-password")
      .send({ email });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.message).toContain("If an eligible account exists");
    expect(emailMock.sendPasswordResetEmail).toHaveBeenCalledTimes(1);

    const emailCall = emailMock.sendPasswordResetEmail.mock.calls[0];
    if (!emailCall) {
      throw new Error("Expected password reset email to be sent");
    }
    const [sentEmail, token] = emailCall;
    expect(sentEmail).toBe(email);
    expect(token).toMatch(/^[a-f0-9]{64}$/);

    const stored = await prisma.passwordResetToken.findFirst({
      where: { userId: user.id },
    });
    expect(stored).not.toBeNull();
    expect(stored?.tokenHash).not.toBe(token);
    expect(stored?.consumedAt).toBeNull();
    expect(stored?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("returns the same generic response for an unknown email", async () => {
    const response = await request(app)
      .post("/api/v1/auth/forgot-password")
      .send({ email: `${prefix}missing@example.com` });

    expect(response.status).toBe(200);
    expect(response.body.data.message).toContain("If an eligible account exists");
    expect(emailMock.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it("resets the password once and revokes existing refresh tokens", async () => {
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
      .post("/api/v1/auth/forgot-password")
      .send({ email });

    const emailCall = emailMock.sendPasswordResetEmail.mock.calls[0];
    if (!emailCall) {
      throw new Error("Expected password reset email to be sent");
    }
    const [, token] = emailCall;

    const response = await request(app)
      .post("/api/v1/auth/reset-password")
      .send({ token, password: resetPasswordValue });

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
      .send({ token, password: "AnotherPassword789!" });

    expect(reusedResponse.status).toBe(400);
    expect(reusedResponse.body.error.code).toBe("BAD_REQUEST");
  });

  it("rejects malformed reset payloads", async () => {
    const response = await request(app)
      .post("/api/v1/auth/reset-password")
      .send({ token: "invalid", password: "short" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });
});
