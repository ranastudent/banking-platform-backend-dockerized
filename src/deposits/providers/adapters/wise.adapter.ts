import type { PaymentProvider } from "@prisma/client";
import type { DepositProviderAdapter, ProviderPaymentResult } from "../../types/deposit.types";
import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "../../../errors/AppError";
import { ErrorCode } from "../../../errors/errorCodes";

const provider: PaymentProvider = "WISE";
const baseUrl = (process.env.WISE_BASE_URL || "https://api.wise-sandbox.com/2026Q4").replace(/\/+$/, "");
const required = (key: string): string => {
  const value = process.env[key]?.trim();
  if (!value) throw new AppError(`Missing ${key} for Wise integration`, 503, ErrorCode.SERVICE_UNAVAILABLE);
  return value;
};
const token = async (): Promise<string> => {
  // Wise Platform partner access can use OAuth client credentials. Some incoming
  // transfer integrations require a partner/user token supplied by Wise; in that
  // case set WISE_ACCESS_TOKEN and do not use client-credentials automatically.
  const access = process.env.WISE_ACCESS_TOKEN?.trim();
  if (access) return access;
  const clientId = required("WISE_CLIENT_ID");
  const clientSecret = required("WISE_CLIENT_SECRET");
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch(`${baseUrl}/../oauth/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials&scope=transfers",
  });
  if (!response.ok) throw new AppError("Wise OAuth token request failed", 502, ErrorCode.BAD_GATEWAY);
  const data = await response.json() as any;
  if (!data.access_token) throw new AppError("Wise OAuth response missing access token", 502, ErrorCode.BAD_GATEWAY);
  return String(data.access_token);
};
const fetchIncomingTransfer = async (id: string): Promise<any> => {
  const bearer = await token();
  const response = await fetch(`${baseUrl}/incoming-transfers/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" },
  });
  if (!response.ok) throw new AppError(`Wise incoming transfer lookup failed (${response.status})`, 502, ErrorCode.BAD_GATEWAY);
  return response.json();
};

export const wiseAdapter: DepositProviderAdapter = {
  provider,
  createPayment: async (input): Promise<ProviderPaymentResult> => {
    // Incoming-transfer rails are not a checkout session. The customer sends
    // funds to Wise-issued account details and includes the deposit reference.
    // Account details must be supplied through partner onboarding/configuration.
    const instructions = required("WISE_INCOMING_PAYMENT_INSTRUCTIONS");
    return {
      providerPaymentId: `WISE-REFERENCE-${input.depositId}`,
      providerReference: input.merchantReference,
      metadata: { flow: "incoming-transfer", paymentReference: input.merchantReference, instructions },
    };
  },
  verifyPayment: async (incomingTransferId) => {
    const data = await fetchIncomingTransfer(incomingTransferId);
    const status = String(data.status || data.state || "").toLowerCase();
    const amountObject = data.amount ?? data.sourceAmount ?? {};
    const amount = typeof amountObject === "object" ? amountObject.value : amountObject;
    const currency = typeof amountObject === "object" ? amountObject.currency : data.currency;
    const reference = String(data.reference || data.paymentReference || data.customerReference || "");
    return {
      provider,
      providerPaymentId: String(data.id || incomingTransferId),
      merchantReference: reference,
      status: ["credited", "completed", "received", "success"].includes(status) ? "SUCCESS" :
        ["rejected", "failed", "returned"].includes(status) ? "FAILED" : "PROCESSING",
      amount: String(amount ?? "0"),
      currency: String(currency || "").toUpperCase(),
      providerReference: String(data.reference || data.id || incomingTransferId),
    };
  },
  lookupPaymentByMerchantReference: async () => null,
  parseAndVerifyWebhook: async (rawBody, signature, body) => {
    const secret = process.env.WISE_WEBHOOK_SECRET?.trim();
    if (!secret || !signature) throw new AppError("Wise webhook signing secret/signature is not configured", 401, ErrorCode.UNAUTHORIZED);
    const supplied = signature.replace(/^sha256=/i, "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(supplied)) throw new AppError("Invalid Wise webhook signature", 401, ErrorCode.UNAUTHORIZED);
    const expected = createHmac("sha256", secret).update(rawBody).digest();
    const actual = Buffer.from(supplied, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new AppError("Invalid Wise webhook signature", 401, ErrorCode.UNAUTHORIZED);
    }
    const event = body as any;
    const id = String(event?.data?.incoming_transfer_id || event?.data?.incomingTransferId || "");
    if (!id) throw new AppError("Wise event is missing incoming_transfer_id", 400, ErrorCode.BAD_REQUEST);
    const verified = await fetchIncomingTransfer(id);
    const reference = String(verified.reference || verified.paymentReference || verified.customerReference || "");
    return {
      eventId: String(event?.id || `wise-incoming-${id}`),
      eventType: String(event?.event_type || event?.type || "incoming-transfer#credited"),
      providerPaymentId: id,
      merchantReference: reference,
      providerReference: String(verified.reference || id),
    };
  },
};
