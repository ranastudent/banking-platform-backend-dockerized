-- Add composite unique keys required for tenant/owner and currency-safe FKs.
CREATE UNIQUE INDEX IF NOT EXISTS "accounts_id_user_id_key"
  ON "accounts"("id", "user_id");

CREATE UNIQUE INDEX IF NOT EXISTS "general_ledger_accounts_id_currency_code_key"
  ON "general_ledger_accounts"("id", "currency_code");

-- Prevent a deposit/FX request from referencing an account owned by another user.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "deposit_requests" d
    JOIN "accounts" a ON a."id" = d."account_id"
    WHERE a."user_id" <> d."user_id"
  ) THEN
    RAISE EXCEPTION 'Cannot add deposit account-owner FK: deposit_requests contains account/user ownership mismatches';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "foreign_currency_requests" f
    JOIN "accounts" a ON a."id" = f."account_id"
    WHERE a."user_id" <> f."user_id"
  ) THEN
    RAISE EXCEPTION 'Cannot add FX account-owner FK: foreign_currency_requests contains account/user ownership mismatches';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "journal_lines" jl
    JOIN "general_ledger_accounts" gla ON gla."id" = jl."account_id"
    WHERE gla."currency_code" <> jl."currency_code"
  ) THEN
    RAISE EXCEPTION 'Cannot add journal-line currency FK: journal_lines contains GL currency mismatches';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "deposit_reconciliation_records" r
    LEFT JOIN "users" u ON u."id" = r."performed_by_user_id"
    WHERE r."performed_by_user_id" IS NOT NULL AND u."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot add reconciliation actor FK: records contain unknown performed_by_user_id values';
  END IF;

  IF EXISTS (
    SELECT "key" FROM "idempotency_records"
    WHERE "user_id" IS NULL
    GROUP BY "key" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot add global idempotency unique index: duplicate keys exist for NULL user_id';
  END IF;
END $$;

ALTER TABLE "deposit_requests"
  DROP CONSTRAINT IF EXISTS "deposit_requests_account_id_fkey";
ALTER TABLE "foreign_currency_requests"
  DROP CONSTRAINT IF EXISTS "foreign_currency_requests_account_id_fkey";
ALTER TABLE "journal_lines"
  DROP CONSTRAINT IF EXISTS "journal_lines_account_id_fkey";

ALTER TABLE "deposit_requests"
  ADD CONSTRAINT "deposit_requests_account_id_user_id_fkey"
  FOREIGN KEY ("account_id", "user_id")
  REFERENCES "accounts"("id", "user_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "foreign_currency_requests"
  ADD CONSTRAINT "foreign_currency_requests_account_id_user_id_fkey"
  FOREIGN KEY ("account_id", "user_id")
  REFERENCES "accounts"("id", "user_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_account_id_currency_code_fkey"
  FOREIGN KEY ("account_id", "currency_code")
  REFERENCES "general_ledger_accounts"("id", "currency_code")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "deposit_reconciliation_records"
  ADD CONSTRAINT "deposit_reconciliation_records_performed_by_user_id_fkey"
  FOREIGN KEY ("performed_by_user_id")
  REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Prisma's composite unique allows multiple NULL user IDs in PostgreSQL.
-- Keep the nullable/system-level idempotency scope unique as well.
CREATE UNIQUE INDEX IF NOT EXISTS "idempotency_records_key_null_user_id_key"
  ON "idempotency_records"("key")
  WHERE "user_id" IS NULL;
