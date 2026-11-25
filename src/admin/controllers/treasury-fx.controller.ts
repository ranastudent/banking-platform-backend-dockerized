import type { Request,Response } from "express";
import { AppError } from "../../errors/AppError";
import { ErrorCode } from "../../errors/errorCodes";
import { treasuryFxSchema } from "../schemas/treasury-fx.schema";
import { executeAdminTreasuryFx } from "../services/treasury-fx.service";

export const createTreasuryFx = async(req:Request,res:Response):Promise<void>=>{
  if(!req.user) throw new AppError("Authentication required",401,ErrorCode.UNAUTHORIZED);
  const parsed=treasuryFxSchema.safeParse(req.body);
  if(!parsed.success) throw new AppError(parsed.error.issues[0]?.message??"Invalid treasury FX request",400,ErrorCode.VALIDATION_ERROR);
  const result=await executeAdminTreasuryFx(parsed.data,req.user.id,req.ip,req.get("user-agent"));
  res.status(201).json({success:true,data:result,requestId:req.requestId});
};
