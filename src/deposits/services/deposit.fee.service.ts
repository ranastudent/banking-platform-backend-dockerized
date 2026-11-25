import { Prisma } from "@prisma/client";
import { depositConfig } from "./deposit.config";
import { AppError } from "../../errors/AppError";
import { ErrorCode } from "../../errors/errorCodes";

export const calculateDepositFee = (
  amount: Prisma.Decimal,
  currencyDecimalPlaces = 8,
): Prisma.Decimal => {
  const rateFee = amount.mul(depositConfig.feeRateBps).div(10000);
  return rateFee.add(depositConfig.fixedFee).toDecimalPlaces(
    currencyDecimalPlaces,
    Prisma.Decimal.ROUND_HALF_UP,
  );
};

export const calculateDepositQuote = (
  amount: Prisma.Decimal,
  currencyDecimalPlaces = 8,
) => {
  const fee = calculateDepositFee(amount, currencyDecimalPlaces);
  const netAmount = amount.sub(fee);
  if (netAmount.lte(0)) throw new AppError("Deposit fee must be less than the deposit amount", 400, ErrorCode.BAD_REQUEST);
  return { amount, fee, netAmount };
};
