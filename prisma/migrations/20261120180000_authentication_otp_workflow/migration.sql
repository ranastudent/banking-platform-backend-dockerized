-- Add isolated pending-registration and password-reset OTP storage.
-- Existing users, legacy email verification OTPs, and password reset tokens are preserved.

CREATE TABLE "pending_registrations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "password_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pending_registrations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pending_registrations_email_key"
    ON "pending_registrations"("email");
CREATE UNIQUE INDEX "pending_registrations_phone_key"
    ON "pending_registrations"("phone");
CREATE INDEX "pending_registrations_expires_at_idx"
    ON "pending_registrations"("expires_at");

CREATE TABLE "pending_registration_otps" (
    "id" UUID NOT NULL,
    "pending_registration_id" UUID NOT NULL,
    "otp_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_registration_otps_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "pending_registration_otps_pending_registration_id_fkey"
      FOREIGN KEY ("pending_registration_id")
      REFERENCES "pending_registrations"("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "pending_registration_otps_pending_registration_id_created_at_idx"
    ON "pending_registration_otps"("pending_registration_id", "created_at");
CREATE INDEX "pending_registration_otps_expires_at_idx"
    ON "pending_registration_otps"("expires_at");

CREATE TABLE "password_reset_otps" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "otp_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "verified_at" TIMESTAMP(3),
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_otps_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "password_reset_otps_user_id_fkey"
      FOREIGN KEY ("user_id")
      REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "password_reset_otps_user_id_consumed_at_created_at_idx"
    ON "password_reset_otps"("user_id", "consumed_at", "created_at");
CREATE INDEX "password_reset_otps_expires_at_idx"
    ON "password_reset_otps"("expires_at");

-- Invalidate outstanding legacy password-reset links so every new password
-- change must pass the new email OTP verification flow. Historical rows remain.
UPDATE "password_reset_tokens"
SET "consumed_at" = CURRENT_TIMESTAMP
WHERE "consumed_at" IS NULL;
