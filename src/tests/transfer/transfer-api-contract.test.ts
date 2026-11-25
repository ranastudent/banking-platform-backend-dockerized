import { describe, expect, it } from "vitest";
import { transferSchema } from "../../transaction/schemas/transfer.schema";

describe("POST /api/v1/transfers API contract", () => {
  const validPayload = {
    senderAccount: "1234567890123456",
    receiverAccount: "6543210987654321",
    amount: "125.50",
    currency: "bdt",
  };

  it("accepts customer-facing account numbers for sender and receiver", () => {
    const result = transferSchema.safeParse(validPayload);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.senderAccount).toBe("1234567890123456");
      expect(result.data.receiverAccount).toBe("6543210987654321");
      expect(result.data.currency).toBe("BDT");
    }
  });

  it("rejects an internal database UUID in the sender field", () => {
    const result = transferSchema.safeParse({
      ...validPayload,
      senderAccount: "550e8400-e29b-41d4-a716-446655440000",
    });

    expect(result.success).toBe(false);
  });

  it("rejects an internal database UUID in the receiver field", () => {
    const result = transferSchema.safeParse({
      ...validPayload,
      receiverAccount: "550e8400-e29b-41d4-a716-446655440000",
    });

    expect(result.success).toBe(false);
  });

  it("continues to accept existing non-UUID account-number fixtures", () => {
    const result = transferSchema.safeParse({
      ...validPayload,
      senderAccount: "ACC-1001",
      receiverAccount: "ACC-2002",
    });

    expect(result.success).toBe(true);
  });
});
