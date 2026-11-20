import "../setup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

import app from "../../app";
import { prisma } from "../../config/prisma";
import * as emailService from "../../auth/services/email.service";

describe("Authentication - Registration OTP Integration", () => {
  const createdEmails: string[] = [];
  let registrationOtp = "";

  beforeEach(() => {
    registrationOtp = "";
    vi.spyOn(emailService, "sendRegistrationOtpEmail")
      .mockImplementation(async (_email, otp) => {
        registrationOtp = otp;
      });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (createdEmails.length === 0) return;

    const emails = [...createdEmails];
    createdEmails.length = 0;
    const users = await prisma.user.findMany({
      where: { email: { in: emails } },
      select: { id: true },
    });
    const userIds = users.map((user) => user.id);

    await prisma.pendingRegistration.deleteMany({
      where: { email: { in: emails } },
    });
    if (userIds.length) {
      await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  });

  it("must not create a User until the correct registration OTP is verified", async () => {
    const email = `otp-register-${Date.now()}-${Math.random()}@example.com`;
    createdEmails.push(email);

    const response = await request(app)
      .post("/api/v1/auth/register")
      .send({
        name: "OTP Registration User",
        email,
        password: "StrongPassword123!",
      });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      email,
      status: "PENDING_VERIFICATION",
    });
    expect(response.body.data).not.toHaveProperty("id");
    expect(registrationOtp).toMatch(/^\d{6}$/);

    const pending = await prisma.pendingRegistration.findUnique({
      where: { email },
    });
    expect(pending).not.toBeNull();
    expect(pending?.passwordHash).not.toBe("StrongPassword123!");

    const userBeforeOtp = await prisma.user.findUnique({ where: { email } });
    expect(userBeforeOtp).toBeNull();

    const invalidResponse = await request(app)
      .post("/api/v1/auth/verify-email")
      .send({ email, otp: "000000" });
    expect(invalidResponse.status).toBe(400);

    const userAfterInvalidOtp = await prisma.user.findUnique({ where: { email } });
    expect(userAfterInvalidOtp).toBeNull();

    const validResponse = await request(app)
      .post("/api/v1/auth/verify-email")
      .send({ email, otp: registrationOtp });
    expect(validResponse.status).toBe(200);
    expect(validResponse.body.success).toBe(true);
    expect(validResponse.body.data).toMatchObject({
      email,
      status: "ACTIVE",
    });

    const createdUser = await prisma.user.findUnique({ where: { email } });
    expect(createdUser).not.toBeNull();
    expect(createdUser?.emailVerifiedAt).not.toBeNull();

    const pendingAfterVerification = await prisma.pendingRegistration.findUnique({
      where: { email },
    });
    expect(pendingAfterVerification).toBeNull();
  });
});
