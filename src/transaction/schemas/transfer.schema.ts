import { z } from "zod";

// The public transfer API uses customer-facing account numbers for BOTH
// accounts. Internal database UUIDs must never be accepted as account numbers.
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){2}[0-9a-f]{4}-[0-9a-f]{12}$/i;

const accountNumberSchema = z
  .string()
  .trim()
  .min(4, "Account number must contain at least 4 characters")
  .max(64, "Account number must not exceed 64 characters")
  .refine((value) => !UUID_PATTERN.test(value), {
    message: "Use the customer-facing account number, not an internal account UUID",
  });

export const transferSchema = z
  .object({
    // Both values are account numbers (not Account.id UUIDs).
    senderAccount: accountNumberSchema,

    receiverAccount: accountNumberSchema,

    amount: z
      .string()
      .trim()
      .regex(
        /^\d+(\.\d{1,8})?$/,
        "Amount must be a positive decimal with up to 8 decimal places",
      )
      .refine(
        (value) => Number(value) > 0,
        {
          message: "Amount must be greater than 0",
        },
      ),

    currency: z
      .string()
      .trim()
      .length(
        3,
        "Currency must be a 3-letter code",
      )
      .regex(
        /^[A-Za-z]{3}$/,
        "Currency must contain exactly 3 letters",
      )
      .transform((value) =>
        value.toUpperCase(),
      ),
  })
  .strict();

export type TransferInput =
  z.infer<typeof transferSchema>;