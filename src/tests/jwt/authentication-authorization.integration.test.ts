import "../setup";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";

import app from "../../app";
import { prisma } from "../../config/prisma";
import { hashPassword } from "../../auth/utils/password";

describe("Authentication + Authorization Full Integration", () => {
  const userPassword = "StrongPassword123!";
  const createdUserIds: string[] = [];

  const createTestEmail = (label: string) =>
    `${label}.${crypto.randomUUID()}@example.com`;

  const createActiveUser = async (email: string, name: string, role: "ADMIN" | "CUSTOMER" = "CUSTOMER") => {
    const user = await prisma.user.create({
      data: {
        name,
        email,
        passwordHash: await hashPassword(userPassword),
        role,
        status: "ACTIVE",
        emailVerifiedAt: new Date(),
      },
    });
    createdUserIds.push(user.id);
    return user;
  };

  afterEach(async () => {
    if (createdUserIds.length === 0) return;
    const userIds = [...createdUserIds];
    createdUserIds.length = 0;

    await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.emailVerificationOtp.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.passwordResetOtp.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.passwordResetToken.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });

  it("should allow a real ADMIN user to login and access the ADMIN route", async () => {
    const email = createTestEmail("admin.integration");
    const user = await createActiveUser(email, "Admin User", "ADMIN");

    const loginResponse = await request(app).post("/api/v1/auth/login").send({
      email,
      password: userPassword,
    });
    expect(loginResponse.status).toBe(200);
    expect(loginResponse.body.data.accessToken).toEqual(expect.any(String));

    const protectedResponse = await request(app)
      .get("/api/v1/admin/test")
      .set("Authorization", `Bearer ${loginResponse.body.data.accessToken}`);

    expect(protectedResponse.status).toBe(200);
    expect(protectedResponse.body.success).toBe(true);
    expect(protectedResponse.body.data.user.role).toBe("ADMIN");
    expect(user.role).toBe("ADMIN");
  });

  it("should allow a real CUSTOMER user to login but reject the ADMIN route", async () => {
    const email = createTestEmail("customer.integration");
    await createActiveUser(email, "Customer User", "CUSTOMER");

    const loginResponse = await request(app).post("/api/v1/auth/login").send({
      email,
      password: userPassword,
    });
    expect(loginResponse.status).toBe(200);

    const protectedResponse = await request(app)
      .get("/api/v1/admin/test")
      .set("Authorization", `Bearer ${loginResponse.body.data.accessToken}`);

    expect(protectedResponse.status).toBe(403);
    expect(protectedResponse.body.success).toBe(false);
    expect(protectedResponse.body.error.code).toBe("FORBIDDEN");
  });

  it("should reject access when no authentication is provided", async () => {
    const response = await request(app).get("/api/v1/admin/test");
    expect(response.status).toBe(401);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("should preserve the authenticated user's identity through the full flow", async () => {
    const email = createTestEmail("identity.admin");
    const user = await createActiveUser(email, "Identity Admin", "ADMIN");

    const loginResponse = await request(app).post("/api/v1/auth/login").send({
      email: user.email,
      password: userPassword,
    });
    expect(loginResponse.status).toBe(200);

    const protectedResponse = await request(app)
      .get("/api/v1/admin/test")
      .set("Authorization", `Bearer ${loginResponse.body.data.accessToken}`);

    expect(protectedResponse.status).toBe(200);
    expect(protectedResponse.body.data.user).toEqual({
      id: user.id,
      email: user.email,
      role: "ADMIN",
      status: "ACTIVE",
    });
  });

  it("should not allow client-supplied identity to override JWT identity", async () => {
    const email = createTestEmail("identity-protection");
    const user = await createActiveUser(email, "Identity Protection User", "ADMIN");

    const loginResponse = await request(app).post("/api/v1/auth/login").send({
      email: user.email,
      password: userPassword,
    });
    expect(loginResponse.status).toBe(200);

    const attackerId = crypto.randomUUID();
    const protectedResponse = await request(app)
      .get("/api/v1/admin/test")
      .set("Authorization", `Bearer ${loginResponse.body.data.accessToken}`)
      .query({ userId: attackerId, role: "CUSTOMER" });

    expect(protectedResponse.status).toBe(200);
    expect(protectedResponse.body.data.user).toEqual({
      id: user.id,
      email: user.email,
      role: "ADMIN",
      status: "ACTIVE",
    });
    expect(protectedResponse.body.data.user.id).not.toBe(attackerId);
  });

  it("should include requestId throughout the full authentication and authorization flow", async () => {
    const email = createTestEmail("requestid.admin");
    const user = await createActiveUser(email, "Request ID Admin", "ADMIN");

    const loginResponse = await request(app).post("/api/v1/auth/login").send({
      email: user.email,
      password: userPassword,
    });
    expect(loginResponse.status).toBe(200);

    const protectedResponse = await request(app)
      .get("/api/v1/admin/test")
      .set("Authorization", `Bearer ${loginResponse.body.data.accessToken}`);

    expect(protectedResponse.status).toBe(200);
    expect(protectedResponse.body.requestId).toEqual(expect.any(String));
  });
});
