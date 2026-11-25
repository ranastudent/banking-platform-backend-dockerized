import type { DepositStatus } from "@prisma/client";
import { AppError } from "../../errors/AppError";
import { ErrorCode } from "../../errors/errorCodes";

const transitions: Record<DepositStatus, readonly DepositStatus[]> = {
  INITIATED: ["PAYMENT_PENDING", "PROCESSING", "SETTLED", "FAILED", "EXPIRED", "CANCELLED"],
  PAYMENT_PENDING: ["PROCESSING", "CONFIRMED", "SETTLED", "FAILED", "EXPIRED", "CANCELLED"],
  PROCESSING: ["CONFIRMED", "SETTLED", "FAILED", "CANCELLED", "REVERSED"],
  CONFIRMED: ["SETTLED", "FAILED", "REVERSED"],
  SETTLED: ["REVERSED"],
  FAILED: [],
  EXPIRED: [],
  CANCELLED: [],
  REVERSED: [],
};

export const canTransitionDepositStatus = (from: DepositStatus, to: DepositStatus): boolean =>
  from === to || transitions[from].includes(to);

export const assertDepositStatusTransition = (from: DepositStatus, to: DepositStatus): void => {
  if (!canTransitionDepositStatus(from, to)) {
    throw new AppError(`Invalid deposit status transition: ${from} -> ${to}`, 409, ErrorCode.CONFLICT);
  }
};
