import type { PaymentProvider } from "@prisma/client";

export const EXTERNAL_DEPOSIT_PROVIDERS: PaymentProvider[] = [
  "BKASH", "NAGAD", "ROCKET", "WISE", "PAYPAL", "PAYONEER",
];

export type ProviderPaymentResult = {
  providerPaymentId: string;
  providerReference?: string;
  paymentUrl?: string;
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
};

export type VerifiedProviderPayment = {
  provider: PaymentProvider;
  eventId: string;
  eventType: string;
  providerPaymentId: string;
  merchantReference: string;
  status: "SUCCESS" | "FAILED" | "CANCELLED" | "PROCESSING";
  amount: string;
  currency: string;
  providerReference?: string;
};

export type ProviderWebhookEvent = {
  eventId: string;
  eventType: string;
  providerPaymentId: string;
  merchantReference: string;
  providerReference?: string;
};

export type DepositProviderAdapter = {
  provider: PaymentProvider;
  createPayment: (input: {
    depositId: string;
    merchantReference: string;
    amount: string;
    fee: string;
    netAmount: string;
    currency: string;
  }) => Promise<ProviderPaymentResult>;
  verifyPayment: (providerPaymentId: string) => Promise<Omit<VerifiedProviderPayment, "eventId" | "eventType">>;
  lookupPaymentByMerchantReference: (merchantReference: string) => Promise<Omit<VerifiedProviderPayment, "eventId" | "eventType"> | null>;
  parseAndVerifyWebhook: (rawBody: string, signature: string | undefined, body: unknown) => Promise<ProviderWebhookEvent>;
};
