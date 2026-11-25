import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError } from "../../errors/AppError";
import { ErrorCode } from "../../errors/errorCodes";
import type { TreasuryFxInput } from "../schemas/treasury-fx.schema";

export const executeAdminTreasuryFx = async (input:TreasuryFxInput,adminUserId:string,ipAddress?:string,userAgent?:string) => {
  if(input.sourceCurrency===input.targetCurrency) throw new AppError("Source and target currencies must be different",400,ErrorCode.VALIDATION_ERROR);
  return prisma.$transaction(async tx=>{
    const [sourceCurrency,targetCurrency]=await Promise.all([
      tx.currency.findUnique({where:{code:input.sourceCurrency}}),
      tx.currency.findUnique({where:{code:input.targetCurrency}}),
    ]);
    if(!sourceCurrency?.isActive||!targetCurrency?.isActive) throw new AppError("One or both currencies are unavailable",400,ErrorCode.VALIDATION_ERROR);
    const rate=await tx.exchangeRate.findFirst({where:{baseCurrency:input.sourceCurrency,quoteCurrency:input.targetCurrency,status:"ACTIVE",
      effectiveFrom:{lte:new Date()},OR:[{effectiveTo:null},{effectiveTo:{gt:new Date()}}]},orderBy:{version:"desc"}});
    if(!rate) throw new AppError("No active exchange rate exists for this currency pair",409,ErrorCode.CONFLICT);
    const sourceAmount=new Prisma.Decimal(input.sourceAmount);
    const appliedRate=rate.rate;
    const targetAmount=sourceAmount.mul(appliedRate).toDecimalPlaces(targetCurrency.decimalPlaces,Prisma.Decimal.ROUND_HALF_UP);
    const rows=await tx.$queryRaw<Array<{id:string;currency_code:string;available_reserve:Prisma.Decimal;minimum_reserve:Prisma.Decimal}>>`
      SELECT id,currency_code,available_reserve,minimum_reserve FROM currency_reserves
      WHERE currency_code IN (${input.sourceCurrency},${input.targetCurrency}) ORDER BY currency_code FOR UPDATE`;
    const source=rows.find(r=>r.currency_code===input.sourceCurrency);
    const target=rows.find(r=>r.currency_code===input.targetCurrency);
    if(!source||!target) throw new AppError("Treasury reserve is not configured for both currencies",409,ErrorCode.CONFLICT);
    if(source.available_reserve.lt(sourceAmount)) throw new AppError("Insufficient source treasury reserve",409,ErrorCode.INSUFFICIENT_BALANCE);
    const sourceAfter=source.available_reserve.sub(sourceAmount);
    if(sourceAfter.lt(source.minimum_reserve)) throw new AppError("Conversion would violate the source minimum reserve",409,ErrorCode.CONFLICT);
    const targetAfter=target.available_reserve.add(targetAmount);
    await tx.currencyReserve.update({where:{id:source.id},data:{availableReserve:sourceAfter}});
    await tx.currencyReserve.update({where:{id:target.id},data:{availableReserve:targetAfter}});
    const transaction=await tx.transaction.create({data:{
      reference:`TXFX-${randomUUID()}`,type:"FX_CONVERSION",status:"COMPLETED",amount:sourceAmount,currencyCode:input.sourceCurrency,
      provider:"INTERNAL",metadata:{operation:"ADMIN_TREASURY_FX",sourceCurrency:input.sourceCurrency,targetCurrency:input.targetCurrency,
        sourceAmount:sourceAmount.toString(),targetAmount:targetAmount.toString(),rate:appliedRate.toString(),rateId:rate.id,reason:input.reason,adminUserId},
    }});
    await tx.reserveMovement.createMany({data:[
      {reserveId:source.id,currencyCode:input.sourceCurrency,transactionId:transaction.id,movementType:"ADMIN_ADJUSTMENT",amount:sourceAmount,balanceBefore:source.available_reserve,balanceAfter:sourceAfter},
      {reserveId:target.id,currencyCode:input.targetCurrency,transactionId:transaction.id,movementType:"ADMIN_ADJUSTMENT",amount:targetAmount,balanceBefore:target.available_reserve,balanceAfter:targetAfter},
    ]});
    await tx.auditLog.create({data:{userId:adminUserId,action:"TREASURY_FX_CONVERTED",entityType:"TRANSACTION",entityId:transaction.id,
      description:`Treasury converted ${sourceAmount.toString()} ${input.sourceCurrency} into ${targetAmount.toString()} ${input.targetCurrency}.`,
      ipAddress:ipAddress??null,userAgent:userAgent??null,metadata:{sourceCurrency:input.sourceCurrency,targetCurrency:input.targetCurrency,
        sourceAmount:sourceAmount.toString(),targetAmount:targetAmount.toString(),rate:appliedRate.toString(),rateId:rate.id,reason:input.reason,
        sourceReserveBefore:source.available_reserve.toString(),sourceReserveAfter:sourceAfter.toString(),
        targetReserveBefore:target.available_reserve.toString(),targetReserveAfter:targetAfter.toString()}}});
    return {transaction:{id:transaction.id,reference:transaction.reference,status:transaction.status},
      source:{currency:input.sourceCurrency,before:source.available_reserve.toString(),decreased:sourceAmount.toString(),after:sourceAfter.toString()},
      target:{currency:input.targetCurrency,before:target.available_reserve.toString(),increased:targetAmount.toString(),after:targetAfter.toString()},
      exchangeRate:{rate:appliedRate.toString(),baseCurrency:input.sourceCurrency,quoteCurrency:input.targetCurrency,version:rate.version}};
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
};
