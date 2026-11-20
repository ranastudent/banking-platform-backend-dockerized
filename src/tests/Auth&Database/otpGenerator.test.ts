import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";

import { prisma } from "../../config/prisma";
import { sendRegistrationOtp } from "../../auth/services/otp.service";
import { hashPassword } from "../../auth/utils/password";

describe("OTP Send Service", () => {
  let createdUserId: string | undefined;

  afterEach(async () => {
    if (!createdUserId) return;

    await prisma.emailVerificationOtp.deleteMany({
      where: { userId: createdUserId },
    });
    await prisma.user.deleteMany({
      where: { id: createdUserId },
    });
    createdUserId = undefined;
  });

  it("should generate, hash, store, and send a registration OTP", async () => {
    const email = `otp-service-${crypto.randomUUID()}@example.test`;
    const passwordHash = await hashPassword("StrongPassword123!");

    const user = await prisma.user.create({
      data: {
        name: "OTP Test User",
        email,
        passwordHash,
        status: "INACTIVE",
        emailVerifiedAt: null,
      },
    });
    createdUserId = user.id;

    await expect(sendRegistrationOtp(user.id, user.email)).resolves.not.toThrow();

    const otpRecord = await prisma.emailVerificationOtp.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
    });

    expect(otpRecord).not.toBeNull();
    expect(otpRecord?.otpHash).toBeDefined();
    expect(otpRecord?.otpHash).not.toMatch(/^\d{6}$/);
    expect(otpRecord?.attempts).toBe(0);
    expect(otpRecord?.verifiedAt).toBeNull();
    expect(otpRecord?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  }, 15000);
});
