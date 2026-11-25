import { z } from "zod";
export const treasuryFxSchema = z.object({
  sourceCurrency:z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  targetCurrency:z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  sourceAmount:z.string().trim().regex(/^(?:0|[1-9]\\d*)(?:\\.\\d{1,8})?$/).refine(v=>Number(v)>0,"Amount must be greater than zero"),
  reason:z.string().trim().min(3).max(500),
});
export type TreasuryFxInput=z.infer<typeof treasuryFxSchema>;
