import type { Request, Response } from "express";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError } from "../../errors/AppError";
import { ErrorCode } from "../../errors/errorCodes";
import { settleVerifiedDeposit } from "../services/deposit.request.service";
import { normalizeProviderSlug } from "../providers/provider.registry";
import { prepareWithdrawal } from "../../transaction/services/withdrawal.service";
import { completeIdempotencyRecord, clearIdempotencyRecord } from "../../middleware/idempotency.middleware";
import type { AuthUser } from "../../types/auth";

const requireUser = (req: Request): AuthUser => {
  if (!req.user) throw new AppError("Authentication required", 401, ErrorCode.UNAUTHORIZED);
  return req.user;
};

const ensureSimulator = (): void => {
  if (
    process.env.NODE_ENV === "production" ||
    (process.env.PAYMENT_SIMULATOR_ENABLED || "true").toLowerCase() !== "true" ||
    (process.env.PAYMENT_PROVIDER_MODE || "mock").toLowerCase() !== "mock"
  ) {
    throw new AppError("Payment simulator is available only in non-production mock mode", 404, ErrorCode.NOT_FOUND);
  }
};

/**
 * Complete a synthetic incoming payment. This endpoint is local-only and
 * authenticated; it settles through the same ledger path as a verified deposit.
 */
export const completeMockDeposit = async (req: Request, res: Response): Promise<void> => {
  ensureSimulator();
  const user = requireUser(req);
  const provider = normalizeProviderSlug(String(req.params.provider || ""));
  if (!provider || !["BKASH", "NAGAD", "ROCKET", "WISE", "STRIPE"].includes(provider)) {
    throw new AppError("Unsupported mock provider", 400, ErrorCode.BAD_REQUEST);
  }
  const depositId = String(req.params.depositId || "");
  const outcome = String(req.body?.outcome || "success").toLowerCase();
  if (!["success", "failed", "cancelled"].includes(outcome)) {
    throw new AppError("outcome must be success, failed, or cancelled", 400, ErrorCode.BAD_REQUEST);
  }

  const deposit = await prisma.depositRequest.findUnique({
    where: { id: depositId },
    include: { providerPayments: { orderBy: { createdAt: "desc" } }, transaction: true },
  });
  if (!deposit) throw new AppError("Deposit not found", 404, ErrorCode.RESOURCE_NOT_FOUND);
  if (user.role === "CUSTOMER" && deposit.userId !== user.id) {
    throw new AppError("You do not own this deposit", 403, ErrorCode.FORBIDDEN);
  }
  if (deposit.provider !== provider || deposit.kind !== "EXTERNAL") {
    throw new AppError("Provider/deposit type mismatch", 409, ErrorCode.CONFLICT);
  }
  const payment = deposit.providerPayments[0];
  if (!payment || !payment.providerPaymentId.startsWith(`MOCK-${provider}-`)) {
    throw new AppError("This deposit was not created by the mock simulator", 409, ErrorCode.CONFLICT);
  }
  if (deposit.status === "SETTLED") {
    res.status(200).json({ success: true, data: { duplicate: true, credited: false, depositId }, requestId: req.requestId });
    return;
  }
  if (["FAILED", "CANCELLED", "EXPIRED", "REVERSED"].includes(deposit.status)) {
    throw new AppError(`Deposit is already ${deposit.status.toLowerCase()}`, 409, ErrorCode.CONFLICT);
  }

  const status = outcome === "success" ? "SUCCESS" : outcome === "failed" ? "FAILED" : "CANCELLED";
  const eventId = `mock-${provider.toLowerCase()}-${payment.providerPaymentId}-${status.toLowerCase()}`;
  const payloadHash = createHash("sha256").update(`${depositId}:${outcome}`).digest("hex");
  const verified = {
    provider,
    eventId,
    eventType: `mock.${provider.toLowerCase()}.${outcome}`,
    providerPaymentId: payment.providerPaymentId,
    merchantReference: deposit.id,
    status: status as "SUCCESS" | "FAILED" | "CANCELLED",
    amount: payment.amount.toString(),
    currency: payment.currencyCode,
    providerReference: payment.providerReference ?? `MOCK-REF-${deposit.id}`,
  };
  const result = await settleVerifiedDeposit(verified);
  // Keep an auditable event record; settlement itself is idempotent and atomic.
  await prisma.depositWebhookEvent.upsert({
    where: { provider_eventId: { provider, eventId } },
    create: { provider, eventId, eventType: verified.eventType, payloadHash, status: String(result.status), processedAt: new Date() },
    update: { status: String(result.status), processedAt: new Date() },
  });
  res.status(200).json({
    success: true,
    data: {
      ...result,
      simulator: true,
      message: "Virtual transaction only. No real mobile-wallet or card payment occurred.",
    },
    requestId: req.requestId,
  });
};

/**
 * Simulate an outbound payout to a TEST- prefixed provider wallet. Existing
 * withdrawal service performs the account debit and ledger entry atomically.
 */
export const createMockPayout = async (req: Request, res: Response): Promise<void> => {
  ensureSimulator();
  const user = requireUser(req);
  const accountId = String(req.params.accountId || "");
  const provider = normalizeProviderSlug(String(req.body?.provider || ""));
  const recipientWallet = typeof req.body?.recipientWallet === "string" ? req.body.recipientWallet.trim() : "";
  const amount = typeof req.body?.amount === "string" ? req.body.amount.trim() : "";
  const currency = typeof req.body?.currency === "string" ? req.body.currency.trim().toUpperCase() : "";
  if (!provider || !["BKASH", "NAGAD", "ROCKET", "WISE"].includes(provider)) {
    throw new AppError("Unsupported mock payout provider", 400, ErrorCode.BAD_REQUEST);
  }
  if (!/^TEST-[A-Z0-9_-]{4,60}$/.test(recipientWallet)) {
    throw new AppError("Use a synthetic recipient such as TEST-BKASH-USER-001; real wallet numbers are not accepted by the simulator", 400, ErrorCode.BAD_REQUEST);
  }
  if (!/^\d+(\.\d{1,8})?$/.test(amount) || Number(amount) <= 0 || !/^[A-Z]{3}$/.test(currency)) {
    throw new AppError("Valid positive amount and 3-letter currency are required", 400, ErrorCode.BAD_REQUEST);
  }
  const idempotencyKey = req.get("Idempotency-Key")?.trim();
  if (!idempotencyKey) throw new AppError("Idempotency-Key is required", 400, ErrorCode.BAD_REQUEST);

  try {
    const result = await prepareWithdrawal(user, accountId, { amount, currency }, {
      auditContext: {
        requestId: req.requestId,
        ipAddress: req.ip,
        userAgent: req.get("user-agent") ?? undefined,
      },
      transactionMetadata: {
        mockProviderPayout: {
          simulator: true,
          provider,
          recipientWallet,
          mockReference: `MOCK-PAYOUT-${new Prisma.Decimal(amount).toString()}-${Date.now()}`,
          notice: "Synthetic payout. No real provider or money movement.",
        },
      },
    });
    const responseData = {
      simulator: true,
      provider,
      recipientWallet,
      amount: result.amount.toString(),
      currency: result.currency.code,
      mockPayoutReference: `MOCK-PAYOUT-${result.transaction.reference}`,
      withdrawal: result,
      message: "Virtual payout recorded. No real wallet was credited.",
    };
    await completeIdempotencyRecord(res, 200, responseData);
    res.status(200).json({ success: true, data: responseData, requestId: req.requestId });
  } catch (error) {
    await clearIdempotencyRecord(res);
    throw error;
  }
};
