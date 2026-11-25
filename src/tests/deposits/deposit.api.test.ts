import "../setup";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import app from "../../app";
import { prisma } from "../../config/prisma";
import {
  getDepositProviderAdapter,
  hasDepositProviderAdapter,
  unregisterDepositProviderAdapter,
  registerDepositProviderAdapter,
} from "../../deposits/providers/provider.registry";
import type { DepositProviderAdapter } from "../../deposits/types/deposit.types";
import {
  cleanupDepositTestData,
  createDepositTestUser,
  createDepositTestAccount,
  createDepositAccessToken,
} from "../account/deposit-test.helpers";

afterEach(async () => {
  await cleanupDepositTestData();
});

describe("Deposit Funds API core", () => {
  it("returns available funding methods and configured limits", async () => {
    const user = await createDepositTestUser();
    const account = await createDepositTestAccount(user.id);
    const token = createDepositAccessToken(user);

    const methods = await request(app)
      .get("/api/v1/deposits/methods")
      .set("Authorization", `Bearer ${token}`);
    expect(methods.status).toBe(200);
    expect(methods.body.data.methods).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "BKASH" }),
      expect.objectContaining({ provider: "NAGAD" }),
      expect.objectContaining({ provider: "ROCKET" }),
    ]));

    const limits = await request(app)
      .get("/api/v1/deposits/limits")
      .set("Authorization", `Bearer ${token}`);
    expect(limits.status).toBe(200);
    expect(limits.body.data.minimum).toBeDefined();
    expect(limits.body.data.daily).toBeDefined();
    expect(account.id).toBeDefined();
  });

  it("quotes an eligible account and rejects another customer's account", async () => {
    const customerA = await createDepositTestUser();
    const customerB = await createDepositTestUser();
    const accountA = await createDepositTestAccount(customerA.id);
    const accountB = await createDepositTestAccount(customerB.id);
    const tokenA = createDepositAccessToken(customerA);

    const quote = await request(app)
      .post("/api/v1/deposits/quote")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ accountId: accountA.id, amount: "500.00", currency: "BDT", provider: "BKASH" });
    expect(quote.status).toBe(200);
    expect(quote.body.data.netAmount).toBe("500");

    const forbidden = await request(app)
      .post("/api/v1/deposits/quote")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ accountId: accountB.id, amount: "500.00", currency: "BDT", provider: "BKASH" });
    expect(forbidden.status).toBe(403);
  });

  it("does not create or credit a deposit when the external provider adapter is unavailable", async () => {
    const user = await createDepositTestUser();
    const account = await createDepositTestAccount(user.id, "1200.00");
    const token = createDepositAccessToken(user);
    const originalAdapter: DepositProviderAdapter | undefined = hasDepositProviderAdapter("BKASH")
      ? getDepositProviderAdapter("BKASH")
      : undefined;

    // This test must cover the unavailable-adapter path even when the suite is
    // running with the development mock provider registered globally.
    unregisterDepositProviderAdapter("BKASH");
    try {
      const response = await request(app)
        .post("/api/v1/deposits")
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", `deposit-adapter-unavailable-${Date.now()}`)
        .send({ accountId: account.id, amount: "300.00", currency: "BDT", provider: "BKASH" });

      expect(response.status).toBe(503);
      const balance = await prisma.accountBalance.findUnique({
        where: { accountId_currencyCode: { accountId: account.id, currencyCode: "BDT" } },
      });
      expect(balance?.availableBalance.toString()).toBe("1200");
      const depositCount = await prisma.depositRequest.count({ where: { accountId: account.id } });
      expect(depositCount).toBe(0);
    } finally {
      if (originalAdapter) registerDepositProviderAdapter(originalAdapter);
    }
  });
});
