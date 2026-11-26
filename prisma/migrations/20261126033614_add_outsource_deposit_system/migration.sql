-- AlterEnum
ALTER TYPE "TransactionProvider" ADD VALUE 'STRIPE';

-- RenameIndex
ALTER INDEX "deposit_reconciliation_records_deposit_request_id_created_at_id" RENAME TO "deposit_reconciliation_records_deposit_request_id_created_a_idx";

-- RenameIndex
ALTER INDEX "pending_registration_otps_pending_registration_id_created_at_id" RENAME TO "pending_registration_otps_pending_registration_id_created_a_idx";
