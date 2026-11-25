import { Prisma, type PaymentProvider } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError } from "../../errors/AppError";
import { ErrorCode } from "../../errors/errorCodes";
import { depositConfig, getDepositPeriodStart } from "./deposit.config";
import { EXTERNAL_DEPOSIT_PROVIDERS } from "../types/deposit.types";

export const validateDepositEligibility = async (input: {
  userId: string;
  role: string;
  accountId: string;
  amount: Prisma.Decimal;
  currency: string;
  provider: PaymentProvider;
}) => {
  if (input.role === "CUSTOMER" && !["ACTIVE"].includes((await prisma.user.findUnique({
    where: { id: input.userId }, select: { status: true },
  }))?.status ?? "")) {
    throw new AppError("Customer is not eligible to deposit", 403, ErrorCode.FORBIDDEN);
  }
  if (input.amount.lt(depositConfig.minimum) || input.amount.gt(depositConfig.maximum)) {
    throw new AppError(
      `Deposit amount must be between ${depositConfig.minimum.toString()} and ${depositConfig.maximum.toString()}`,
      400,
      ErrorCode.TRANSACTION_LIMIT_EXCEEDED,
    );
  }
  if (!EXTERNAL_DEPOSIT_PROVIDERS.includes(input.provider)) {
    throw new AppError("Unsupported external deposit provider", 400, ErrorCode.BAD_REQUEST);
  }
  const account = await prisma.account.findUnique({
    where: { id: input.accountId },
    select: { id: true, userId: true, status: true },
  });
  if (!account) throw new AppError("Account not found", 404, ErrorCode.RESOURCE_NOT_FOUND);
  const accountOwner = await prisma.user.findUnique({
    where: { id: account.userId }, select: { status: true },
  });
  if (accountOwner?.status !== "ACTIVE") {
    throw new AppError("Account owner is not eligible to receive deposits", 403, ErrorCode.FORBIDDEN);
  }
  if (input.role === "CUSTOMER" && account.userId !== input.userId) {
    throw new AppError("You may deposit only into your own account", 403, ErrorCode.FORBIDDEN);
  }
  if (input.role !== "CUSTOMER" && input.role !== "ADMIN") {
    throw new AppError("Not permitted to create deposits", 403, ErrorCode.FORBIDDEN);
  }
  if (account.status !== "ACTIVE") {
    throw new AppError("Deposits require an active account", 409, ErrorCode.CONFLICT);
  }
  const currency = await prisma.currency.findUnique({
    where: { code: input.currency },
    select: { code: true, name: true, symbol: true, decimalPlaces: true, isActive: true },
  });
  if (!currency || !currency.isActive) {
    throw new AppError("Currency is unavailable", 400, ErrorCode.BAD_REQUEST);
  }
  const decimalPlaces = currency.decimalPlaces;
  if (input.amount.decimalPlaces() > decimalPlaces) {
    throw new AppError(`Currency ${currency.code} supports up to ${decimalPlaces} decimal places`, 400, ErrorCode.BAD_REQUEST);
  }

  const now = new Date();
  const startDay = getDepositPeriodStart(now, "day");
  const startMonth = getDepositPeriodStart(now, "month");
  const excluded: Prisma.DepositRequestWhereInput = {
    status: { notIn: ["FAILED", "EXPIRED", "CANCELLED", "REVERSED"] },
  };
  const [daily, monthly] = await Promise.all([
    prisma.depositRequest.aggregate({
      where: { userId: account.userId, currencyCode: input.currency, createdAt: { gte: startDay }, ...excluded },
      _sum: { amount: true },
    }),
    prisma.depositRequest.aggregate({
      where: { userId: account.userId, currencyCode: input.currency, createdAt: { gte: startMonth }, ...excluded },
      _sum: { amount: true },
    }),
  ]);
  const dailyTotal = daily._sum.amount ?? new Prisma.Decimal(0);
  const monthlyTotal = monthly._sum.amount ?? new Prisma.Decimal(0);
  if (dailyTotal.add(input.amount).gt(depositConfig.dailyLimit)) {
    throw new AppError("Daily deposit limit exceeded", 409, ErrorCode.TRANSACTION_LIMIT_EXCEEDED);
  }
  if (monthlyTotal.add(input.amount).gt(depositConfig.monthlyLimit)) {
    throw new AppError("Monthly deposit limit exceeded", 409, ErrorCode.TRANSACTION_LIMIT_EXCEEDED);
  }
  return { account, currency };
};
