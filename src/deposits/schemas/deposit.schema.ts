import { z } from "zod";

const positiveDecimal = z.string().trim()
  .regex(/^\d+(\.\d{1,8})?$/, "Amount must be a decimal with up to 8 places")
  .refine((value) => Number(value) > 0, "Amount must be greater than zero");

export const depositQuoteSchema = z.object({
  accountId: z.string().uuid(),
  amount: positiveDecimal,
  currency: z.string().trim().length(3).regex(/^[A-Za-z]{3}$/).transform((v) => v.toUpperCase()),
  provider: z.enum(["BKASH", "NAGAD", "ROCKET", "WISE", "PAYPAL", "PAYONEER", "STRIPE"]),
}).strict();

export const createDepositSchema = depositQuoteSchema;

export const cancelDepositSchema = z.object({
  reason: z.string().trim().max(300).optional(),
}).strict();

export const demoFundingSchema = z.object({
  accountId: z.string().uuid(),
  amount: positiveDecimal,
  currency: z.string().trim().length(3).regex(/^[A-Za-z]{3}$/).transform((v) => v.toUpperCase()),
  reason: z.string().trim().min(3).max(300).optional(),
}).strict();

export const adminReconcileSchema = z.object({
  settlementReference: z.string().trim().min(1).max(128),
  providerPaymentId: z.string().trim().min(1).max(128),
  amount: positiveDecimal,
  currency: z.string().trim().length(3).regex(/^[A-Za-z]{3}$/).transform((v) => v.toUpperCase()),
  settledAt: z.string().datetime().optional(),
  notes: z.string().trim().max(500).optional(),
}).strict();

export type DepositQuoteInput = z.infer<typeof depositQuoteSchema>;
export type CreateDepositInput = z.infer<typeof createDepositSchema>;
export type DemoFundingInput = z.infer<typeof demoFundingSchema>;
