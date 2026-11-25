import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { verifyGenericHmac } from "../../deposits/providers/provider.registry";

const original = process.env.DEPOSIT_PROVIDER_BKASH_WEBHOOK_SECRET;
afterEach(() => {
  if (original === undefined) delete process.env.DEPOSIT_PROVIDER_BKASH_WEBHOOK_SECRET;
  else process.env.DEPOSIT_PROVIDER_BKASH_WEBHOOK_SECRET = original;
});

describe("generic provider webhook HMAC", () => {
  it("accepts valid SHA-256 HMAC and rejects invalid signatures", () => {
    process.env.DEPOSIT_PROVIDER_BKASH_WEBHOOK_SECRET = "test-only-secret";
    const raw = '{"eventId":"evt-1"}';
    const signature = createHmac("sha256", "test-only-secret").update(raw).digest("hex");
    expect(verifyGenericHmac("BKASH", raw, signature)).toBe(true);
    expect(verifyGenericHmac("BKASH", raw, "0".repeat(64))).toBe(false);
    expect(verifyGenericHmac("BKASH", raw, undefined)).toBe(false);
  });
});
