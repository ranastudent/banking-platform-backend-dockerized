import type { PaymentProvider } from "@prisma/client";
import { prisma } from "../../../config/prisma";
import { AppError } from "../../../errors/AppError";
import { ErrorCode } from "../../../errors/errorCodes";
import type { DepositProviderAdapter, ProviderPaymentResult } from "../../types/deposit.types";

const providers: PaymentProvider[] = ["BKASH", "NAGAD", "ROCKET", "WISE", "STRIPE"];

const makeMockAdapter = (provider: PaymentProvider): DepositProviderAdapter => ({
  provider,
  createPayment: async (input): Promise<ProviderPaymentResult> => {
    const providerPaymentId = `MOCK-${provider}-${input.depositId}`;
    return {
      providerPaymentId,
      providerReference: `MOCK-REF-${input.depositId}`,
      // No external URL: the local simulator endpoint completes the test payment.
      metadata: {
        simulator: true,
        provider,
        flow: "virtual-deposit",
        merchantReference: input.merchantReference,
        amount: input.amount,
        currency: input.currency,
        notice: "Synthetic test payment. No real provider or money movement.",
      },
    };
  },
  verifyPayment: async (providerPaymentId) => {
    const payment = await prisma.depositProviderPayment.findFirst({
      where: { provider, providerPaymentId },
      include: { depositRequest: true },
    });
    if (!payment) throw new AppError("Mock payment not found", 404, ErrorCode.RESOURCE_NOT_FOUND);
    const status = payment.status === "SUCCESS" ? "SUCCESS" :
      payment.status === "FAILED" ? "FAILED" :
      payment.status === "CANCELLED" ? "CANCELLED" : "PROCESSING";
    return {
      provider,
      providerPaymentId,
      merchantReference: payment.depositRequestId,
      status,
      amount: payment.amount.toString(),
      currency: payment.currencyCode,
      providerReference: payment.providerReference ?? `MOCK-REF-${payment.depositRequestId}`,
    };
  },
  lookupPaymentByMerchantReference: async (merchantReference) => {
    const payment = await prisma.depositProviderPayment.findFirst({
      where: { provider, depositRequestId: merchantReference },
      orderBy: { createdAt: "desc" },
    });
    if (!payment) return null;
    return {
      provider,
      providerPaymentId: payment.providerPaymentId,
      merchantReference,
      status: payment.status === "SUCCESS" ? "SUCCESS" :
        payment.status === "FAILED" ? "FAILED" :
        payment.status === "CANCELLED" ? "CANCELLED" : "PROCESSING",
      amount: payment.amount.toString(),
      currency: payment.currencyCode,
      providerReference: payment.providerReference ?? `MOCK-REF-${merchantReference}`,
    };
  },
  parseAndVerifyWebhook: async () => {
    throw new AppError(
      "Mock providers do not accept external webhooks. Use the authenticated local simulator endpoint.",
      400,
      ErrorCode.BAD_REQUEST,
    );
  },
});

export const createMockDepositAdapters = (): DepositProviderAdapter[] =>
  providers.map(makeMockAdapter);
