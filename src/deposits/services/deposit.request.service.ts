import { Prisma, type PaymentProvider, type DepositStatus } from "@prisma/client";
import { randomUUID, createHash } from "node:crypto";
import { prisma } from "../../config/prisma";
import { AppError } from "../../errors/AppError";
import { ErrorCode } from "../../errors/errorCodes";
import { writeAuditLog } from "../../audit/audit.service";
import { logger } from "../../observability/logger";
import type { AuthUser } from "../../types/auth";
import { depositConfig, getDepositPeriodStart } from "./deposit.config";
import { calculateDepositQuote } from "./deposit.fee.service";
import { validateDepositEligibility } from "./deposit.validation.service";
import { getDepositProviderAdapter } from "../providers/provider.registry";
import type { CreateDepositInput, DepositQuoteInput, DemoFundingInput } from "../schemas/deposit.schema";
import { postDepositJournal, postDepositReversalJournal } from "./deposit.accounting.service";
import { assertDepositStatusTransition } from "./deposit.lifecycle.service";
import type { VerifiedProviderPayment } from "../types/deposit.types";

const uuid = () => randomUUID();
const normalizeProviderPaymentUrl = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AppError("Provider returned an invalid payment URL", 502, ErrorCode.BAD_GATEWAY);
  }
  if (url.protocol !== "https:") {
    throw new AppError("Provider payment URL must use HTTPS", 502, ErrorCode.BAD_GATEWAY);
  }
  return url.toString();
};
const conflict = (message: string) => new AppError(message, 409, ErrorCode.CONFLICT);

const sanitizeProviderMetadata = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sanitizeProviderMetadata);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (/(secret|token|authorization|credential|api.?key|password|signature)/i.test(key)) continue;
      result[key] = sanitizeProviderMetadata(nested);
    }
    return result;
  }
  return value;
};
const toJson = (value: Record<string, unknown> | undefined): Prisma.InputJsonValue | undefined =>
  value ? JSON.parse(JSON.stringify(sanitizeProviderMetadata(value))) as Prisma.InputJsonValue : undefined;

const enforceDepositLimitsInTransaction = async (
  tx: Prisma.TransactionClient,
  userId: string,
  amount: Prisma.Decimal,
  currencyCode: string,
  demoOnly = false,
): Promise<void> => {
  // Serialize same-customer deposit initiation so concurrent requests cannot
  // both pass the daily/monthly limits using stale aggregate values.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`deposit-limit:${userId}`}))`;
  const now = new Date();
  const startDay = getDepositPeriodStart(now, "day");
  const startMonth = getDepositPeriodStart(now, "month");
  const baseWhere: Prisma.DepositRequestWhereInput = {
    userId,
    currencyCode,
    status: { notIn: ["FAILED", "EXPIRED", "CANCELLED", "REVERSED"] },
    ...(demoOnly ? { kind: "DEMO" } : {}),
  };
  const [daily, monthly] = await Promise.all([
    tx.depositRequest.aggregate({ where: { ...baseWhere, createdAt: { gte: startDay } }, _sum: { amount: true } }),
    tx.depositRequest.aggregate({ where: { ...baseWhere, createdAt: { gte: startMonth } }, _sum: { amount: true } }),
  ]);
  if ((daily._sum.amount ?? new Prisma.Decimal(0)).add(amount).gt(depositConfig.dailyLimit)) {
    throw new AppError("Daily deposit limit exceeded", 409, ErrorCode.TRANSACTION_LIMIT_EXCEEDED);
  }
  if ((monthly._sum.amount ?? new Prisma.Decimal(0)).add(amount).gt(depositConfig.monthlyLimit)) {
    throw new AppError("Monthly deposit limit exceeded", 409, ErrorCode.TRANSACTION_LIMIT_EXCEEDED);
  }
};

export const getDepositQuote = async (user: AuthUser, input: DepositQuoteInput) => {
  const amount = new Prisma.Decimal(input.amount);
  const { account, currency } = await validateDepositEligibility({
    userId: user.id, role: user.role, accountId: input.accountId,
    amount, currency: input.currency, provider: input.provider as PaymentProvider,
  });
  const quote = calculateDepositQuote(amount, currency.decimalPlaces);
  return {
    accountId: account.id,
    currency: currency.code,
    provider: input.provider,
    amount: quote.amount.toString(),
    fee: quote.fee.toString(),
    netAmount: quote.netAmount.toString(),
    limits: {
      minimum: depositConfig.minimum.toString(),
      maximum: depositConfig.maximum.toString(),
      daily: depositConfig.dailyLimit.toString(),
      monthly: depositConfig.monthlyLimit.toString(),
    },
  };
};

export const createExternalDeposit = async (
  user: AuthUser,
  input: CreateDepositInput,
  idempotencyKey: string,
) => {
  if (!depositConfig.enabled) {
    throw new AppError("External deposits are currently disabled", 503, ErrorCode.SERVICE_UNAVAILABLE);
  }
  const provider = input.provider as PaymentProvider;
  const adapter = getDepositProviderAdapter(provider);
  const amount = new Prisma.Decimal(input.amount);
  const { account, currency } = await validateDepositEligibility({
    userId: user.id, role: user.role, accountId: input.accountId,
    amount, currency: input.currency, provider,
  });
  const quote = calculateDepositQuote(amount, currency.decimalPlaces);
  const transactionReference = `DEP-${uuid()}`;

  const created = await prisma.$transaction(async (tx) => {
    await enforceDepositLimitsInTransaction(tx, account.userId, amount, currency.code);
    const lockedAccount = await tx.$queryRaw<Array<{ id: string; user_id: string; status: string }>>`
      SELECT id, user_id, status FROM accounts WHERE id = CAST(${account.id} AS uuid) FOR UPDATE
    `;
    if (!lockedAccount[0] || lockedAccount[0].user_id !== account.userId || lockedAccount[0].status !== "ACTIVE") {
      throw new AppError("Account is no longer eligible for deposit", 409, ErrorCode.CONFLICT);
    }
    const transaction = await tx.transaction.create({
      data: {
        reference: transactionReference,
        type: "EXTERNAL_DEPOSIT",
        status: "PENDING",
        amount,
        currencyCode: currency.code,
        provider,
        idempotencyKey,
        destinationAccountId: account.id,
        metadata: { operation: "EXTERNAL_DEPOSIT", depositKind: "EXTERNAL" },
      },
    });
    const deposit = await tx.depositRequest.create({
      data: {
        userId: account.userId,
        accountId: account.id,
        transactionId: transaction.id,
        provider,
        kind: "EXTERNAL",
        idempotencyKey,
        amount,
        fee: quote.fee,
        netAmount: quote.netAmount,
        currencyCode: currency.code,
        status: "INITIATED",
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      },
    });
    await writeAuditLog({
      userId: user.id,
      action: "DEPOSIT_REQUEST_INITIATED",
      resource: "DEPOSIT_REQUEST",
      resourceId: deposit.id,
      description: `External deposit initiated for ${currency.code}`,
      metadata: { depositId: deposit.id, transactionId: transaction.id, provider, amount: amount.toString(), currency: currency.code },
    }, tx);
    return { deposit, transaction };
  });

  try {
    const payment = await adapter.createPayment({
      depositId: created.deposit.id,
      merchantReference: created.deposit.id,
      amount: amount.toString(),
      fee: quote.fee.toString(),
      netAmount: quote.netAmount.toString(),
      currency: currency.code,
    });
    if (!payment.providerPaymentId || payment.providerPaymentId.length > 200) {
      throw new AppError("Provider returned an invalid payment identifier", 502, ErrorCode.BAD_GATEWAY);
    }
    if (payment.providerReference && payment.providerReference.length > 200) {
      throw new AppError("Provider returned an invalid payment reference", 502, ErrorCode.BAD_GATEWAY);
    }
    if (payment.expiresAt && payment.expiresAt <= new Date()) {
      throw new AppError("Provider returned an expired payment session", 502, ErrorCode.BAD_GATEWAY);
    }
    const paymentUrl = normalizeProviderPaymentUrl(payment.paymentUrl);
    const requestHash = createHash("sha256").update(JSON.stringify({
      depositId: created.deposit.id, provider, amount: amount.toString(), currency: currency.code,
    })).digest("hex");
    const providerMetadata = toJson(payment.metadata);
    await prisma.$transaction(async (tx) => {
      assertDepositStatusTransition(created.deposit.status, "PAYMENT_PENDING");
      await tx.depositRequest.update({
        where: { id: created.deposit.id },
        data: {
          status: "PAYMENT_PENDING",
          providerReference: payment.providerReference ?? payment.providerPaymentId,
          ...(paymentUrl !== undefined ? { paymentUrl } : {}),
          expiresAt: payment.expiresAt ?? created.deposit.expiresAt,
          ...(providerMetadata !== undefined ? { providerMetadata } : {}),
        },
      });
      await tx.depositProviderPayment.create({
        data: {
          depositRequestId: created.deposit.id,
          provider,
          providerPaymentId: payment.providerPaymentId,
          providerReference: payment.providerReference ?? null,
          status: "PENDING",
          amount,
          currencyCode: currency.code,
          requestPayloadHash: requestHash,
          ...(providerMetadata !== undefined ? { responseMetadata: providerMetadata } : {}),
        },
      });
      await tx.externalProviderTransaction.create({
        data: {
          transactionId: created.transaction.id,
          provider,
          providerTransactionId: payment.providerPaymentId,
          externalReference: payment.providerReference ?? created.deposit.id,
          currencyCode: currency.code,
          amount,
          status: "PENDING",
          requestPayloadHash: requestHash,
          ...(providerMetadata !== undefined ? { responseMetadata: providerMetadata } : {}),
        },
      });
      await tx.transaction.update({
        where: { id: created.transaction.id },
        data: { providerTransactionId: payment.providerPaymentId },
      });
    });
    return {
      depositId: created.deposit.id,
      transactionReference: created.transaction.reference,
      provider,
      status: "PAYMENT_PENDING" as const,
      amount: amount.toString(),
      fee: quote.fee.toString(),
      netAmount: quote.netAmount.toString(),
      currency: currency.code,
      paymentUrl: paymentUrl ?? null,
      expiresAt: payment.expiresAt ?? created.deposit.expiresAt,
    };
  } catch {
    // A provider timeout or persistence error may happen after the provider has
    // created a payment. Keep it in PROCESSING for reconciliation; marking it
    // FAILED could invite a second payment and lose a real incoming payment.
    logger.warn("deposit.provider.initiation_uncertain", {
      depositId: created.deposit.id, provider,
    });
    await prisma.$transaction(async (tx) => {
      await tx.depositRequest.updateMany({
        where: { id: created.deposit.id, status: { in: ["INITIATED", "PAYMENT_PENDING"] } },
        data: { status: "PROCESSING" },
      });
      await tx.transaction.updateMany({
        where: { id: created.transaction.id, status: "PENDING" },
        data: { status: "PROCESSING", failureCode: "PROVIDER_INITIATION_UNCERTAIN", failureReason: "Provider initiation requires reconciliation" },
      });
      await writeAuditLog({
        userId: user.id, action: "DEPOSIT_PROVIDER_INITIATION_UNCERTAIN",
        resource: "DEPOSIT_REQUEST", resourceId: created.deposit.id,
        description: "Provider initiation outcome is uncertain; manual/provider reconciliation required",
        metadata: { depositId: created.deposit.id, provider },
        success: false, failureReason: "Provider initiation outcome uncertain",
      }, tx);
    });
    return {
      depositId: created.deposit.id,
      transactionReference: created.transaction.reference,
      provider,
      status: "PROCESSING" as const,
      amount: amount.toString(),
      fee: quote.fee.toString(),
      netAmount: quote.netAmount.toString(),
      currency: currency.code,
      paymentUrl: null,
      expiresAt: created.deposit.expiresAt,
      message: "Provider initiation outcome is uncertain. Do not create a new payment; this request is being reconciled.",
    };
  }
};

export const settleVerifiedDeposit = async (payment: VerifiedProviderPayment) => {
  const depositId = payment.merchantReference;
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT id, status FROM deposit_requests WHERE id = CAST(${depositId} AS uuid) FOR UPDATE
    `;
    if (!locked[0]) throw new AppError("Deposit request not found", 404, ErrorCode.RESOURCE_NOT_FOUND);
    const deposit = await tx.depositRequest.findUnique({
      where: { id: depositId },
      include: { transaction: true },
    });
    if (!deposit || !deposit.transaction) throw new AppError("Deposit request is incomplete", 409, ErrorCode.CONFLICT);
    if (deposit.provider !== payment.provider) throw new AppError("Provider does not match deposit", 400, ErrorCode.BAD_REQUEST);
    if (!new Prisma.Decimal(payment.amount).equals(deposit.amount) || payment.currency.toUpperCase() !== deposit.currencyCode) {
      await tx.depositRequest.update({ where: { id: deposit.id }, data: { status: "PROCESSING" } });
      await tx.depositReconciliationRecord.create({
        data: {
          depositRequestId: deposit.id, provider: deposit.provider, status: "MISMATCHED",
          expectedAmount: deposit.amount, actualAmount: new Prisma.Decimal(payment.amount),
          expectedCurrency: deposit.currencyCode, actualCurrency: payment.currency.toUpperCase(),
          providerReference: payment.providerReference ?? null, notes: "Webhook payment amount/currency mismatch",
        },
      });
      await writeAuditLog({
        userId: deposit.userId, action: "DEPOSIT_PAYMENT_MISMATCH",
        resource: "DEPOSIT_REQUEST", resourceId: deposit.id,
        description: "Provider payment amount or currency mismatch",
        success: false, failureReason: "Payment amount/currency mismatch",
        metadata: { depositId: deposit.id, providerPaymentId: payment.providerPaymentId },
      }, tx);
      return { status: "REVIEW_REQUIRED", depositId: deposit.id, credited: false, mismatch: true };
    }

    const existingProviderPayment = await tx.depositProviderPayment.findFirst({
      where: { provider: deposit.provider, providerPaymentId: payment.providerPaymentId },
    });
    if (!existingProviderPayment) {
      await tx.depositProviderPayment.create({
        data: {
          depositRequestId: deposit.id, provider: deposit.provider,
          providerPaymentId: payment.providerPaymentId,
          providerReference: payment.providerReference ?? null,
          status: payment.status === "SUCCESS" ? "SUCCESS" : payment.status === "FAILED" ? "FAILED" : payment.status === "CANCELLED" ? "CANCELLED" : "PROCESSING",
          amount: deposit.amount, currencyCode: deposit.currencyCode,
        },
      });
    } else if (existingProviderPayment.depositRequestId !== deposit.id) {
      throw conflict("Provider payment is already associated with another deposit");
    }

    if (payment.status === "FAILED" || payment.status === "CANCELLED") {
      assertDepositStatusTransition(deposit.status, payment.status);
      await tx.depositRequest.update({ where: { id: deposit.id }, data: { status: payment.status } });
      await tx.transaction.update({ where: { id: deposit.transaction.id }, data: { status: payment.status } });
      await tx.depositProviderPayment.updateMany({
        where: { provider: deposit.provider, providerPaymentId: payment.providerPaymentId },
        data: { status: payment.status },
      });
      return { status: payment.status, depositId: deposit.id, credited: false };
    }
    if (payment.status === "PROCESSING") {
      assertDepositStatusTransition(deposit.status, "PROCESSING");
      await tx.depositRequest.update({ where: { id: deposit.id }, data: { status: "PROCESSING" } });
      await tx.transaction.update({ where: { id: deposit.transaction.id }, data: { status: "PROCESSING" } });
      return { status: "PROCESSING", depositId: deposit.id, credited: false };
    }
    if (deposit.status === "SETTLED") {
      return { status: "SETTLED", depositId: deposit.id, credited: false, duplicate: true };
    }
    assertDepositStatusTransition(deposit.status, "SETTLED");

    const lockedAccount = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT id, status FROM accounts WHERE id = CAST(${deposit.accountId} AS uuid) FOR UPDATE
    `;
    if (!lockedAccount[0] || lockedAccount[0].status !== "ACTIVE") {
      await tx.depositRequest.update({ where: { id: deposit.id }, data: { status: "PROCESSING" } });
      await tx.transaction.update({ where: { id: deposit.transaction.id }, data: { status: "PROCESSING" } });
      await tx.externalProviderTransaction.updateMany({
        where: { transactionId: deposit.transaction.id },
        data: { status: "SUCCESS", responseMetadata: { webhookEventId: payment.eventId, reviewRequired: true } },
      });
      await tx.depositProviderSettlement.upsert({
        where: { provider_settlementReference: { provider: deposit.provider, settlementReference: payment.providerReference ?? payment.providerPaymentId } },
        create: {
          depositRequestId: deposit.id, provider: deposit.provider,
          settlementReference: payment.providerReference ?? payment.providerPaymentId,
          providerPaymentId: payment.providerPaymentId, amount: deposit.amount,
          currencyCode: deposit.currencyCode, status: "SUCCESS", settledAt: new Date(),
        },
        update: { depositRequestId: deposit.id, status: "SUCCESS", settledAt: new Date() },
      });
      await tx.depositReconciliationRecord.create({
        data: {
          depositRequestId: deposit.id, provider: deposit.provider, status: "REVIEW_REQUIRED",
          expectedAmount: deposit.amount, actualAmount: new Prisma.Decimal(payment.amount),
          expectedCurrency: deposit.currencyCode, actualCurrency: payment.currency.toUpperCase(),
          providerReference: payment.providerReference ?? null,
          notes: "Provider confirmed payment but destination account is not active; manual review required",
        },
      });
      return { status: "REVIEW_REQUIRED", depositId: deposit.id, credited: false };
    }

    const balances = await tx.$queryRaw<Array<{ id: string; available_balance: Prisma.Decimal; locked_balance: Prisma.Decimal }>>`
      SELECT id, available_balance, locked_balance FROM account_balances
      WHERE account_id = CAST(${deposit.accountId} AS uuid) AND currency_code = ${deposit.currencyCode}
      FOR UPDATE
    `;
    let balanceBefore = new Prisma.Decimal(0);
    let balanceAfter = deposit.netAmount;
    let balanceId: string;
    if (balances[0]) {
      balanceId = balances[0].id;
      balanceBefore = new Prisma.Decimal(balances[0].available_balance);
      balanceAfter = balanceBefore.add(deposit.netAmount);
      await tx.accountBalance.update({
        where: { id: balanceId },
        data: { availableBalance: { increment: deposit.netAmount } },
      });
    } else {
      const createdBalance = await tx.accountBalance.create({
        data: { accountId: deposit.accountId, currencyCode: deposit.currencyCode, availableBalance: deposit.netAmount, lockedBalance: 0 },
      });
      balanceId = createdBalance.id;
    }

    await tx.ledgerEntry.create({
      data: {
        transactionId: deposit.transaction.id, accountId: deposit.accountId,
        currencyCode: deposit.currencyCode, entryType: "CREDIT",
        amount: deposit.netAmount, balanceBefore, balanceAfter,
      },
    });
    await tx.transactionLeg.create({
      data: {
        transactionId: deposit.transaction.id, accountId: deposit.accountId,
        currencyCode: deposit.currencyCode, entryType: "CREDIT", amount: deposit.netAmount,
      },
    });

    const settled = await tx.depositRequest.update({
      where: { id: deposit.id },
      data: { status: "SETTLED", paidAt: new Date(), settledAt: new Date(), providerReference: payment.providerReference ?? deposit.providerReference },
    });
    await tx.transaction.update({
      where: { id: deposit.transaction.id },
      data: { status: "COMPLETED", providerTransactionId: payment.providerPaymentId },
    });
    await tx.externalProviderTransaction.upsert({
      where: { transactionId: deposit.transaction.id },
      create: {
        transactionId: deposit.transaction.id, provider: deposit.provider,
        providerTransactionId: payment.providerPaymentId,
        externalReference: payment.providerReference ?? deposit.id,
        currencyCode: deposit.currencyCode, amount: deposit.amount,
        status: "SUCCESS",
        responseMetadata: { webhookEventId: payment.eventId, eventType: payment.eventType },
      },
      update: {
        providerTransactionId: payment.providerPaymentId,
        status: "SUCCESS",
        responseMetadata: { webhookEventId: payment.eventId, eventType: payment.eventType },
      },
    });
    await tx.depositProviderPayment.updateMany({
      where: { provider: deposit.provider, providerPaymentId: payment.providerPaymentId },
      data: { status: "SUCCESS" },
    });
    await postDepositJournal(tx, settled, deposit.transaction);
    await tx.depositProviderSettlement.upsert({
      where: { provider_settlementReference: { provider: deposit.provider, settlementReference: payment.providerReference ?? payment.providerPaymentId } },
      create: {
        depositRequestId: deposit.id, provider: deposit.provider,
        settlementReference: payment.providerReference ?? payment.providerPaymentId,
        providerPaymentId: payment.providerPaymentId, amount: deposit.amount,
        currencyCode: deposit.currencyCode, status: "SUCCESS", settledAt: new Date(),
      },
      update: { depositRequestId: deposit.id, status: "SUCCESS", settledAt: new Date() },
    });
    await tx.depositReconciliationRecord.create({
      data: {
        depositRequestId: deposit.id, provider: deposit.provider,
        status: "MATCHED", expectedAmount: deposit.amount,
        actualAmount: new Prisma.Decimal(payment.amount),
        expectedCurrency: deposit.currencyCode, actualCurrency: payment.currency.toUpperCase(),
        providerReference: payment.providerReference ?? null, notes: "Webhook payment verified and matched",
      },
    });
    await writeAuditLog({
      userId: deposit.userId, action: "DEPOSIT_SETTLED", resource: "DEPOSIT_REQUEST",
      resourceId: deposit.id, description: "External deposit verified and credited",
      metadata: { depositId: deposit.id, transactionId: deposit.transaction.id, amount: deposit.amount.toString(), netAmount: deposit.netAmount.toString(), currency: deposit.currencyCode, provider: deposit.provider },
    }, tx);
    await tx.outboxEvent.create({
      data: {
        eventType: "NOTIFICATION_REQUESTED",
        payload: {
          userId: deposit.userId, notificationType: "DEPOSIT_SUCCESS",
          title: "Deposit completed",
          message: `Your deposit of ${deposit.netAmount.toString()} ${deposit.currencyCode} has been credited. Reference: ${deposit.transaction.reference}.`,
          metadata: { depositId: deposit.id, transactionReference: deposit.transaction.reference, amount: deposit.netAmount.toString(), currency: deposit.currencyCode },
        },
      },
    });
    return { status: "SETTLED", depositId: deposit.id, credited: true, balance: balanceAfter.toString(), balanceId };
  });
};

export const createDemoFunding = async (user: AuthUser, input: DemoFundingInput, idempotencyKey: string) => {
  if (process.env.NODE_ENV === "production" || !depositConfig.demoEnabled) {
    throw new AppError("Demo funding is disabled", 403, ErrorCode.FORBIDDEN);
  }
  const amount = new Prisma.Decimal(input.amount);
  if (amount.lt(depositConfig.minimum) || amount.gt(depositConfig.demoMaximum)) {
    throw new AppError(`Demo funding maximum is ${depositConfig.demoMaximum.toString()}`, 400, ErrorCode.TRANSACTION_LIMIT_EXCEEDED);
  }
  if (user.role !== "CUSTOMER" && user.role !== "ADMIN") throw new AppError("Not permitted", 403, ErrorCode.FORBIDDEN);
  const account = await prisma.account.findUnique({ where: { id: input.accountId } });
  if (!account) throw new AppError("Account not found", 404, ErrorCode.RESOURCE_NOT_FOUND);
  if (user.role === "CUSTOMER" && account.userId !== user.id) throw new AppError("Account ownership mismatch", 403, ErrorCode.FORBIDDEN);
  if (account.status !== "ACTIVE") throw new AppError("Account is not active", 409, ErrorCode.CONFLICT);
  const owner = await prisma.user.findUnique({ where: { id: account.userId }, select: { status: true } });
  if (owner?.status !== "ACTIVE") throw new AppError("Account owner is not eligible for demo funding", 403, ErrorCode.FORBIDDEN);
  const currency = await prisma.currency.findUnique({ where: { code: input.currency }, select: { code: true, isActive: true, decimalPlaces: true } });
  if (!currency?.isActive) throw new AppError("Currency is unavailable", 400, ErrorCode.BAD_REQUEST);
  if (amount.decimalPlaces() > currency.decimalPlaces) throw new AppError("Amount precision exceeds currency decimal places", 400, ErrorCode.BAD_REQUEST);
  const ref = `DEMO-${uuid()}`;
  return prisma.$transaction(async (tx) => {
    const lockedAccount = await tx.$queryRaw<Array<{ id: string; user_id: string; status: string }>>`
      SELECT id, user_id, status FROM accounts WHERE id = CAST(${input.accountId} AS uuid) FOR UPDATE
    `;
    if (!lockedAccount[0]) throw new AppError("Account not found", 404, ErrorCode.RESOURCE_NOT_FOUND);
    if (user.role === "CUSTOMER" && lockedAccount[0].user_id !== user.id) throw new AppError("Account ownership mismatch", 403, ErrorCode.FORBIDDEN);
    if (lockedAccount[0].status !== "ACTIVE") throw new AppError("Account is not active", 409, ErrorCode.CONFLICT);
    await enforceDepositLimitsInTransaction(tx, account.userId, amount, currency.code, true);
    const transaction = await tx.transaction.create({
      data: {
        reference: ref, type: "DEPOSIT", status: "COMPLETED", amount,
        currencyCode: currency.code, provider: "INTERNAL", idempotencyKey,
        destinationAccountId: account.id,
        metadata: { operation: "DEMO_FUNDING", synthetic: true, reason: input.reason ?? null },
      },
    });
    const deposit = await tx.depositRequest.create({
      data: {
        userId: account.userId, accountId: account.id, transactionId: transaction.id,
        provider: "INTERNAL", kind: "DEMO", amount, fee: 0, netAmount: amount,
        currencyCode: currency.code, status: "SETTLED", idempotencyKey,
        paidAt: new Date(), settledAt: new Date(),
      },
    });
    const balanceRow = await tx.$queryRaw<Array<{ id: string; available_balance: Prisma.Decimal }>>`
      SELECT id, available_balance FROM account_balances
      WHERE account_id = CAST(${account.id} AS uuid) AND currency_code = ${currency.code}
      FOR UPDATE
    `;
    const before = balanceRow[0] ? new Prisma.Decimal(balanceRow[0].available_balance) : new Prisma.Decimal(0);
    const after = before.add(amount);
    if (balanceRow[0]) {
      await tx.accountBalance.update({ where: { id: balanceRow[0].id }, data: { availableBalance: { increment: amount } } });
    } else {
      await tx.accountBalance.create({ data: { accountId: account.id, currencyCode: currency.code, availableBalance: amount, lockedBalance: 0 } });
    }
    await tx.ledgerEntry.create({
      data: { transactionId: transaction.id, accountId: account.id, currencyCode: currency.code, entryType: "CREDIT", amount, balanceBefore: before, balanceAfter: after },
    });
    await tx.transactionLeg.create({
      data: { transactionId: transaction.id, accountId: account.id, currencyCode: currency.code, entryType: "CREDIT", amount },
    });
    await postDepositJournal(tx, deposit, transaction);
    await writeAuditLog({
      userId: user.id, action: "DEMO_FUNDING_COMPLETED", resource: "DEPOSIT_REQUEST",
      resourceId: deposit.id, description: "Synthetic demo funding credited",
      metadata: { depositId: deposit.id, transactionId: transaction.id, amount: amount.toString(), currency: currency.code, synthetic: true, reason: input.reason ?? null },
    }, tx);
    await tx.outboxEvent.create({
      data: {
        eventType: "NOTIFICATION_REQUESTED",
        payload: {
          userId: account.userId, notificationType: "DEPOSIT_SUCCESS",
          title: "Demo funding completed",
          message: `Synthetic demo funding of ${amount.toString()} ${currency.code} was added to your test account.`,
          metadata: { depositId: deposit.id, transactionReference: transaction.reference, synthetic: true },
        },
      },
    });
    return { depositId: deposit.id, transactionReference: transaction.reference, amount: amount.toString(), currency: currency.code, status: "SETTLED", synthetic: true, balance: after.toString() };
  });
};

export const getCustomerDeposits = async (user: AuthUser, query: {
  page?: number; limit?: number; status?: DepositStatus; provider?: PaymentProvider;
}) => {
  const page = Math.max(1, query.page ?? 1);
  const limit = Math.min(100, Math.max(1, query.limit ?? 20));
  const where = user.role === "ADMIN" ? {
    ...(query.status ? { status: query.status } : {}),
    ...(query.provider ? { provider: query.provider } : {}),
  } : {
    userId: user.id,
    ...(query.status ? { status: query.status } : {}),
    ...(query.provider ? { provider: query.provider } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.depositRequest.findMany({
      where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit,
      select: {
        id: true, provider: true, kind: true, amount: true, fee: true, netAmount: true,
        currencyCode: true, status: true, providerReference: true, paymentUrl: true,
        expiresAt: true, paidAt: true, settledAt: true, createdAt: true, transactionId: true,
      },
    }),
    prisma.depositRequest.count({ where }),
  ]);
  return { items: items.map((item) => ({
    ...item, amount: item.amount.toString(), fee: item.fee.toString(), netAmount: item.netAmount.toString(),
  })), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
};

export const getDepositDetails = async (user: AuthUser, depositId: string) => {
  const deposit = await prisma.depositRequest.findUnique({
    where: { id: depositId },
    select: {
      id: true, userId: true, accountId: true, transactionId: true, provider: true,
      kind: true, providerReference: true, amount: true, fee: true, netAmount: true,
      currencyCode: true, status: true, paymentUrl: true, expiresAt: true,
      paidAt: true, settledAt: true, reversedAt: true, createdAt: true, updatedAt: true,
      transaction: { select: { reference: true, status: true, createdAt: true } },
      providerPayments: {
        select: {
          provider: true, providerPaymentId: true, providerReference: true,
          status: true, amount: true, currencyCode: true, createdAt: true, updatedAt: true,
        },
      },
      journalEntries: {
        include: {
          lines: {
            include: {
              account: { select: { code: true, name: true, accountType: true } },
            },
          },
        },
      },
      reconciliationRecords: true,
    },
  });
  if (!deposit) throw new AppError("Deposit not found", 404, ErrorCode.RESOURCE_NOT_FOUND);
  if (user.role !== "ADMIN" && deposit.userId !== user.id) throw new AppError("Deposit ownership mismatch", 403, ErrorCode.FORBIDDEN);
  return {
    ...deposit,
    amount: deposit.amount.toString(),
    fee: deposit.fee.toString(),
    netAmount: deposit.netAmount.toString(),
    providerPayments: deposit.providerPayments.map((payment) => ({
      ...payment, amount: payment.amount.toString(),
    })),
  };
};

export const cancelDeposit = async (user: AuthUser, depositId: string, reason?: string) => {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM deposit_requests WHERE id = CAST(${depositId} AS uuid) FOR UPDATE
    `;
    if (!locked[0]) throw new AppError("Deposit not found", 404, ErrorCode.RESOURCE_NOT_FOUND);
    const deposit = await tx.depositRequest.findUnique({ where: { id: depositId } });
    if (!deposit) throw new AppError("Deposit not found", 404, ErrorCode.RESOURCE_NOT_FOUND);
    if (user.role !== "ADMIN" && deposit.userId !== user.id) throw new AppError("Deposit ownership mismatch", 403, ErrorCode.FORBIDDEN);
    if (!["INITIATED", "PAYMENT_PENDING"].includes(deposit.status)) {
      throw conflict("Only unpaid initiated or pending deposits can be cancelled");
    }
    assertDepositStatusTransition(deposit.status, "CANCELLED");
    await tx.depositRequest.update({ where: { id: deposit.id }, data: { status: "CANCELLED" } });
    if (deposit.transactionId) await tx.transaction.update({ where: { id: deposit.transactionId }, data: { status: "CANCELLED" } });
    await writeAuditLog({
      userId: user.id, action: "DEPOSIT_CANCELLED", resource: "DEPOSIT_REQUEST",
      resourceId: deposit.id, description: "Deposit request cancelled",
      metadata: { depositId: deposit.id, reason: reason ?? null },
    }, tx);
    return { id: deposit.id, status: "CANCELLED" as const };
  });
};

export const reverseDeposit = async (adminUser: AuthUser, depositId: string, reason: string) => {
  if (adminUser.role !== "ADMIN") throw new AppError("Admin permission required", 403, ErrorCode.FORBIDDEN);
  if (reason.trim().length < 5) throw new AppError("Reversal reason is required", 400, ErrorCode.BAD_REQUEST);
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM deposit_requests WHERE id = CAST(${depositId} AS uuid) FOR UPDATE
    `;
    if (!locked[0]) throw new AppError("Deposit not found", 404, ErrorCode.RESOURCE_NOT_FOUND);
    const deposit = await tx.depositRequest.findUnique({ where: { id: depositId }, include: { transaction: true } });
    if (!deposit || !deposit.transaction) throw new AppError("Deposit transaction not found", 404, ErrorCode.RESOURCE_NOT_FOUND);
    assertDepositStatusTransition(deposit.status, "REVERSED");
    const rows = await tx.$queryRaw<Array<{ id: string; available_balance: Prisma.Decimal }>>`
      SELECT id, available_balance FROM account_balances
      WHERE account_id = CAST(${deposit.accountId} AS uuid) AND currency_code = ${deposit.currencyCode}
      FOR UPDATE
    `;
    if (!rows[0] || new Prisma.Decimal(rows[0].available_balance).lt(deposit.netAmount)) {
      throw new AppError("Customer has insufficient available balance for reversal", 409, ErrorCode.INSUFFICIENT_BALANCE);
    }
    const before = new Prisma.Decimal(rows[0].available_balance);
    const after = before.sub(deposit.netAmount);
    await tx.accountBalance.update({ where: { id: rows[0].id }, data: { availableBalance: { decrement: deposit.netAmount } } });
    const reversal = await tx.transaction.create({
      data: {
        reference: `REV-${uuid()}`, type: "REFUND", status: "COMPLETED",
        amount: deposit.netAmount, currencyCode: deposit.currencyCode,
        provider: deposit.provider, sourceAccountId: deposit.accountId,
        metadata: { operation: "DEPOSIT_REVERSAL", originalDepositId: deposit.id, reason },
      },
    });
    await tx.ledgerEntry.create({
      data: { transactionId: reversal.id, accountId: deposit.accountId, currencyCode: deposit.currencyCode, entryType: "DEBIT", amount: deposit.netAmount, balanceBefore: before, balanceAfter: after },
    });
    await tx.transactionLeg.create({
      data: { transactionId: reversal.id, accountId: deposit.accountId, currencyCode: deposit.currencyCode, entryType: "DEBIT", amount: deposit.netAmount },
    });
    await postDepositReversalJournal(tx, deposit, reversal);
    await tx.depositRequest.update({ where: { id: deposit.id }, data: { status: "REVERSED", reversedAt: new Date() } });
    await writeAuditLog({
      userId: adminUser.id, action: "DEPOSIT_REVERSED", resource: "DEPOSIT_REQUEST",
      resourceId: deposit.id, description: "Settled deposit reversed by administrator",
      metadata: { depositId: deposit.id, reversalTransactionId: reversal.id, amount: deposit.netAmount.toString(), currency: deposit.currencyCode, reason },
    }, tx);
    return { depositId: deposit.id, reversalTransactionId: reversal.id, status: "REVERSED" as const };
  });
};
