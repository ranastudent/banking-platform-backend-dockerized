import { Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { logger } from "../../observability/logger";
import { getDepositProviderAdapter } from "../providers/provider.registry";
import { settleVerifiedDeposit } from "./deposit.request.service";

/**
 * Internal reconciliation sweep. It expires stale unpaid requests and matches
 * persisted provider settlement records to deposit/provider payment records.
 * It never credits customer balances; settlement crediting is handled only by
 * the verified payment finalization transaction.
 */
export const runDepositReconciliation = async (): Promise<{
  expiredRequests: number;
  matchedSettlements: number;
  unmatchedSettlements: number;
  reviewRequired: number;
}> => {
  const now = new Date();
  const expired = await prisma.depositRequest.findMany({
    where: {
      status: { in: ["INITIATED", "PAYMENT_PENDING"] },
      expiresAt: { lte: now },
    },
    select: { id: true, transactionId: true },
    take: 500,
  });
  let expiredRequests = 0;
  for (const item of expired) {
    await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT id, status FROM deposit_requests WHERE id = CAST(${item.id} AS uuid) FOR UPDATE
      `;
      if (!locked[0] || !["INITIATED", "PAYMENT_PENDING"].includes(locked[0].status)) return;
      await tx.depositRequest.update({ where: { id: item.id }, data: { status: "EXPIRED" } });
      await tx.auditLog.create({
        data: {
          action: "DEPOSIT_EXPIRED",
          entityType: "DEPOSIT_REQUEST",
          entityId: item.id,
          description: "Unpaid deposit request expired by scheduled reconciliation",
          metadata: { depositId: item.id },
        },
      });
      if (item.transactionId) {
        await tx.transaction.updateMany({
          where: { id: item.transactionId, status: { in: ["PENDING", "PROCESSING"] } },
          data: { status: "FAILED", failureCode: "DEPOSIT_EXPIRED", failureReason: "Payment session expired" },
        });
      }
      expiredRequests++;
    });
  }

  const stuckProcessing = await prisma.depositRequest.findMany({
    where: { status: "PROCESSING", createdAt: { lte: new Date(now.getTime() - 15 * 60 * 1000) } },
    select: { id: true, provider: true, amount: true, currencyCode: true, createdAt: true },
    take: 500,
  });
  let reviewRequired = 0;
  for (const candidate of stuckProcessing) {
    const deposit = await prisma.depositRequest.findUnique({
      where: { id: candidate.id },
      include: { transaction: true },
    });
    if (!deposit || !deposit.transaction) continue;
    let payment = await prisma.depositProviderPayment.findFirst({
      where: { depositRequestId: deposit.id },
      select: { id: true, status: true, createdAt: true },
    });

    // Recover a provider payment that was created remotely but whose response
    // could not be persisted locally. Adapter lookup must be idempotent and
    // server-to-server; it may never trust the browser return URL.
    if (!payment) {
      try {
        const adapter = getDepositProviderAdapter(deposit.provider);
        const recovered = await adapter.lookupPaymentByMerchantReference(deposit.id);
        if (recovered) {
          if (recovered.provider !== deposit.provider) throw new Error("Provider mismatch during recovery");
          const providerStatus = recovered.status === "SUCCESS" ? "SUCCESS"
            : recovered.status === "FAILED" ? "FAILED"
            : recovered.status === "CANCELLED" ? "CANCELLED"
            : "PROCESSING";
          await prisma.$transaction(async (tx) => {
            const prior = await tx.depositProviderPayment.findFirst({
              where: { provider: deposit.provider, providerPaymentId: recovered.providerPaymentId },
            });
            if (prior && prior.depositRequestId !== deposit.id) {
              throw new Error("Recovered provider payment is already linked to another deposit");
            }
            if (prior) {
              await tx.depositProviderPayment.update({
                where: { id: prior.id }, data: { status: providerStatus },
              });
            } else {
              await tx.depositProviderPayment.create({
                data: {
                  depositRequestId: deposit.id, provider: deposit.provider,
                  providerPaymentId: recovered.providerPaymentId,
                  providerReference: recovered.providerReference ?? null,
                  status: providerStatus, amount: new Prisma.Decimal(recovered.amount),
                  currencyCode: recovered.currency.toUpperCase(),
                },
              });
            }
            await tx.externalProviderTransaction.upsert({
              where: { transactionId: deposit.transaction!.id },
              create: {
                transactionId: deposit.transaction!.id, provider: deposit.provider,
                providerTransactionId: recovered.providerPaymentId,
                externalReference: recovered.providerReference ?? deposit.id,
                currencyCode: recovered.currency.toUpperCase(),
                amount: new Prisma.Decimal(recovered.amount),
                status: providerStatus === "SUCCESS" ? "SUCCESS" : providerStatus === "FAILED" ? "FAILED" : providerStatus === "CANCELLED" ? "CANCELLED" : "PROCESSING",
              },
              update: {
                providerTransactionId: recovered.providerPaymentId,
                status: providerStatus === "SUCCESS" ? "SUCCESS" : providerStatus === "FAILED" ? "FAILED" : providerStatus === "CANCELLED" ? "CANCELLED" : "PROCESSING",
              },
            });
            await tx.transaction.update({
              where: { id: deposit.transaction!.id },
              data: { providerTransactionId: recovered.providerPaymentId, status: providerStatus === "SUCCESS" ? "PROCESSING" : providerStatus === "FAILED" ? "FAILED" : providerStatus === "CANCELLED" ? "CANCELLED" : "PROCESSING" },
            });
            await tx.auditLog.create({
              data: {
                action: "DEPOSIT_PROVIDER_PAYMENT_RECOVERED",
                entityType: "DEPOSIT_REQUEST",
                entityId: deposit.id,
                description: "Provider payment recovered by scheduled server-side lookup",
                metadata: { depositId: deposit.id, providerPaymentId: recovered.providerPaymentId, provider: deposit.provider },
              },
            });
          });
          if (recovered.status === "SUCCESS") {
            await settleVerifiedDeposit({
              ...recovered,
              eventId: `RECOVERY-${deposit.id}`,
              eventType: "PROVIDER_LOOKUP_RECOVERY",
            });
            continue;
          }
          if (recovered.status === "FAILED" || recovered.status === "CANCELLED") {
            await prisma.depositRequest.update({
              where: { id: deposit.id }, data: { status: recovered.status },
            });
            continue;
          }
          payment = await prisma.depositProviderPayment.findFirst({
            where: { depositRequestId: deposit.id },
            select: { id: true, status: true, createdAt: true },
          });
        }
      } catch (error) {
        logger.warn("deposit.provider.recovery_unavailable", {
          depositId: deposit.id, provider: deposit.provider,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      }
    }

    if (payment && payment.status !== "PENDING" && payment.status !== "PROCESSING") continue;
    if (payment && payment.createdAt > new Date(now.getTime() - 30 * 60 * 1000)) continue;
    const existingReview = await prisma.depositReconciliationRecord.findFirst({
      where: { depositRequestId: deposit.id, status: "REVIEW_REQUIRED" },
      select: { id: true },
    });
    if (existingReview) continue;
    await prisma.depositReconciliationRecord.create({
      data: {
        depositRequestId: deposit.id, provider: deposit.provider,
        status: "REVIEW_REQUIRED", expectedAmount: deposit.amount,
        expectedCurrency: deposit.currencyCode,
        notes: payment
          ? "Provider payment has remained pending/processing beyond the review threshold"
          : "Deposit initiation outcome is uncertain and no provider payment record was persisted",
      },
    });
    reviewRequired++;
  }

  const settlements = await prisma.depositProviderSettlement.findMany({
    where: { reconciledAt: null },
    orderBy: { createdAt: "asc" },
    take: 500,
  });
  let matchedSettlements = 0;
  let unmatchedSettlements = 0;
  for (const settlement of settlements) {
    const providerPayment = await prisma.depositProviderPayment.findFirst({
      where: { provider: settlement.provider, providerPaymentId: settlement.providerPaymentId },
    });
    const deposit = settlement.depositRequestId
      ? await prisma.depositRequest.findUnique({ where: { id: settlement.depositRequestId } })
      : providerPayment
        ? await prisma.depositRequest.findUnique({ where: { id: providerPayment.depositRequestId } })
        : await prisma.depositRequest.findFirst({
            where: { provider: settlement.provider, providerReference: settlement.providerPaymentId },
          });
    const paymentMatches = Boolean(
      deposit && providerPayment &&
      deposit.amount.equals(settlement.amount) &&
      deposit.currencyCode === settlement.currencyCode,
    );
    const matches = paymentMatches && deposit?.status === "SETTLED";
    const reconciliationStatus = matches
      ? "MATCHED" as const
      : paymentMatches
        ? "REVIEW_REQUIRED" as const
        : "UNMATCHED" as const;
    await prisma.$transaction(async (tx) => {
      const already = await tx.depositReconciliationRecord.findFirst({
        where: { settlementId: settlement.id, status: reconciliationStatus },
        select: { id: true },
      });
      if (!already) {
        await tx.depositReconciliationRecord.create({
          data: {
            depositRequestId: deposit?.id ?? null,
            settlementId: settlement.id,
            provider: settlement.provider,
            status: reconciliationStatus,
            expectedAmount: deposit?.amount ?? null,
            actualAmount: settlement.amount,
            expectedCurrency: deposit?.currencyCode ?? null,
            actualCurrency: settlement.currencyCode,
            providerReference: settlement.providerPaymentId,
            notes: matches
              ? "Scheduled reconciliation matched a settled deposit"
              : paymentMatches
                ? "Provider payment matches but customer deposit is not settled; manual review required"
                : "Provider settlement has no matching deposit/payment record",
          },
        });
      }
      if (matches) {
        await tx.depositProviderSettlement.update({ where: { id: settlement.id }, data: { reconciledAt: now } });
      }
    });
    if (matches) matchedSettlements++;
    else unmatchedSettlements++;
  }

  if (expiredRequests || matchedSettlements || unmatchedSettlements || reviewRequired) {
    logger.info("deposit.reconciliation.completed", { expiredRequests, matchedSettlements, unmatchedSettlements, reviewRequired });
  }
  return { expiredRequests, matchedSettlements, unmatchedSettlements, reviewRequired };
};
