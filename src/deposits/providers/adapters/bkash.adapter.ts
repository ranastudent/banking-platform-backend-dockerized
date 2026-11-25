import type { PaymentProvider } from "@prisma/client";
import type { DepositProviderAdapter, ProviderPaymentResult } from "../../types/deposit.types";
import { AppError } from "../../../errors/AppError";
import { ErrorCode } from "../../../errors/errorCodes";

const provider: PaymentProvider = "BKASH";
const baseUrl = (process.env.BKASH_BASE_URL || "https://tokenized.sandbox.bka.sh/v1.2.0-beta").replace(/\/+$/, "");
const timeoutMs = Number(process.env.BKASH_TIMEOUT_MS || 30000);
let tokenCache: { token: string; expiresAt: number } | undefined;

const required = (key: string): string => {
  const value = process.env[key]?.trim();
  if (!value) throw new AppError(`Missing ${key} for bKash integration`, 503, ErrorCode.SERVICE_UNAVAILABLE);
  return value;
};

const request = async (url: string, init: RequestInit): Promise<any> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let data: any;
    try { data = text ? JSON.parse(text) : {}; } catch { throw new AppError("Invalid bKash API response", 502, ErrorCode.BAD_GATEWAY); }
    if (!response.ok) {
      throw new AppError(`bKash API request failed (${response.status})`, 502, ErrorCode.BAD_GATEWAY);
    }
    if (data?.statusCode && data.statusCode !== "0000") {
      throw new AppError(`bKash rejected the request (${String(data.statusCode)})`, 502, ErrorCode.BAD_GATEWAY);
    }
    return data;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("bKash API unavailable or timed out", 502, ErrorCode.BAD_GATEWAY);
  } finally { clearTimeout(timer); }
};

const getToken = async (): Promise<string> => {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  const username = required("BKASH_USERNAME");
  const password = required("BKASH_PASSWORD");
  const appKey = required("BKASH_APP_KEY");
  const appSecret = required("BKASH_APP_SECRET");
  const data = await request(`${baseUrl}/tokenized/checkout/token/grant`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", username, password, "X-App-Key": appKey },
    body: JSON.stringify({ app_key: appKey, app_secret: appSecret }),
  });
  if (!data.id_token) throw new AppError("bKash did not return an access token", 502, ErrorCode.BAD_GATEWAY);
  tokenCache = { token: String(data.id_token), expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 };
  return tokenCache.token;
};

const api = async (path: string, method: string, body?: unknown): Promise<any> => {
  const token = await getToken();
  return request(`${baseUrl}/tokenized/checkout${path}`, {
    method,
    headers: {
      "Content-Type": "application/json", Accept: "application/json",
      Authorization: token, "X-App-Key": required("BKASH_APP_KEY"),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
};

const queryPayment = async (paymentID: string): Promise<any> => {
  // v1.2.0-beta Query Payment is a POST operation in the merchant API.
  return api("/payment/status", "POST", { paymentID });
};

export const bkashAdapter: DepositProviderAdapter = {
  provider,
  createPayment: async (input): Promise<ProviderPaymentResult> => {
    const callbackURL = required("BKASH_CALLBACK_URL");
    const response = await api("/create", "POST", {
      mode: "0011",
      payerReference: input.merchantReference.slice(0, 50),
      callbackURL,
      amount: input.amount,
      currency: input.currency,
      intent: "sale",
      merchantInvoiceNumber: input.merchantReference.slice(0, 50),
    });
    if (!response.paymentID || !response.bkashURL) throw new AppError("bKash create-payment response is incomplete", 502, ErrorCode.BAD_GATEWAY);
    return {
      providerPaymentId: String(response.paymentID),
      providerReference: input.merchantReference,
      paymentUrl: String(response.bkashURL),
      metadata: { paymentID: response.paymentID, merchantInvoiceNumber: input.merchantReference },
    };
  },
  verifyPayment: async (paymentID) => {
    const data = await queryPayment(paymentID);
    const status = String(data.transactionStatus || data.status || "").toLowerCase();
    const success = status === "completed" || status === "success";
    return {
      provider,
      providerPaymentId: String(data.paymentID || paymentID),
      merchantReference: String(data.merchantInvoiceNumber || data.payerReference || ""),
      status: success ? "SUCCESS" : status.includes("cancel") ? "CANCELLED" : status.includes("fail") ? "FAILED" : "PROCESSING",
      amount: String(data.amount || "0"),
      currency: String(data.currency || "BDT").toUpperCase(),
      ...(data.trxID ? { providerReference: String(data.trxID) } : {}),
    };
  },
  lookupPaymentByMerchantReference: async (merchantReference) => {
    // Search Transaction API requires trxID; query-by-invoice is not guaranteed by the public API.
    // Return null rather than guessing a payment ID.
    void merchantReference;
    return null;
  },
  parseAndVerifyWebhook: async (_rawBody, _signature, body) => {
    const data = body as any;
    const paymentID = String(data?.paymentID || data?.paymentId || "");
    if (!paymentID) throw new AppError("bKash callback is missing paymentID", 400, ErrorCode.BAD_REQUEST);
    const status = String(data?.status || "callback").toLowerCase();
    return {
      eventId: `bkash-callback-${paymentID}-${status}`,
      eventType: `bkash.callback.${status}`,
      providerPaymentId: paymentID,
      merchantReference: String(data?.merchantInvoiceNumber || data?.merchantReference || ""),
    };
  },
};
