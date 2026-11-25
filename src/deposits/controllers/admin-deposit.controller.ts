import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError } from "../../errors/AppError";
import { ErrorCode } from "../../errors/errorCodes";
import { writeAuditLog } from "../../audit/audit.service";
import { reverseDeposit } from "../services/deposit.request.service";
import { adminReconcileSchema } from "../schemas/deposit.schema";

const requireAdmin = (req: Request) => {
  if (!req.user || req.user.role !== "ADMIN") throw new AppError("Admin permission required", 403, ErrorCode.FORBIDDEN);
  return req.user;
};

export const adminListDeposits = async (req: Request, res: Response): Promise<void> => {
  requireAdmin(req);
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 20);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new AppError("Invalid pagination", 400, ErrorCode.BAD_REQUEST);
  }
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const provider = typeof req.query.provider === "string" ? req.query.provider.toUpperCase() : undefined;
  const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 100) : undefined;
  const currency = typeof req.query.currency === "string" ? req.query.currency.trim().toUpperCase() : undefined;
  const validStatuses = ["INITIATED", "PAYMENT_PENDING", "PROCESSING", "CONFIRMED", "SETTLED", "FAILED", "EXPIRED", "CANCELLED", "REVERSED"];
  const validProviders = ["INTERNAL", "BKASH", "NAGAD", "ROCKET", "PAYPAL", "PAYONEER", "WISE"];
  if (status && !validStatuses.includes(status)) throw new AppError("Invalid status filter", 400, ErrorCode.BAD_REQUEST);
  if (provider && !validProviders.includes(provider)) throw new AppError("Invalid provider filter", 400, ErrorCode.BAD_REQUEST);
  const startDate = typeof req.query.startDate === "string" ? new Date(req.query.startDate) : undefined;
  const endDate = typeof req.query.endDate === "string" ? new Date(req.query.endDate) : undefined;
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw new AppError("Invalid currency filter", 400, ErrorCode.BAD_REQUEST);
  if (startDate && Number.isNaN(startDate.getTime())) throw new AppError("Invalid startDate", 400, ErrorCode.BAD_REQUEST);
  if (endDate && Number.isNaN(endDate.getTime())) throw new AppError("Invalid endDate", 400, ErrorCode.BAD_REQUEST);
  if (startDate && endDate && startDate > endDate) throw new AppError("startDate must be before endDate", 400, ErrorCode.BAD_REQUEST);
  const where: Prisma.DepositRequestWhereInput = {
    ...(status ? { status: status as never } : {}),
    ...(provider ? { provider: provider as never } : {}),
    ...(currency ? { currencyCode: currency } : {}),
    ...(startDate || endDate ? { createdAt: { ...(startDate ? { gte: startDate } : {}), ...(endDate ? { lte: endDate } : {}) } } : {}),
    ...(search ? {
      OR: [
        ...( /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(search)
          ? [{ id: search }]
          : []),
        { providerReference: { contains: search, mode: "insensitive" } },
        { transaction: { reference: { contains: search, mode: "insensitive" } } },
        { user: { email: { contains: search, mode: "insensitive" } } },
        { account: { accountNumber: { contains: search, mode: "insensitive" } } },
      ],
    } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.depositRequest.findMany({
      where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit,
      select: {
        id: true, userId: true, accountId: true, transactionId: true,
        provider: true, kind: true, providerReference: true, amount: true,
        fee: true, netAmount: true, currencyCode: true, status: true,
        expiresAt: true, paidAt: true, settledAt: true, createdAt: true, updatedAt: true,
        user: { select: { id: true, name: true, email: true } },
        account: { select: { id: true, accountNumber: true } },
        transaction: { select: { reference: true, status: true } },
      },
    }),
    prisma.depositRequest.count({ where }),
  ]);
  res.json({
    success: true,
    data: {
      items: items.map((item) => ({ ...item, amount: item.amount.toString(), fee: item.fee.toString(), netAmount: item.netAmount.toString() })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    },
    requestId: req.requestId,
  });
};

export const adminDepositDetail = async (req: Request, res: Response): Promise<void> => {
  requireAdmin(req);
  const id = req.params.depositId;
  if (typeof id !== "string") throw new AppError("Deposit ID required", 400, ErrorCode.BAD_REQUEST);
  const data = await prisma.depositRequest.findUnique({
    where: { id },
    select: {
      id: true, userId: true, accountId: true, transactionId: true,
      provider: true, kind: true, providerReference: true, amount: true,
      fee: true, netAmount: true, currencyCode: true, status: true,
      paymentUrl: true, expiresAt: true, paidAt: true, settledAt: true,
      reversedAt: true, createdAt: true, updatedAt: true,
      user: { select: { id: true, name: true, email: true } },
      account: { select: { id: true, accountNumber: true } },
      transaction: { select: { id: true, reference: true, type: true, status: true, amount: true, currencyCode: true, provider: true, providerTransactionId: true, createdAt: true } },
      providerPayments: { select: { provider: true, providerPaymentId: true, providerReference: true, status: true, amount: true, currencyCode: true, createdAt: true, updatedAt: true } },
      settlements: { select: { id: true, provider: true, settlementReference: true, providerPaymentId: true, amount: true, currencyCode: true, status: true, settledAt: true, reconciledAt: true, createdAt: true } },
      reconciliationRecords: true,
      journalEntries: { include: { lines: { include: { account: true } } } },
    },
  });
  if (!data) throw new AppError("Deposit not found", 404, ErrorCode.RESOURCE_NOT_FOUND);
  res.json({ success: true, data, requestId: req.requestId });
};

export const adminReconcileDeposit = async (req: Request, res: Response): Promise<void> => {
  const admin = requireAdmin(req);
  const id = req.params.depositId;
  if (typeof id !== "string") throw new AppError("Deposit ID required", 400, ErrorCode.BAD_REQUEST);
  const parsed = adminReconcileSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError("Invalid settlement data", 400, ErrorCode.VALIDATION_ERROR);
  const input = parsed.data;
  const deposit = await prisma.depositRequest.findUnique({ where: { id } });
  if (!deposit) throw new AppError("Deposit not found", 404, ErrorCode.RESOURCE_NOT_FOUND);

  const actualAmount = new Prisma.Decimal(input.amount);
  const matched = actualAmount.equals(deposit.amount) && input.currency === deposit.currencyCode &&
    input.providerPaymentId === (await prisma.depositProviderPayment.findFirst({
      where: { depositRequestId: deposit.id }, select: { providerPaymentId: true },
    }))?.providerPaymentId;

  const result = await prisma.$transaction(async (tx) => {
    const settlement = await tx.depositProviderSettlement.upsert({
      where: { provider_settlementReference: { provider: deposit.provider, settlementReference: input.settlementReference } },
      create: {
        depositRequestId: deposit.id, provider: deposit.provider,
        settlementReference: input.settlementReference, providerPaymentId: input.providerPaymentId,
        amount: actualAmount, currencyCode: input.currency, status: "SUCCESS",
        settledAt: input.settledAt ? new Date(input.settledAt) : new Date(),
        metadata: input.notes ? { notes: input.notes, source: "admin_reconciliation" } : { source: "admin_reconciliation" },
      },
      update: {
        depositRequestId: deposit.id, providerPaymentId: input.providerPaymentId,
        amount: actualAmount, currencyCode: input.currency, status: "SUCCESS",
        settledAt: input.settledAt ? new Date(input.settledAt) : new Date(),
      },
    });
    const record = await tx.depositReconciliationRecord.create({
      data: {
        depositRequestId: deposit.id, settlementId: settlement.id,
        provider: deposit.provider, status: matched ? "MATCHED" : "MISMATCHED",
        expectedAmount: deposit.amount, actualAmount,
        expectedCurrency: deposit.currencyCode, actualCurrency: input.currency,
        providerReference: input.providerPaymentId,
        notes: input.notes ?? (matched ? "Admin settlement matched" : "Settlement mismatch; requires review"),
        performedByUserId: admin.id,
      },
    });
    if (matched) {
      await tx.depositProviderSettlement.update({ where: { id: settlement.id }, data: { reconciledAt: new Date() } });
    }
    await writeAuditLog({
      userId: admin.id, action: "DEPOSIT_RECONCILED", resource: "DEPOSIT_REQUEST",
      resourceId: deposit.id, description: matched ? "Deposit settlement matched" : "Deposit settlement mismatch",
      metadata: { depositId: deposit.id, settlementId: settlement.id, reconciliationId: record.id, status: record.status },
    }, tx);
    return { reconciliation: record, matched };
  });
  res.json({ success: true, data: { ...result, credited: false }, requestId: req.requestId });
};

export const adminReverseDeposit = async (req: Request, res: Response): Promise<void> => {
  const admin = requireAdmin(req);
  const id = req.params.depositId;
  if (typeof id !== "string") throw new AppError("Deposit ID required", 400, ErrorCode.BAD_REQUEST);
  const reason = typeof req.body?.reason === "string" ? req.body.reason : "";
  const data = await reverseDeposit(admin, id, reason);
  res.json({ success: true, data, requestId: req.requestId });
};
