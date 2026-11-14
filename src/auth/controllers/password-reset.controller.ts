import type { NextFunction, Request, Response } from "express";

import { sendSuccess } from "../../utils/apiResponse";
import type {
  ForgotPasswordInput,
  ResetPasswordInput,
} from "../schemas/password-reset.schema";
import {
  requestPasswordReset,
  resetPassword,
} from "../services/password-reset.service";

export const forgotPasswordController = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const result = await requestPasswordReset(
      req.body as ForgotPasswordInput,
      {
        requestId: req.requestId,
        ipAddress: req.ip,
        userAgent: req.get("user-agent") ?? undefined,
      },
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
      {
        requestId: req.requestId,
        ipAddress: req.ip,
        userAgent: req.get("user-agent") ?? undefined,
      },
    );

    sendSuccess(res, req.requestId, result, 200);
  } catch (error) {
    next(error);
  }
};
