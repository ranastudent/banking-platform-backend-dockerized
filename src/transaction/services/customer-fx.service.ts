import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError } from "../../errors/AppError";
import { ErrorCode } from "../../errors/errorCodes";
import type { AuthUser } from "../../types/auth";
import type { CustomerFxInput } from "../schemas/customer-fx.schema";

export const exchangeCustomerCurrency = async (user: AuthUser, input: CustomerFxInput, ipAddress?: string, userAgent?: string) => {
  if (input.sourceCurrency === input.targetCurrency) {
    throw new AppError("Source and target currencies must be different", 400, ErrorCode.VALIDATION_ERROR);
  }

  return prisma.$transaction(async (tx) => {
    const accounts = await tx.$queryRaw<Array<{id:string; user_id:string; status:string}>>`
      SELECT id, user_id, status FROM accounts WHERE id = CAST(${input.accountId} AS uuid) FOR UPDATE`;
    const account = accounts[0];
    if (!account) throw new AppError("Account not found", 404, ErrorCode.RESOURCE_NOT_FOUND);
    if (user.role !== "CUSTOMER" || account.user_id !== user.id) {
      throw new AppError("You can only exchange currency in your own account", 403, ErrorCode.FORBIDDEN);
    }
    if (account.status !== "ACTIVE") throw new AppError("Account is not active", 409, ErrorCode.CONFLICT);

    const [sourceCurrency, targetCurrency] = await Promise.all([
      tx.currency.findUnique({ where:{code:input.sourceCurrency} }),
      tx.currency.findUnique({ where:{code:input.targetCurrency} }),
    ]);
    if (!sourceCurrency?.isActive || !targetCurrency?.isActive) {
      throw new AppError("One or both currencies are unavailable", 400, ErrorCode.VALIDATION_ERROR);
    }

    const rate = await tx.exchangeRate.findFirst({
      where:{baseCurrency:input.sourceCurrency, quoteCurrency:input.targetCurrency, status:"ACTIVE",
        effectiveFrom:{lte:new Date()}, OR:[{effectiveTo:null},{effectiveTo:{gt:new Date()}}]},
      orderBy:{version:"desc"},
    });
    if (!rate) throw new AppError("No active exchange rate exists for this currency pair", 409, ErrorCode.CONFLICT);

    const sourceAmount = new Prisma.Decimal(input.sourceAmount);
    const appliedRate = rate.buyRate ?? rate.rate;
    const targetAmount = sourceAmount.mul(appliedRate).toDecimalPlaces(targetCurrency.decimalPlaces, Prisma.Decimal.ROUND_HALF_UP);
    if (targetAmount.lte(0)) throw new AppError("Calculated exchange amount is invalid", 400, ErrorCode.VALIDATION_ERROR);

    const balances = await tx.$queryRaw<Array<{id:string;currency_code:string;available_balance:Prisma.Decimal;locked_balance:Prisma.Decimal}>>`
      SELECT id, currency_code, available_balance, locked_balance FROM account_balances
      WHERE account_id = CAST(${input.accountId} AS uuid)
        AND currency_code IN (${input.sourceCurrency}, ${input.targetCurrency})
      ORDER BY currency_code FOR UPDATE`;
    const sourceBalance = balances.find(b=>b.currency_code===input.sourceCurrency);
    const targetBalance = balances.find(b=>b.currency_code===input.targetCurrency);
    if (!sourceBalance || sourceBalance.available_balance.lt(sourceAmount)) {
      throw new AppError("Insufficient source currency balance", 409, ErrorCode.INSUFFICIENT_BALANCE);
    }

    const reserveRows = await tx.$queryRaw<Array<{id:string;currency_code:string;available_reserve:Prisma.Decimal;locked_reserve:Prisma.Decimal;minimum_reserve:Prisma.Decimal}>>`
      SELECT id,currency_code,available_reserve,locked_reserve,minimum_reserve FROM currency_reserves
      WHERE currency_code IN (${input.sourceCurrency}, ${input.targetCurrency})
      ORDER BY currency_code FOR UPDATE`;
    const sourceReserve = reserveRows.find(r=>r.currency_code===input.sourceCurrency);
    const targetReserve = reserveRows.find(r=>r.currency_code===input.targetCurrency);
    if (!sourceReserve || !targetReserve) throw new AppError("Treasury reserve is not configured for both currencies", 409, ErrorCode.CONFLICT);
    if (targetReserve.available_reserve.lt(targetAmount)) throw new AppError("Insufficient treasury liquidity in target currency", 409, ErrorCode.INSUFFICIENT_BALANCE);
    const targetReserveAfter = targetReserve.available_reserve.sub(targetAmount);
    if (targetReserveAfter.lt(targetReserve.minimum_reserve)) {
      throw new AppError("Exchange would violate the target currency minimum reserve", 409, ErrorCode.CONFLICT);
    }

    const sourceAfter = sourceBalance.available_balance.sub(sourceAmount);
    const targetBefore = targetBalance?.available_balance ?? new Prisma.Decimal(0);
    const targetAfter = targetBefore.add(targetAmount);
    await tx.accountBalance.update({where:{id:sourceBalance.id},data:{availableBalance:sourceAfter}});
    if (targetBalance) {
      await tx.accountBalance.update({where:{id:targetBalance.id},data:{availableBalance:targetAfter}});
    } else {
      await tx.accountBalance.create({data:{accountId:input.accountId,currencyCode:input.targetCurrency,availableBalance:targetAfter,lockedBalance:0}});
    }

    const sourceReserveAfter = sourceReserve.available_reserve.add(sourceAmount);
    await tx.currencyReserve.update({where:{id:sourceReserve.id},data:{availableReserve:sourceReserveAfter}});
    await tx.currencyReserve.update({where:{id:targetReserve.id},data:{availableReserve:targetReserveAfter}});

    const transaction = await tx.transaction.create({data:{
      reference:`FXC-${randomUUID()}`, type:"FX_CONVERSION", status:"COMPLETED",
      amount:sourceAmount, currencyCode:input.sourceCurrency, sourceAccountId:input.accountId,
      destinationAccountId:input.accountId, provider:"INTERNAL",
      metadata:{operation:"CUSTOMER_FX_EXCHANGE",sourceCurrency:input.sourceCurrency,targetCurrency:input.targetCurrency,
        sourceAmount:sourceAmount.toString(),targetAmount:targetAmount.toString(),rate:appliedRate.toString(),rateId:rate.id,
        treasurySourceMovement:"INCREASE",treasuryTargetMovement:"DECREASE"},
    }});

    await tx.ledgerEntry.createMany({data:[
      {transactionId:transaction.id,accountId:input.accountId,currencyCode:input.sourceCurrency,entryType:"DEBIT",amount:sourceAmount,balanceBefore:sourceBalance.available_balance,balanceAfter:sourceAfter},
      {transactionId:transaction.id,accountId:input.accountId,currencyCode:input.targetCurrency,entryType:"CREDIT",amount:targetAmount,balanceBefore:targetBefore,balanceAfter:targetAfter},
    ]});
    await tx.transactionLeg.createMany({data:[
      {transactionId:transaction.id,accountId:input.accountId,currencyCode:input.sourceCurrency,entryType:"DEBIT",amount:sourceAmount},
      {transactionId:transaction.id,accountId:input.accountId,currencyCode:input.targetCurrency,entryType:"CREDIT",amount:targetAmount},
    ]});
    await tx.reserveMovement.createMany({data:[
      {reserveId:sourceReserve.id,currencyCode:input.sourceCurrency,transactionId:transaction.id,movementType:"CUSTOMER_FX_SELL",amount:sourceAmount,balanceBefore:sourceReserve.available_reserve,balanceAfter:sourceReserveAfter},
      {reserveId:targetReserve.id,currencyCode:input.targetCurrency,transactionId:transaction.id,movementType:"CUSTOMER_FX_PURCHASE",amount:targetAmount,balanceBefore:targetReserve.available_reserve,balanceAfter:targetReserveAfter},
    ]});
    await tx.auditLog.create({data:{userId:user.id,action:"CUSTOMER_FX_EXCHANGED",entityType:"TRANSACTION",entityId:transaction.id,
      description:`Customer exchanged ${sourceAmount.toString()} ${input.sourceCurrency} to ${targetAmount.toString()} ${input.targetCurrency}.`,
      ipAddress:ipAddress??null,userAgent:userAgent??null,
      metadata:{accountId:input.accountId,sourceCurrency:input.sourceCurrency,targetCurrency:input.targetCurrency,
        sourceAmount:sourceAmount.toString(),targetAmount:targetAmount.toString(),rate:appliedRate.toString(),rateId:rate.id}}});
    await tx.outboxEvent.create({data:{eventType:"NOTIFICATION_REQUESTED",payload:{
      userId:user.id,notificationType:"TRANSACTION_SUCCESS",title:"Currency exchange completed",
      message:`You exchanged ${sourceAmount.toString()} ${input.sourceCurrency} for ${targetAmount.toString()} ${input.targetCurrency}. Reference: ${transaction.reference}.`,
      metadata:{transactionId:transaction.id,reference:transaction.reference}}}});
    return {transaction:{id:transaction.id,reference:transaction.reference,status:transaction.status,type:transaction.type},
      source:{currency:input.sourceCurrency,amount:sourceAmount.toString(),balanceBefore:sourceBalance.available_balance.toString(),balanceAfter:sourceAfter.toString()},
      target:{currency:input.targetCurrency,amount:targetAmount.toString(),balanceBefore:targetBefore.toString(),balanceAfter:targetAfter.toString()},
      exchangeRate:{rate:appliedRate.toString(),baseCurrency:input.sourceCurrency,quoteCurrency:input.targetCurrency,version:rate.version},
      treasury:{sourceReserveAfter:sourceReserveAfter.toString(),targetReserveAfter:targetReserveAfter.toString()}};
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
};
