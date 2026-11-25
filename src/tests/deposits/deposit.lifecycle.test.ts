import { describe, expect, it } from "vitest";
import { assertDepositStatusTransition, canTransitionDepositStatus } from "../../deposits/services/deposit.lifecycle.service";

describe("deposit status lifecycle", () => {
  it("allows initiation to payment pending and pending to settled", () => {
    expect(canTransitionDepositStatus("INITIATED", "PAYMENT_PENDING")).toBe(true);
    expect(canTransitionDepositStatus("PAYMENT_PENDING", "SETTLED")).toBe(true);
  });
  it("allows a settled deposit to be reversed, but not re-settled from a terminal status", () => {
    expect(canTransitionDepositStatus("SETTLED", "REVERSED")).toBe(true);
    expect(canTransitionDepositStatus("FAILED", "SETTLED")).toBe(false);
  });
  it("rejects invalid transitions", () => {
    expect(() => assertDepositStatusTransition("FAILED", "SETTLED")).toThrow(/Invalid deposit status transition/);
  });
});
