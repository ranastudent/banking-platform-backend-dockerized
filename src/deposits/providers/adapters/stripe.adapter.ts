import type { PaymentProvider } from "@prisma/client";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { DepositProviderAdapter, ProviderPaymentResult } from "../../types/deposit.types";
import { AppError } from "../../../errors/AppError";
import { ErrorCode } from "../../../errors/errorCodes";

const provider: PaymentProvider = "STRIPE";
const apiBase = (process.env.STRIPE_API_BASE_URL || "https://api.stripe.com").replace(/\/+$/, "");
const timeoutMs = Number(process.env.STRIPE_TIMEOUT_MS || 30000);
const required = (key: string): string => {
  const value = process.env[key]?.trim();
  if (!value) throw new AppError(`Missing ${key} for Stripe integration`, 503, ErrorCode.SERVICE_UNAVAILABLE);
  return value;
};

const request = async (path: string, init: RequestInit = {}): Promise<any> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${apiBase}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${required("STRIPE_SECRET_KEY")}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...(init.headers || {}),
      },
    });
    const text = await response.text();
    let data: any;
    try { data = text ? JSON.parse(text) : {}; }
    catch { throw new AppError("Invalid Stripe API response", 502, ErrorCode.BAD_GATEWAY); }
    if (!response.ok) {
      const stripeError = data?.error;
      const message = typeof stripeError?.message === "string"
        ? stripeError.message
        : "Stripe API request failed";

      // Log safe diagnostic fields only. Never log the secret key or request body.
      console.error(JSON.stringify({
        level: "error",
        event: "stripe.api_request_failed",
        path,
        httpStatus: response.status,
        stripeErrorType: typeof stripeError?.type === "string" ? stripeError.type : undefined,
        stripeErrorCode: typeof stripeError?.code === "string" ? stripeError.code : undefined,
        stripeErrorParam: typeof stripeError?.param === "string" ? stripeError.param : undefined,
        stripeRequestId: response.headers.get("request-id") || undefined,
        message,
      }));

      throw new AppError(`${message} (HTTP ${response.status})`, 502, ErrorCode.BAD_GATEWAY);
    }
    return data;
  } catch (error) {
    if (error instanceof AppError) throw error;

    const isTimeout = error instanceof Error && error.name === "AbortError";
    console.error(JSON.stringify({
      level: "error",
      event: isTimeout ? "stripe.api_request_timeout" : "stripe.api_request_unavailable",
      path,
      errorName: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : String(error),
      timeoutMs,
    }));

    throw new AppError(
      isTimeout ? "Stripe API request timed out" : "Stripe API unavailable",
      502,
      ErrorCode.BAD_GATEWAY,
    );
  } finally { clearTimeout(timer); }
};

// Stripe expects the amount in the currency's minor unit. Keep conversion
// decimal-safe; do not use floating-point multiplication for money.
const zeroDecimalCurrencies = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
const threeDecimalCurrencies = new Set(["BHD", "JOD", "KWD", "OMR", "TND"]);
const currencyDigits = (currency: string): number => zeroDecimalCurrencies.has(currency.toUpperCase()) ? 0 :
  threeDecimalCurrencies.has(currency.toUpperCase()) ? 3 : 2;
const toMinorUnits = (amount: string, currency: string): string => {
  const digits = currencyDigits(currency);
  const [whole, fraction = ""] = amount.split(".");
  if (fraction.length > digits) throw new AppError(`Stripe currency ${currency} supports only ${digits} decimal places`, 400, ErrorCode.BAD_REQUEST);
  const minor = BigInt(whole) * (10n ** BigInt(digits)) + BigInt((fraction + "0".repeat(digits)).slice(0, digits) || "0");
  if (minor <= 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new AppError("Payment amount is outside Stripe's supported range", 400, ErrorCode.BAD_REQUEST);
  return minor.toString();
};
const fromMinorUnits = (minor: number, currency: string): string => {
  const digits = currencyDigits(currency);
  const value = BigInt(minor);
  if (digits === 0) return value.toString();
  const base = 10n ** BigInt(digits);
  return `${value / base}.${(value % base).toString().padStart(digits, "0")}`;
};

const retrieveCheckoutSession = async (sessionId: string): Promise<any> => {
  if (!sessionId.startsWith("cs_")) throw new AppError("Invalid Stripe Checkout Session ID", 400, ErrorCode.BAD_REQUEST);
  return request(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
};

/**
 * Prevent a placeholder domain from being sent to Stripe. Stripe redirects the
 * customer exactly to success_url/cancel_url, so an example hostname causes
 * the browser to leave Checkout and land on a non-existent website.
 */
const getCheckoutReturnUrl = (key: "STRIPE_SUCCESS_URL" | "STRIPE_CANCEL_URL"): string => {
  const value = required(key);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AppError(`${key} must be an absolute URL`, 503, ErrorCode.SERVICE_UNAVAILABLE);
  }
  if (parsed.hostname === "your-frontend.example" || parsed.hostname.endsWith(".example")) {
    throw new AppError(
      `${key} still uses an example hostname. Set it to your real frontend URL (for local testing: http://localhost:5173/customer/deposit${key === "STRIPE_SUCCESS_URL" ? "?session_id={CHECKOUT_SESSION_ID}" : "?stripe_cancelled=1"}).`,
      503,
      ErrorCode.SERVICE_UNAVAILABLE,
    );
  }
  if (key === "STRIPE_SUCCESS_URL" && !value.includes("{CHECKOUT_SESSION_ID}")) {
    throw new AppError(
      "STRIPE_SUCCESS_URL must include the literal {CHECKOUT_SESSION_ID} placeholder so the return page can identify the Checkout Session",
      503,
      ErrorCode.SERVICE_UNAVAILABLE,
    );
  }
  return value;
};

export const stripeAdapter: DepositProviderAdapter = {
  provider,
  createPayment: async (input): Promise<ProviderPaymentResult> => {
    const currency = input.currency.toLowerCase();
    const params = new URLSearchParams();
    params.set("mode", "payment");
    params.set("allowed_payment_method_types[0]", "card");
    params.set("success_url", getCheckoutReturnUrl("STRIPE_SUCCESS_URL"));
    params.set("cancel_url", getCheckoutReturnUrl("STRIPE_CANCEL_URL"));
    params.set("client_reference_id", input.merchantReference);
    params.set("metadata[depositId]", input.depositId);
    params.set("metadata[merchantReference]", input.merchantReference);
    params.set("line_items[0][price_data][currency]", currency);
    params.set("line_items[0][price_data][unit_amount]", toMinorUnits(input.amount, input.currency));
    params.set("line_items[0][price_data][product_data][name]", `Banking Platform deposit (${input.currency})`);
    params.set("line_items[0][quantity]", "1");
    const session = await request("/v1/checkout/sessions", { method: "POST", body: params.toString() });
    if (!session.id || !session.url) throw new AppError("Stripe did not return a Checkout Session URL", 502, ErrorCode.BAD_GATEWAY);
    return {
      providerPaymentId: String(session.id),
      providerReference: input.merchantReference,
      paymentUrl: String(session.url),
      ...(session.expires_at ? { expiresAt: new Date(Number(session.expires_at) * 1000) } : {}),
      metadata: { checkoutSessionId: session.id, mode: process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_") ? "test" : "live" },
    };
  },
  verifyPayment: async (sessionId) => {
    const session = await retrieveCheckoutSession(sessionId);
    const currency = String(session.currency || "").toUpperCase();
    const status = session.payment_status === "paid" ? "SUCCESS" :
      session.status === "expired" ? "CANCELLED" : "PROCESSING";
    const merchantReference = String(session.client_reference_id || session.metadata?.merchantReference || session.metadata?.depositId || "");
    if (!merchantReference || typeof session.amount_total !== "number" || !currency) {
      throw new AppError("Stripe Checkout Session is missing payment verification fields", 502, ErrorCode.BAD_GATEWAY);
    }
    return {
      provider,
      providerPaymentId: String(session.id),
      merchantReference,
      status,
      amount: fromMinorUnits(session.amount_total, currency),
      currency,
      ...(session.payment_intent ? { providerReference: String(session.payment_intent) } : {}),
    };
  },
  lookupPaymentByMerchantReference: async () => null,
  parseAndVerifyWebhook: async (rawBody, signature, body) => {
    const secret = required("STRIPE_WEBHOOK_SECRET");
    if (!signature) throw new AppError("Stripe-Signature header is required", 401, ErrorCode.UNAUTHORIZED);
    const parts = signature.split(",").map((part) => part.trim());
    const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2);
    const signatures = parts.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
    if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) {
      throw new AppError("Invalid Stripe webhook signature format", 401, ErrorCode.UNAUTHORIZED);
    }
    // Reject old/replayed signed payloads; Stripe recommends a short tolerance.
    if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) {
      throw new AppError("Stripe webhook timestamp is outside the allowed tolerance", 401, ErrorCode.UNAUTHORIZED);
    }
    const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest();
    const valid = signatures.some((candidate) => {
      if (!/^[a-f0-9]{64}$/i.test(candidate)) return false;
      const actual = Buffer.from(candidate, "hex");
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    });
    if (!valid) throw new AppError("Invalid Stripe webhook signature", 401, ErrorCode.UNAUTHORIZED);

    const event = body as any;
    const object = event?.data?.object;
    const sessionId = String(object?.id || "");
    if (!String(event?.id || "") || !sessionId.startsWith("cs_")) {
      throw new AppError("Stripe webhook is missing event or Checkout Session ID", 400, ErrorCode.BAD_REQUEST);
    }
    return {
      eventId: String(event.id),
      eventType: String(event.type || "stripe.checkout.event"),
      providerPaymentId: sessionId,
      merchantReference: String(object?.client_reference_id || object?.metadata?.merchantReference || object?.metadata?.depositId || ""),
      ...(object?.payment_intent ? { providerReference: String(object.payment_intent) } : {}),
    };
  },
};
