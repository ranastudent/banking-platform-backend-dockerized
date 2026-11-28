import type { Request, Response } from "express";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError } from "../../errors/AppError";
import { ErrorCode } from "../../errors/errorCodes";
import { completeIdempotencyRecord, clearIdempotencyRecord } from "../../middleware/idempotency.middleware";
import { depositConfig } from "../services/deposit.config";
import { getDepositQuote, createExternalDeposit, createDemoFunding, getCustomerDeposits, getDepositDetails, cancelDeposit, settleVerifiedDeposit } from "../services/deposit.request.service";
import { EXTERNAL_DEPOSIT_PROVIDERS } from "../types/deposit.types";
import { normalizeProviderSlug, hasDepositProviderAdapter, getDepositProviderAdapter } from "../providers/provider.registry";
import { adminReconcileSchema } from "../schemas/deposit.schema";
import { writeAuditLog } from "../../audit/audit.service";

const requireUser = (req: Request) => {
  if (!req.user) throw new AppError("Authentication required", 401, ErrorCode.UNAUTHORIZED);
  return req.user;
};

export const getDepositMethods = async (req: Request, res: Response): Promise<void> => {
  requireUser(req);
  res.json({
    success: true,
    data: {
      externalEnabled: depositConfig.enabled,
      methods: EXTERNAL_DEPOSIT_PROVIDERS.map((provider) => ({
        provider,
        displayName: provider === "BKASH" ? "bKash" : provider === "NAGAD" ? "Nagad" :
          provider === "ROCKET" ? "Rocket" : provider === "STRIPE" ? "Card (Visa / Mastercard)" :
          provider === "WISE" ? "Wise" : provider,
        category: ["BKASH", "NAGAD", "ROCKET"].includes(provider) ? "MOBILE_WALLET" :
          provider === "STRIPE" ? "CARD" : "INTERNATIONAL_PAYMENT",
        ...(provider === "STRIPE" ? {
          cardNetworks: ["VISA", "MASTERCARD"],
          cardTypes: ["CREDIT", "DEBIT"],
          note: "Card network/type is detected by the payment processor from the entered card; customer should not enter card details in this application."
        } : {}),
        enabled: depositConfig.enabled && hasDepositProviderAdapter(provider),
        status: hasDepositProviderAdapter(provider)
          ? ((process.env.PAYMENT_PROVIDER_MODE || "mock").toLowerCase() === "mock" ? "MOCK_SIMULATOR" : "CONFIGURED")
          : "INTEGRATION_NOT_CONFIGURED",
        mode: (process.env.PAYMENT_PROVIDER_MODE || "mock").toLowerCase(),
        message: hasDepositProviderAdapter(provider)
          ? ((process.env.PAYMENT_PROVIDER_MODE || "mock").toLowerCase() === "mock"
            ? "Virtual simulator enabled. This provider does not move real money."
            : "Provider adapter registered; merchant credentials and provider approval must still be verified.")
          : "Provider-specific adapter and credentials are required before external payments can be enabled.",
      })),
      demoFundingEnabled: depositConfig.demoEnabled && process.env.NODE_ENV !== "production",
    },
    requestId: req.requestId,
  });
};

export const getDepositLimits = async (req: Request, res: Response): Promise<void> => {
  requireUser(req);
  res.json({
    success: true,
    data: {
      minimum: depositConfig.minimum.toString(),
      maximum: depositConfig.maximum.toString(),
      daily: depositConfig.dailyLimit.toString(),
      monthly: depositConfig.monthlyLimit.toString(),
      feeRateBps: depositConfig.feeRateBps,
      fixedFee: depositConfig.fixedFee.toString(),
      currency: "per supported currency",
    },
    requestId: req.requestId,
  });
};

export const quoteDeposit = async (req: Request, res: Response): Promise<void> => {
  const user = requireUser(req);
  const data = await getDepositQuote(user, req.body);
  res.json({ success: true, data, requestId: req.requestId });
};

export const createDeposit = async (req: Request, res: Response): Promise<void> => {
  const user = requireUser(req);
  const key = req.get("Idempotency-Key")?.trim();
  if (!key) throw new AppError("Idempotency-Key is required", 400, ErrorCode.BAD_REQUEST);
  try {
    const data = await createExternalDeposit(user, req.body, key);
    const responseStatus = data.status === "PROCESSING" ? 202 : 201;
    await completeIdempotencyRecord(res, responseStatus, data);
    res.status(responseStatus).json({ success: true, data, requestId: req.requestId });
  } catch (error) {
    await clearIdempotencyRecord(res);
    throw error;
  }
};

export const createDemoDeposit = async (req: Request, res: Response): Promise<void> => {
  const user = requireUser(req);
  const key = req.get("Idempotency-Key")?.trim();
  if (!key) throw new AppError("Idempotency-Key is required", 400, ErrorCode.BAD_REQUEST);
  try {
    const data = await createDemoFunding(user, req.body, key);
    await completeIdempotencyRecord(res, 201, data);
    res.status(201).json({ success: true, data, requestId: req.requestId });
  } catch (error) {
    await clearIdempotencyRecord(res);
    throw error;
  }
};

export const listDeposits = async (req: Request, res: Response): Promise<void> => {
  const user = requireUser(req);
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 20);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new AppError("Invalid pagination", 400, ErrorCode.BAD_REQUEST);
  }
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const provider = typeof req.query.provider === "string" ? req.query.provider.toUpperCase() : undefined;
  const allowedStatuses = ["INITIATED","PAYMENT_PENDING","PROCESSING","CONFIRMED","SETTLED","FAILED","EXPIRED","CANCELLED","REVERSED"];
  const allowedProviders = ["INTERNAL","BKASH","NAGAD","ROCKET","PAYPAL","PAYONEER","WISE","STRIPE"];
  if (status && !allowedStatuses.includes(status)) throw new AppError("Invalid deposit status", 400, ErrorCode.BAD_REQUEST);
  if (provider && !allowedProviders.includes(provider)) throw new AppError("Invalid deposit provider", 400, ErrorCode.BAD_REQUEST);
  const data = await getCustomerDeposits(user, {
    page, limit,
    ...(status ? { status: status as never } : {}),
    ...(provider ? { provider: provider as never } : {}),
  });
  res.json({ success: true, data, requestId: req.requestId });
};

export const getDeposit = async (req: Request, res: Response): Promise<void> => {
  const user = requireUser(req);
  const id = req.params.depositId;
  if (typeof id !== "string") throw new AppError("Deposit ID required", 400, ErrorCode.BAD_REQUEST);
  const data = await getDepositDetails(user, id);
  res.json({ success: true, data, requestId: req.requestId });
};

export const cancelDepositRequest = async (req: Request, res: Response): Promise<void> => {
  const user = requireUser(req);
  const id = req.params.depositId;
  if (typeof id !== "string") throw new AppError("Deposit ID required", 400, ErrorCode.BAD_REQUEST);
  const data = await cancelDeposit(user, id, typeof req.body?.reason === "string" ? req.body.reason : undefined);
  res.json({ success: true, data, requestId: req.requestId });
};

export const receiveDepositWebhook = async (req: Request, res: Response): Promise<void> => {
  const provider = normalizeProviderSlug(String(req.params.provider ?? ""));
  if (!provider) throw new AppError("Unsupported provider", 404, ErrorCode.NOT_FOUND);
  const rawBody = (req as Request & { rawBody?: string }).rawBody;
  if (!rawBody) throw new AppError("Webhook raw body unavailable", 400, ErrorCode.BAD_REQUEST);
  const signature = req.get("stripe-signature") ?? req.get("x-provider-signature") ?? req.get("x-signature") ?? req.get("x-signature-sha256");
  const adapter = getDepositProviderAdapter(provider);

  // Provider-specific adapter validates the signature and maps the provider's
  // callback into a normalized event; callback payload itself never credits.
  const normalized = await adapter.parseAndVerifyWebhook(rawBody, signature, req.body);
  if (
    !normalized.eventId || normalized.eventId.length > 200 ||
    !normalized.providerPaymentId || !normalized.merchantReference
  ) {
    throw new AppError("Provider webhook event is incomplete", 400, ErrorCode.BAD_REQUEST);
  }
  const payloadHash = createHash("sha256").update(rawBody).digest("hex");
  let event;
  try {
    event = await prisma.depositWebhookEvent.create({
      data: {
        provider, eventId: normalized.eventId,
        eventType: normalized.eventType, payloadHash, status: "RECEIVED",
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await prisma.depositWebhookEvent.findUnique({
        where: { provider_eventId: { provider, eventId: normalized.eventId } },
      });
      if (!existing || existing.status !== "FAILED") {
        res.status(200).json({ success: true, data: { duplicate: true }, requestId: req.requestId });
        return;
      }
      event = await prisma.depositWebhookEvent.update({
        where: { id: existing.id },
        data: { status: "RECEIVED", errorMessage: null },
      });
    } else {
      throw error;
    }
  }

  try {
    // Server-to-server payment status verification is mandatory before posting.
    const verified = await adapter.verifyPayment(normalized.providerPaymentId);
    if (
      verified.provider !== provider ||
      verified.providerPaymentId !== normalized.providerPaymentId ||
      verified.merchantReference !== normalized.merchantReference
    ) {
      throw new AppError("Provider payment verification did not match webhook", 409, ErrorCode.CONFLICT);
    }
    const verifiedStatus = provider === "STRIPE" && normalized.eventType === "checkout.session.expired"
      ? "CANCELLED"
      : provider === "STRIPE" && normalized.eventType === "checkout.session.async_payment_failed"
        ? "FAILED"
        : verified.status;
    const data = await settleVerifiedDeposit({
      ...verified,
      status: verifiedStatus,
      provider,
      eventId: normalized.eventId,
      eventType: normalized.eventType,
    });
    await prisma.depositWebhookEvent.update({
      where: { id: event.id },
      data: { status: data.status, processedAt: new Date() },
    });
    res.status(200).json({ success: true, data, requestId: req.requestId });
  } catch (error) {
    await prisma.depositWebhookEvent.update({
      where: { id: event.id },
      data: { status: "FAILED", errorMessage: error instanceof Error ? error.message.slice(0, 500) : "Webhook processing failed" },
    }).catch(() => undefined);
    await writeAuditLog({
      action: "DEPOSIT_WEBHOOK_FAILED", resource: "DEPOSIT_WEBHOOK_EVENT",
      resourceId: event.id, description: "Provider deposit webhook processing failed",
      success: false, failureReason: "Webhook processing failed",
      metadata: { provider, eventId: normalized.eventId, payloadHash },
    }).catch(() => undefined);
    throw error;
  }
};


/**
 * bKash returns the customer to this GET callback with paymentID/status.
 * The callback parameters are not trusted: the backend queries bKash before
 * settling or crediting any deposit.
 */
export const receiveBkashCallback = async (req: Request, res: Response): Promise<void> => {
  const paymentID = typeof req.query.paymentID === "string" ? req.query.paymentID : "";
  if (!paymentID) throw new AppError("bKash callback is missing paymentID", 400, ErrorCode.BAD_REQUEST);
  const callbackStatus = typeof req.query.status === "string" ? req.query.status.toLowerCase() : "";
  const adapter = getDepositProviderAdapter("BKASH");
  // The callback status is not proof of payment; it only controls whether we
  // attempt the required execute step. Provider API verification still follows.
  const verified = await adapter.verifyPayment(paymentID, { execute: callbackStatus === "success" });
  if (verified.provider !== "BKASH" || verified.providerPaymentId !== paymentID || !verified.merchantReference) {
    throw new AppError("bKash payment could not be verified", 409, ErrorCode.CONFLICT);
  }
  const eventId = `bkash-callback-${paymentID}`;
  try {
    await prisma.depositWebhookEvent.create({
      data: {
        provider: "BKASH", eventId, eventType: "checkout.callback",
        payloadHash: createHash("sha256").update(JSON.stringify(req.query)).digest("hex"),
        status: "RECEIVED",
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      res.status(200).json({ success: true, data: { duplicate: true, paymentID }, requestId: req.requestId });
      return;
    }
    throw error;
  }
  const data = await settleVerifiedDeposit({
    ...verified, provider: "BKASH", eventId, eventType: "checkout.callback",
  });
  await prisma.depositWebhookEvent.update({
    where: { provider_eventId: { provider: "BKASH", eventId } },
    data: { status: data.status, processedAt: new Date() },
  });
  res.status(200).json({ success: true, data, requestId: req.requestId });
};
