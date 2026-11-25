import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { calculateDepositFee, calculateDepositQuote } from "../../deposits/services/deposit.fee.service";

describe("deposit fee calculation", () => {
  it("returns a non-negative fee", () => {
    expect(calculateDepositFee(new Prisma.Decimal("100.00")).gte(0)).toBe(true);
  });
  it("returns amount, fee and net amount consistently", () => {
    const quote = calculateDepositQuote(new Prisma.Decimal("250"));
    expect(quote.amount.sub(quote.fee).equals(quote.netAmount)).toBe(true);
  });
});
