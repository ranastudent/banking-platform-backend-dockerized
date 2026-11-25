import type { Request, Response } from "express";
import { AppError } from "../../errors/AppError";
import { ErrorCode } from "../../errors/errorCodes";
import { customerFxSchema } from "../schemas/customer-fx.schema";
import { exchangeCustomerCurrency } from "../services/customer-fx.service";

export const createCustomerFxExchange = async (req: Request, res: Response): Promise<void> => {
  if (!req.user) throw new AppError("Authentication required",401,ErrorCode.UNAUTHORIZED);
  const parsed = customerFxSchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(parsed.error.issues[0]?.message ?? "Invalid FX request",400,ErrorCode.VALIDATION_ERROR);
  const result = await exchangeCustomerCurrency(req.user,parsed.data,req.ip,req.get("user-agent"));
  res.status(201).json({success:true,data:result,requestId:req.requestId});
};
