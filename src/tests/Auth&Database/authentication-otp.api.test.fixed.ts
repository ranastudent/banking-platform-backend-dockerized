import "../setup";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import crypto from "node:crypto";

import app from "../../app";
import { prisma } from "../../config/prisma";
import { hashPassword } from "../../auth/utils/password";
import * as registrationEmail from "../../auth/services/email.service";
import * as resetEmail from "../../auth/services/password-reset-email.service";

describe("Authentication OTP API contract", () => {
  const emails: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    if (emails.length === 0) return;

    const cleanupEmails = [...emails];
    emails.length = 0;

    await prisma.pendingRegistration.deleteMany({
      where: { email: { in: cleanupEmails } },
    });

    const users = await prisma.user.findMany({
      where: { email: { in: cleanupEmails } },
      select: { id: true },
    });
    const userIds = users.map((user) => user.id);

    if (userIds.length > 0) {
      await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.passwordResetOtp.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.passwordResetToken.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });

      // Email verification creates the user's default account. Remove the
      // account's balance rows and account before deleting the user to avoid
      // accounts_user_id_fkey violations during test cleanup.
      const accounts = await prisma.account.findMany({
        where: { userId: { in: userIds } },
        select: { id: true },
      });
      const accountIds = accounts.map((account) => account.id);
      if (accountIds.length > 0) {
        // Transaction legs reference accounts, so remove them before deleting
        // the test accounts to satisfy transaction_legs_account_id_fkey.
        await prisma.transactionLeg.deleteMany({
          where: { accountId: { in: accountIds } },
        });

        await prisma.accountBalance.deleteMany({
          where: { accountId: { in: accountIds } },
        });

        await prisma.account.deleteMany({
          where: { id: { in: accountIds } },
        });
      }

      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  });

  it("does not create a user until registration OTP verification succeeds", async () => {
    const email = `otp-api-${crypto.randomUUID()}@example.test`;
    emails.push(email);
    let otp = "";

    vi.spyOn(registrationEmail, "sendRegistrationOtpEmail")
      .mockImplementation(async (_recipient, value) => {
        otp = value;
      });

    const register = await request(app)
      .post("/api/v1/auth/register")
      .send({ name: "OTP API User", email, password: "StrongPassword123!" });

    expect(register.status).toBe(201);
    expect(register.body.data.status).toBe("PENDING_VERIFICATION");
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    expect(otp).toMatch(/^\d{6}$/);

    const invalid = await request(app)
      .post("/api/v1/auth/verify-email")
      .send({ email, otp: "000000" });
    expect(invalid.status).toBe(400);
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();

    const verified = await request(app)
      .post("/api/v1/auth/verify-email")
      .send({ email, otp });
    expect(verified.status).toBe(200);
    expect(verified.body.data.status).toBe("ACTIVE");
    expect(await prisma.user.findUnique({ where: { email } })).not.toBeNull();
  });

  it("requires password-reset OTP verification before issuing a reset token", async () => {
    const email = `reset-otp-api-${crypto.randomUUID()}@example.test`;
    emails.push(email);

    await prisma.user.create({
      data: {
        name: "Reset OTP API User",
        email,
        passwordHash: await hashPassword("InitialPassword123!"),
        status: "ACTIVE",
        emailVerifiedAt: new Date(),
      },
    });

    let otp = "";
    vi.spyOn(resetEmail, "sendPasswordResetOtpEmail")
      .mockImplementation(async (_recipient, value) => {
        otp = value;
      });

    const requested = await request(app)
      .post("/api/v1/auth/reset-password/request")
      .send({ email });
    expect(requested.status).toBe(200);
    expect(otp).toMatch(/^\d{6}$/);

    const invalid = await request(app)
      .post("/api/v1/auth/reset-password/verify-otp")
      .send({ email, otp: "000000" });
    expect(invalid.status).toBe(400);

    const verified = await request(app)
      .post("/api/v1/auth/reset-password/verify-otp")
      .send({ email, otp });
    expect(verified.status).toBe(200);
    expect(verified.body.data.resetToken).toMatch(/^[a-f0-9]{64}$/);

    const legacy = await request(app)
      .post("/api/v1/auth/forgot-password")
      .send({ email });
    expect(legacy.status).toBe(404);
  });
});
