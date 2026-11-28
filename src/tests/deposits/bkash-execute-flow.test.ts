import { afterEach, describe, expect, it, vi } from "vitest";
import { bkashAdapter } from "../../deposits/providers/adapters/bkash.adapter";

const envKeys = [
  "BKASH_USERNAME",
  "BKASH_PASSWORD",
  "BKASH_APP_KEY",
  "BKASH_APP_SECRET",
  "BKASH_CALLBACK_URL",
] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("bKash Tokenized Checkout execute flow", () => {
  it("executes an approved initiated payment before returning success", async () => {
    process.env.BKASH_USERNAME = "sandbox-user";
    process.env.BKASH_PASSWORD = "sandbox-password";
    process.env.BKASH_APP_KEY = "sandbox-app-key";
    process.env.BKASH_APP_SECRET = "sandbox-app-secret";
    process.env.BKASH_CALLBACK_URL = "https://merchant.example/api/v1/deposits/bkash/callback";

    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/token/grant")) {
        return new Response(JSON.stringify({ id_token: "test-id-token", expires_in: 3600 }), { status: 200 });
      }
      if (url.endsWith("/payment/status")) {
        return new Response(JSON.stringify({
          paymentID: "test-payment-id",
          transactionStatus: "Initiated",
          merchantInvoiceNumber: "test-deposit-id",
          amount: "100.00",
          currency: "BDT",
        }), { status: 200 });
      }
      if (url.endsWith("/execute")) {
        return new Response(JSON.stringify({
          paymentID: "test-payment-id",
          transactionStatus: "Completed",
          merchantInvoiceNumber: "test-deposit-id",
          trxID: "test-trx-id",
          amount: "100.00",
          currency: "BDT",
        }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await bkashAdapter.verifyPayment("test-payment-id", { execute: true });

    expect(calls.some((call) => call.endsWith("/tokenized/checkout/execute"))).toBe(true);
    expect(result.status).toBe("SUCCESS");
    expect(result.merchantReference).toBe("test-deposit-id");
    expect(result.providerReference).toBe("test-trx-id");
  });

  it("does not execute when callback is not approved", async () => {
    process.env.BKASH_USERNAME = "sandbox-user";
    process.env.BKASH_PASSWORD = "sandbox-password";
    process.env.BKASH_APP_KEY = "sandbox-app-key";
    process.env.BKASH_APP_SECRET = "sandbox-app-secret";

    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/token/grant")) {
        return new Response(JSON.stringify({ id_token: "test-id-token", expires_in: 3600 }), { status: 200 });
      }
      if (url.endsWith("/payment/status")) {
        return new Response(JSON.stringify({
          paymentID: "test-payment-id",
          transactionStatus: "Initiated",
          merchantInvoiceNumber: "test-deposit-id",
          amount: "100.00",
          currency: "BDT",
        }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await bkashAdapter.verifyPayment("test-payment-id", { execute: false });

    expect(calls.some((url) => url.endsWith("/execute"))).toBe(false);
    expect(result.status).toBe("PROCESSING");
  });
});
