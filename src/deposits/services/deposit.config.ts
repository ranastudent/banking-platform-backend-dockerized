import { Prisma } from "@prisma/client";

const positiveDecimalEnv = (name: string, fallback: string): Prisma.Decimal => {
  const value = process.env[name]?.trim() || fallback;
  if (!/^\d+(\.\d{1,8})?$/.test(value)) throw new Error(`Invalid ${name}`);
  const decimal = new Prisma.Decimal(value);
  if (decimal.lte(0)) throw new Error(`Invalid ${name}`);
  return decimal;
};

const nonNegativeDecimalEnv = (name: string, fallback: string): Prisma.Decimal => {
  const value = process.env[name]?.trim() || fallback;
  if (!/^\d+(\.\d{1,8})?$/.test(value)) throw new Error(`Invalid ${name}`);
  return new Prisma.Decimal(value);
};

const limitTimeZone = process.env.DEPOSIT_LIMIT_TIMEZONE?.trim() || "Asia/Dhaka";
try {
  new Intl.DateTimeFormat("en-US", { timeZone: limitTimeZone }).format();
} catch {
  throw new Error("Invalid DEPOSIT_LIMIT_TIMEZONE");
}

export const depositConfig = {
  limitTimeZone,
  enabled: (process.env.DEPOSIT_EXTERNAL_ENABLED || "false").toLowerCase() === "true",
  demoEnabled: (process.env.DEPOSIT_DEMO_ENABLED || "false").toLowerCase() === "true",
  minimum: positiveDecimalEnv("DEPOSIT_MIN_AMOUNT", "1"),
  maximum: positiveDecimalEnv("DEPOSIT_MAX_AMOUNT", "100000"),
  dailyLimit: positiveDecimalEnv("DEPOSIT_DAILY_LIMIT", "200000"),
  monthlyLimit: positiveDecimalEnv("DEPOSIT_MONTHLY_LIMIT", "1000000"),
  feeRateBps: Number(process.env.DEPOSIT_FEE_RATE_BPS || "0"),
  fixedFee: nonNegativeDecimalEnv("DEPOSIT_FIXED_FEE", "0"),
  demoMaximum: positiveDecimalEnv("DEMO_FUNDING_MAX_AMOUNT", "10000"),
};

if (!Number.isInteger(depositConfig.feeRateBps) || depositConfig.feeRateBps < 0 || depositConfig.feeRateBps > 10000) {
  throw new Error("DEPOSIT_FEE_RATE_BPS must be an integer between 0 and 10000");
}

if (depositConfig.maximum.lt(depositConfig.minimum)) {
  throw new Error("DEPOSIT_MAX_AMOUNT must be greater than or equal to DEPOSIT_MIN_AMOUNT");
}
if (depositConfig.dailyLimit.lt(depositConfig.maximum) || depositConfig.monthlyLimit.lt(depositConfig.dailyLimit)) {
  throw new Error("Deposit limits must satisfy monthly >= daily >= maximum");
}

export const getDepositPeriodStart = (now: Date, period: "day" | "month"): Date => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: depositConfig.limitTimeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(now);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const year = value("year");
  const month = value("month");
  const day = period === "day" ? value("day") : 1;
  const targetUtc = Date.UTC(year, month - 1, day);
  let candidate = targetUtc;
  for (let iteration = 0; iteration < 2; iteration++) {
    const targetParts = formatter.formatToParts(new Date(candidate));
    const get = (type: string) => Number(targetParts.find((part) => part.type === type)?.value);
    const representedUtc = Date.UTC(
      get("year"), get("month") - 1, get("day"),
      get("hour"), get("minute"), get("second"),
    );
    candidate = targetUtc - (representedUtc - candidate);
  }
  return new Date(candidate);
};
