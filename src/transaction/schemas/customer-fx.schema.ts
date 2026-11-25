import { z } from "zod";

const amount = z.string().trim().regex(/^(?:0|[1-9]\\d*)(?:\\.\\d{1,8})?$/)
  .refine((v) => Number(v) > 0, "Amount must be greater than zero");

export const customerFxSchema = z.object({
  accountId: z.string().uuid(),
  sourceCurrency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  targetCurrency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  sourceAmount: amount,
});
export type CustomerFxInput = z.infer<typeof customerFxSchema>;
