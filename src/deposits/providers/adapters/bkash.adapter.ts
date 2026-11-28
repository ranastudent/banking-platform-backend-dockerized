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
  // Tokenized Checkout v1.2.0-beta Query Payment is a POST operation.
  return api("/payment/status", "POST", { paymentID });
};

const executePayment = async (paymentID: string): Promise<any> => {
  // bKash requires Execute Payment after the payer approves checkout.
  return api("/execute", "POST", { paymentID });
};

const normalizeStatus = (data: any): string =>
  String(data?.transactionStatus || data?.status || "").trim().toLowerCase();

const toVerifiedPayment = (data: any, paymentID: string) => {
  const status = normalizeStatus(data);
  const success = status === "completed" || status === "success";
  return {
    provider,
    providerPaymentId: String(data.paymentID || paymentID),
    merchantReference: String(data.merchantInvoiceNumber || data.payerReference || ""),
    status: success ? "SUCCESS" as const
      : status.includes("cancel") ? "CANCELLED" as const
      : status.includes("fail") || status.includes("reject") ? "FAILED" as const
      : "PROCESSING" as const,
    amount: String(data.amount || "0"),
    currency: String(data.currency || "BDT").toUpperCase(),
    ...(data.trxID ? { providerReference: String(data.trxID) } : {}),
  };
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
  verifyPayment: async (paymentID, options) => {
    // Query first so a repeated callback does not blindly execute an already
    // completed payment. bKash callbacks are customer redirects, not proof of
    // payment; the provider's API response is authoritative.
    const queried = await queryPayment(paymentID);
    const queriedStatus = normalizeStatus(queried);
    if (
      queriedStatus === "completed" || queriedStatus === "success" ||
      queriedStatus.includes("cancel") || queriedStatus.includes("fail") ||
      queriedStatus.includes("reject") || queriedStatus.includes("expire")
    ) {
      return toVerifiedPayment(queried, paymentID);
    }

    // Only the successful customer-return callback explicitly opts into
    // Execute Payment. A cancel/failure callback must never trigger capture.
    if (options?.execute !== true) return toVerifiedPayment(queried, paymentID);

    // Tokenized Checkout flow: create -> payer approval -> execute -> verify.
    // Execute only non-terminal payments. If execute reports an error because
    // another callback already executed it, query again before failing.
    try {
      const executed = await executePayment(paymentID);
      const executedStatus = normalizeStatus(executed);
      if (executedStatus === "completed" || executedStatus === "success") {
        return toVerifiedPayment(executed, paymentID);
      }
    } catch (executeError) {
      const afterExecute = await queryPayment(paymentID).catch(() => null);
      const afterStatus = normalizeStatus(afterExecute);
      if (afterExecute && (afterStatus === "completed" || afterStatus === "success")) {
        return toVerifiedPayment(afterExecute, paymentID);
      }
      throw executeError;
    }

    // Some responses do not include transactionStatus in Execute Payment.
    // Query again and only accept the provider's confirmed result.
    const finalStatus = await queryPayment(paymentID);
    return toVerifiedPayment(finalStatus, paymentID);
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
