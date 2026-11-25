import { Prisma, type DepositKind, type DepositRequest, type Transaction } from "@prisma/client";
import type { Prisma as PrismaNamespace } from "@prisma/client";
import { randomUUID } from "node:crypto";

type Tx = PrismaNamespace.TransactionClient;

const decimalZero = new Prisma.Decimal(0);

const getOrCreateAccount = async (
  tx: Tx,
  code: string,
  name: string,
  accountType: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE",
  currencyCode: string,
) => tx.generalLedgerAccount.upsert({
  where: { code_currencyCode: { code, currencyCode } },
  create: { code, name, accountType, currencyCode, isSystem: true },
  update: {},
});

export const postBalancedJournal = async (
  tx: Tx,
  input: {
    reference: string;
    transactionId?: string;
    depositRequestId?: string;
    description: string;
    currencyCode: string;
    lines: Array<{ account: { code: string; name: string; type: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE" }; debit: Prisma.Decimal; credit: Prisma.Decimal }>;
  },
) => {
  const totalDebit = input.lines.reduce((sum, line) => sum.add(line.debit), decimalZero);
  const totalCredit = input.lines.reduce((sum, line) => sum.add(line.credit), decimalZero);
  if (input.lines.length < 2 || totalDebit.lte(0) || !totalDebit.equals(totalCredit)) {
    throw new Error("Journal entry is not balanced");
  }

  const entry = await tx.journalEntry.create({
    data: {
      reference: input.reference,
      ...(input.transactionId ? { transactionId: input.transactionId } : {}),
      ...(input.depositRequestId ? { depositRequestId: input.depositRequestId } : {}),
      description: input.description,
      status: "POSTED",
    },
  });

  for (const line of input.lines) {
    const account = await getOrCreateAccount(
      tx, line.account.code, line.account.name, line.account.type, input.currencyCode,
    );
    await tx.journalLine.create({
      data: {
        journalEntryId: entry.id,
        accountId: account.id,
        currencyCode: input.currencyCode,
        debit: line.debit,
        credit: line.credit,
      },
    });

    const debitNormal = line.account.type === "ASSET" || line.account.type === "EXPENSE";
    const movement = debitNormal ? line.debit.sub(line.credit) : line.credit.sub(line.debit);
    await tx.generalLedgerAccount.update({
      where: { id: account.id },
      data: { balance: { increment: movement } },
    });
  }
  return entry;
};

export const postDepositJournal = async (
  tx: Tx,
  deposit: DepositRequest,
  transaction: Transaction,
) => {
  const amount = deposit.amount;
  const fee = deposit.fee;
  const net = deposit.netAmount;
  const debitLine = (code: string, name: string, type: "ASSET" | "EXPENSE", debit: Prisma.Decimal) => ({
    account: { code, name, type }, debit, credit: decimalZero,
  });
  const creditLine = (code: string, name: string, type: "LIABILITY" | "INCOME", credit: Prisma.Decimal) => ({
    account: { code, name, type }, debit: decimalZero, credit,
  });

  if (deposit.kind === "DEMO") {
    return postBalancedJournal(tx, {
      reference: `JRN-${randomUUID()}`,
      transactionId: transaction.id,
      depositRequestId: deposit.id,
      description: `Demo funding ${transaction.reference} (synthetic, not real funds)`,
      currencyCode: deposit.currencyCode,
      lines: [
        debitLine("DEMO_FUNDING_EXPENSE", "Demo Funding Counterpart", "EXPENSE", net),
        creditLine("CUSTOMER_DEPOSIT_LIABILITY", "Customer Deposit Liability", "LIABILITY", net),
      ],
    });
  }

  const lines: Array<{ account: { code: string; name: string; type: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE" }; debit: Prisma.Decimal; credit: Prisma.Decimal }> = [
    debitLine("SETTLEMENT_ASSET", "Provider Settlement Asset", "ASSET", amount),
    creditLine("CUSTOMER_DEPOSIT_LIABILITY", "Customer Deposit Liability", "LIABILITY", net),
  ];
  if (fee.gt(0)) {
    lines.push(creditLine("DEPOSIT_FEE_INCOME", "Deposit Fee Income", "INCOME", fee));
  }
  return postBalancedJournal(tx, {
    reference: `JRN-${randomUUID()}`,
    transactionId: transaction.id,
    depositRequestId: deposit.id,
    description: `External deposit ${transaction.reference}`,
    currencyCode: deposit.currencyCode,
    lines,
  });
};

export const postDepositReversalJournal = async (
  tx: Tx,
  deposit: DepositRequest,
  reversalTransaction: Transaction,
) => {
  const amount = deposit.netAmount;
  return postBalancedJournal(tx, {
    reference: `JRN-${randomUUID()}`,
    transactionId: reversalTransaction.id,
    depositRequestId: deposit.id,
    description: `Reversal of deposit ${deposit.id}`,
    currencyCode: deposit.currencyCode,
    lines: [
      {
        account: { code: "CUSTOMER_DEPOSIT_LIABILITY", name: "Customer Deposit Liability", type: "LIABILITY" },
        debit: amount,
        credit: decimalZero,
      },
      {
        account: {
          code: deposit.kind === "DEMO" ? "DEMO_FUNDING_EXPENSE" : "SETTLEMENT_ASSET",
          name: deposit.kind === "DEMO" ? "Demo Funding Counterpart" : "Provider Settlement Asset",
          type: deposit.kind === "DEMO" ? "EXPENSE" : "ASSET",
        },
        debit: decimalZero,
        credit: amount,
      },
    ],
  });
};
