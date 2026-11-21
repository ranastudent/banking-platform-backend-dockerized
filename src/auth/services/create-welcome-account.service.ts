import { randomInt, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { AuditContext } from "../../audit/audit.types";
import { writeAuditLog } from "../../audit/audit.service";

/** Demo-only virtual balances granted once during new-customer email verification. */
export const VIRTUAL_WELCOME_BALANCES = [
  { currencyCode: "BDT", amount: "100000" },
  { currencyCode: "USD", amount: "2000" },
  { currencyCode: "JPY", amount: "2000000" },
  { currencyCode: "EUR", amount: "1000" },
  { currencyCode: "GBP", amount: "1000" },
] as const;

const generateAccountNumber = (): string =>
  `${randomInt(10_000_000, 100_000_000)}${randomInt(100_000_000, 1_000_000_000)}`;

/**
 * Creates one savings account with five currency balances and auditable
 * virtual-funding transactions. Caller MUST run this in the same DB
 * transaction as creation of the newly verified customer.
 *
 * Existing API endpoints and request/response contracts are unchanged.
 */
export const createWelcomeMultiCurrencyAccount = async (
  tx: Prisma.TransactionClient,
  userId: string,
  auditContext: AuditContext = {},
) => {
  const currencies = await tx.currency.findMany({
    where: {
      code: { in: VIRTUAL_WELCOME_BALANCES.map(({ currencyCode }) => currencyCode) },
      isActive: true,
    },
    select: { code: true },
  });

  const activeCodes = new Set(currencies.map(({ code }) => code));
  const missing = VIRTUAL_WELCOME_BALANCES
    .filter(({ currencyCode }) => !activeCodes.has(currencyCode))
    .map(({ currencyCode }) => currencyCode);

  if (missing.length > 0) {
    throw new Error(`Cannot create virtual welcome account. Active currencies missing: ${missing.join(", ")}`);
  }

  let account;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      account = await tx.account.create({
        data: {
          userId,
          accountNumber: generateAccountNumber(),
          accountType: "SAVINGS",
          status: "ACTIVE",
          balances: {
            create: VIRTUAL_WELCOME_BALANCES.map(({ currencyCode, amount }) => ({
              currencyCode,
              availableBalance: new Prisma.Decimal(amount),
              lockedBalance: new Prisma.Decimal(0),
            })),
          },
        },
        select: { id: true, accountNumber: true },
      });
      break;
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002" || attempt === 4) {
        throw error;
      }
    }
  }

  if (!account) throw new Error("Unable to generate a unique welcome account number");

  for (const { currencyCode, amount } of VIRTUAL_WELCOME_BALANCES) {
    const value = new Prisma.Decimal(amount);
    const transaction = await tx.transaction.create({
      data: {
        reference: `WEL-${randomUUID()}`,
        type: "DEPOSIT",
        status: "COMPLETED",
        amount: value,
        currencyCode,
        provider: "INTERNAL",
        destinationAccountId: account.id,
        metadata: {
          operation: "VIRTUAL_WELCOME_BONUS",
          fundingType: "DEMO_ONLY",
          accountId: account.id,
          userId,
          note: "Non-redeemable demo funds; not real money.",
        },
      },
    });

    await tx.transactionLeg.create({
      data: {
        transactionId: transaction.id,
        accountId: account.id,
        currencyCode,
        entryType: "CREDIT",
        amount: value,
      },
    });

    await tx.ledgerEntry.create({
      data: {
        transactionId: transaction.id,
        accountId: account.id,
        currencyCode,
        entryType: "CREDIT",
        amount: value,
        balanceBefore: new Prisma.Decimal(0),
        balanceAfter: value,
      },
    });
  }

  await writeAuditLog({
    userId,
    action: "VIRTUAL_WELCOME_ACCOUNT_CREATED",
    resource: "ACCOUNT",
    resourceId: account.id,
    description: "Created one multi-currency demo account and granted virtual welcome balances.",
    ...auditContext,
    metadata: {
      accountNumber: account.accountNumber,
      fundingType: "DEMO_ONLY",
      currencies: VIRTUAL_WELCOME_BALANCES,
    },
  }, tx);

  return account;
};
