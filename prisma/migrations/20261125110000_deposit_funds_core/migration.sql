-- Deposit Funds core: request lifecycle, provider events, settlement, reconciliation and double-entry journal.
CREATE TYPE "DepositKind" AS ENUM ('EXTERNAL', 'DEMO');
CREATE TYPE "DepositStatus" AS ENUM ('INITIATED', 'PAYMENT_PENDING', 'PROCESSING', 'CONFIRMED', 'SETTLED', 'FAILED', 'EXPIRED', 'CANCELLED', 'REVERSED');
CREATE TYPE "DepositProviderPaymentStatus" AS ENUM ('CREATED', 'PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'CANCELLED', 'REFUNDED');
CREATE TYPE "DepositReconciliationStatus" AS ENUM ('MATCHED', 'UNMATCHED', 'MISMATCHED', 'REVIEW_REQUIRED');
CREATE TYPE "GeneralLedgerAccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE');
CREATE TYPE "JournalEntryStatus" AS ENUM ('POSTED', 'REVERSED');

CREATE TABLE "deposit_requests" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "account_id" UUID NOT NULL,
  "transaction_id" UUID,
  "provider" "PaymentProvider" NOT NULL,
  "kind" "DepositKind" NOT NULL DEFAULT 'EXTERNAL',
  "provider_reference" TEXT,
  "idempotency_key" TEXT,
  "amount" DECIMAL(24,8) NOT NULL,
  "fee" DECIMAL(24,8) NOT NULL DEFAULT 0,
  "net_amount" DECIMAL(24,8) NOT NULL,
  "currency_code" CHAR(3) NOT NULL,
  "status" "DepositStatus" NOT NULL DEFAULT 'INITIATED',
  "payment_url" TEXT,
  "provider_metadata" JSONB,
  "expires_at" TIMESTAMP(3),
  "paid_at" TIMESTAMP(3),
  "settled_at" TIMESTAMP(3),
  "reversed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "deposit_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "deposit_requests_amounts_check" CHECK ("amount" > 0 AND "fee" >= 0 AND "net_amount" > 0 AND "amount" = "fee" + "net_amount")
);
CREATE UNIQUE INDEX "deposit_requests_transaction_id_key" ON "deposit_requests"("transaction_id");
CREATE UNIQUE INDEX "deposit_requests_user_id_idempotency_key_key" ON "deposit_requests"("user_id", "idempotency_key");
CREATE UNIQUE INDEX "deposit_requests_provider_provider_reference_key" ON "deposit_requests"("provider", "provider_reference");
CREATE INDEX "deposit_requests_user_id_created_at_idx" ON "deposit_requests"("user_id", "created_at" DESC);
CREATE INDEX "deposit_requests_account_id_created_at_idx" ON "deposit_requests"("account_id", "created_at" DESC);
CREATE INDEX "deposit_requests_status_created_at_idx" ON "deposit_requests"("status", "created_at");
CREATE INDEX "deposit_requests_provider_status_idx" ON "deposit_requests"("provider", "status");
ALTER TABLE "deposit_requests" ADD CONSTRAINT "deposit_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deposit_requests" ADD CONSTRAINT "deposit_requests_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deposit_requests" ADD CONSTRAINT "deposit_requests_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "deposit_requests" ADD CONSTRAINT "deposit_requests_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "deposit_provider_payments" (
  "id" UUID NOT NULL,
  "deposit_request_id" UUID NOT NULL,
  "provider" "PaymentProvider" NOT NULL,
  "provider_payment_id" TEXT NOT NULL,
  "provider_reference" TEXT,
  "status" "DepositProviderPaymentStatus" NOT NULL DEFAULT 'CREATED',
  "amount" DECIMAL(24,8) NOT NULL,
  "currency_code" CHAR(3) NOT NULL,
  "request_payload_hash" TEXT,
  "response_metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "deposit_provider_payments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "deposit_provider_payments_amount_check" CHECK ("amount" > 0)
);
CREATE UNIQUE INDEX "deposit_provider_payments_provider_provider_payment_id_key" ON "deposit_provider_payments"("provider", "provider_payment_id");
CREATE INDEX "deposit_provider_payments_deposit_request_id_created_at_idx" ON "deposit_provider_payments"("deposit_request_id", "created_at");
CREATE INDEX "deposit_provider_payments_provider_status_idx" ON "deposit_provider_payments"("provider", "status");
ALTER TABLE "deposit_provider_payments" ADD CONSTRAINT "deposit_provider_payments_deposit_request_id_fkey" FOREIGN KEY ("deposit_request_id") REFERENCES "deposit_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "deposit_provider_payments" ADD CONSTRAINT "deposit_provider_payments_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "deposit_webhook_events" (
  "id" UUID NOT NULL,
  "provider" "PaymentProvider" NOT NULL,
  "event_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "payload_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'RECEIVED',
  "processed_at" TIMESTAMP(3),
  "error_message" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "deposit_webhook_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "deposit_webhook_events_provider_event_id_key" ON "deposit_webhook_events"("provider", "event_id");
CREATE INDEX "deposit_webhook_events_provider_status_created_at_idx" ON "deposit_webhook_events"("provider", "status", "created_at");

CREATE TABLE "deposit_provider_settlements" (
  "id" UUID NOT NULL,
  "deposit_request_id" UUID,
  "provider" "PaymentProvider" NOT NULL,
  "settlement_reference" TEXT NOT NULL,
  "provider_payment_id" TEXT NOT NULL,
  "amount" DECIMAL(24,8) NOT NULL,
  "currency_code" CHAR(3) NOT NULL,
  "status" "DepositProviderPaymentStatus" NOT NULL DEFAULT 'PENDING',
  "settled_at" TIMESTAMP(3),
  "metadata" JSONB,
  "reconciled_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "deposit_provider_settlements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "deposit_provider_settlements_amount_check" CHECK ("amount" > 0)
);
CREATE UNIQUE INDEX "deposit_provider_settlements_provider_settlement_reference_key" ON "deposit_provider_settlements"("provider", "settlement_reference");
CREATE INDEX "deposit_provider_settlements_provider_status_settled_at_idx" ON "deposit_provider_settlements"("provider", "status", "settled_at");
CREATE INDEX "deposit_provider_settlements_provider_payment_id_idx" ON "deposit_provider_settlements"("provider_payment_id");
ALTER TABLE "deposit_provider_settlements" ADD CONSTRAINT "deposit_provider_settlements_deposit_request_id_fkey" FOREIGN KEY ("deposit_request_id") REFERENCES "deposit_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "deposit_provider_settlements" ADD CONSTRAINT "deposit_provider_settlements_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "deposit_reconciliation_records" (
  "id" UUID NOT NULL,
  "deposit_request_id" UUID,
  "settlement_id" UUID,
  "provider" "PaymentProvider" NOT NULL,
  "status" "DepositReconciliationStatus" NOT NULL,
  "expected_amount" DECIMAL(24,8),
  "actual_amount" DECIMAL(24,8),
  "expected_currency" CHAR(3),
  "actual_currency" CHAR(3),
  "provider_reference" TEXT,
  "notes" TEXT,
  "performed_by_user_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "deposit_reconciliation_records_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "deposit_reconciliation_records_status_created_at_idx" ON "deposit_reconciliation_records"("status", "created_at");
CREATE INDEX "deposit_reconciliation_records_deposit_request_id_created_at_idx" ON "deposit_reconciliation_records"("deposit_request_id", "created_at");
ALTER TABLE "deposit_reconciliation_records" ADD CONSTRAINT "deposit_reconciliation_records_deposit_request_id_fkey" FOREIGN KEY ("deposit_request_id") REFERENCES "deposit_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "deposit_reconciliation_records" ADD CONSTRAINT "deposit_reconciliation_records_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "deposit_provider_settlements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "general_ledger_accounts" (
  "id" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "account_type" "GeneralLedgerAccountType" NOT NULL,
  "currency_code" CHAR(3) NOT NULL,
  "balance" DECIMAL(24,8) NOT NULL DEFAULT 0,
  "is_system" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "general_ledger_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "general_ledger_accounts_code_currency_code_key" ON "general_ledger_accounts"("code", "currency_code");
CREATE INDEX "general_ledger_accounts_account_type_currency_code_idx" ON "general_ledger_accounts"("account_type", "currency_code");
ALTER TABLE "general_ledger_accounts" ADD CONSTRAINT "general_ledger_accounts_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "journal_entries" (
  "id" UUID NOT NULL,
  "reference" TEXT NOT NULL,
  "transaction_id" UUID,
  "deposit_request_id" UUID,
  "description" TEXT NOT NULL,
  "status" "JournalEntryStatus" NOT NULL DEFAULT 'POSTED',
  "posted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "journal_entries_reference_key" ON "journal_entries"("reference");
CREATE INDEX "journal_entries_transaction_id_idx" ON "journal_entries"("transaction_id");
CREATE INDEX "journal_entries_deposit_request_id_created_at_idx" ON "journal_entries"("deposit_request_id", "created_at");
CREATE INDEX "journal_entries_status_posted_at_idx" ON "journal_entries"("status", "posted_at");
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_deposit_request_id_fkey" FOREIGN KEY ("deposit_request_id") REFERENCES "deposit_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "journal_lines" (
  "id" UUID NOT NULL,
  "journal_entry_id" UUID NOT NULL,
  "account_id" UUID NOT NULL,
  "currency_code" CHAR(3) NOT NULL,
  "debit" DECIMAL(24,8) NOT NULL DEFAULT 0,
  "credit" DECIMAL(24,8) NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "journal_lines_one_side_positive_check" CHECK (
    ("debit" >= 0 AND "credit" >= 0) AND
    (("debit" > 0 AND "credit" = 0) OR ("credit" > 0 AND "debit" = 0))
  )
);
CREATE INDEX "journal_lines_journal_entry_id_idx" ON "journal_lines"("journal_entry_id");
CREATE INDEX "journal_lines_account_id_currency_code_created_at_idx" ON "journal_lines"("account_id", "currency_code", "created_at");
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_journal_entry_id_fkey" FOREIGN KEY ("journal_entry_id") REFERENCES "journal_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "general_ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
