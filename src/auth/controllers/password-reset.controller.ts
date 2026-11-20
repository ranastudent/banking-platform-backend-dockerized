import type { NextFunction, Request, Response } from "express";

import { sendSuccess } from "../../utils/apiResponse";
import type {
  RequestPasswordResetOtpInput,
  VerifyPasswordResetOtpInput,
  ResetPasswordInput,
} from "../schemas/password-reset.schema";
import {
  requestPasswordResetOtp,
  verifyPasswordResetOtp,
  resetPassword,
} from "../services/password-reset.service";

const getAuditContext = (req: Request) => ({
  requestId: req.requestId,
  ipAddress: req.ip,
  userAgent: req.get("user-agent") ?? undefined,
});

export const requestPasswordResetOtpController = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const result = await requestPasswordResetOtp(
      req.body as RequestPasswordResetOtpInput,
      getAuditContext(req),
    );
    sendSuccess(res, req.requestId, result, 200);
  } catch (error) {
    next(error);
  }
};

export const verifyPasswordResetOtpController = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const result = await verifyPasswordResetOtp(
      req.body as VerifyPasswordResetOtpInput,
    );
    sendSuccess(res, req.requestId, result, 200);
  } catch (error) {
    next(error);
  }
};

export const resetPasswordController = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const result = await resetPassword(
      req.body as ResetPasswordInput,
      getAuditContext(req),
    );
    sendSuccess(res, req.requestId, result, 200);
  } catch (error) {
    next(error);
  }
};
