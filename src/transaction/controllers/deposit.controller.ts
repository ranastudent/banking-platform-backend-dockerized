import type { Request, Response } from "express";

import { AppError } from "../../errors/AppError";
import { ErrorCode } from "../../errors/errorCodes";
import { getDepositAuthorizedAccount } from "../policies/deposit.policy";
import { prepareDeposit } from "../services/deposit.service";
import { createDemoFunding } from "../../deposits/services/deposit.request.service";
import {
  completeIdempotencyRecord, clearIdempotencyRecord,
} from "../../middleware/idempotency.middleware";

export const authorizeDeposit = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const accountId = req.params.accountId;

  if (!req.user) {
    throw new AppError(
      "Authentication required",
      401,
      ErrorCode.UNAUTHORIZED,
    );
  }

  if (
    typeof accountId !== "string" ||
    accountId.trim() === ""
  ) {
    throw new AppError(
      "Account ID is required",
      400,
      ErrorCode.BAD_REQUEST,
    );
  }

  const account = await getDepositAuthorizedAccount(
    accountId,
    req.user.id,
    req.user.role,
  );

  res.status(200).json({
    success: true,
    data: {
      message: "Deposit authorization successful",
      accountId: account.id,
      accountNumber: account.accountNumber,
      userId: req.user.id,
      userRole: req.user.role,
    },
    requestId: req.requestId,
  });
};

export const processDeposit = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const accountId = req.params.accountId;

  if (!req.user) {
    throw new AppError(
      "Authentication required",
      401,
      ErrorCode.UNAUTHORIZED,
    );
  }

  if (
    typeof accountId !== "string" ||
    accountId.trim() === ""
  ) {
    throw new AppError(
      "Account ID is required",
      400,
      ErrorCode.BAD_REQUEST,
    );
  }

  // Legacy account-scoped deposit is retained for existing integration tests
  // and explicitly enabled local demo funding only. It must never be used to
  // create real customer money in production.
  if (
    process.env.NODE_ENV === "production" ||
    (process.env.NODE_ENV !== "test" &&
      (process.env.DEPOSIT_DEMO_ENABLED || "false").toLowerCase() !== "true")
  ) {
    throw new AppError(
      "Legacy direct-credit deposit is disabled. Use the verified deposit request flow.",
      403,
      ErrorCode.FORBIDDEN,
    );
  }

  if (process.env.NODE_ENV !== "test") {
    const key = req.get("Idempotency-Key")?.trim();
    if (!key) throw new AppError("Idempotency-Key is required", 400, ErrorCode.BAD_REQUEST);
    try {
      const data = await createDemoFunding(req.user, {
        accountId,
        amount: String(req.body.amount),
        currency: String(req.body.currency),
        reason: "Legacy account-scoped demo funding endpoint",
      }, key);
      await completeIdempotencyRecord(res, 201, data);
      res.status(201).json({ success: true, data, requestId: req.requestId });
      return;
    } catch (error) {
      await clearIdempotencyRecord(res);
      throw error;
    }
  }

  let result;

  try {
    result = await prepareDeposit(
      req.user,
      accountId,
      req.body,
      {
        auditContext: {
          requestId: req.requestId,
          ipAddress: req.ip,
          userAgent: req.get("user-agent") ?? undefined,
        },
      },
    );
  } catch (error) {
    await clearIdempotencyRecord(res);
    throw error;
  }

  const responseData = {
    message: "Deposit transaction created successfully",
    accountId: result.account.id,
    accountNumber: result.account.accountNumber,
    currency: result.currency.code,
    amount: result.amount.toString(),

    balance: result.balance,

    ledgerEntry: result.ledgerEntry,

    transaction: result.transaction,

    userId: req.user.id,
    userRole: req.user.role,
  };

  await completeIdempotencyRecord(
    res,
    200,
    responseData,
  );

  res.status(200).json({
    success: true,
    data: responseData,
    requestId: req.requestId,
  });
};