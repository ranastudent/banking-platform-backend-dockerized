# Authentication OTP workflow migration

## What changes

- New registrations are stored in `pending_registrations`; no row is inserted into
  `users` until the registration OTP is verified.
- Registration OTP hashes are stored in `pending_registration_otps`.
- Password reset requests send a six-digit email OTP stored as a hash in
  `password_reset_otps`.
- A successful password-reset OTP verification issues a short-lived, single-use
  reset token. The existing `password_reset_tokens` table is retained.
- The legacy `/api/v1/auth/forgot-password` endpoint is removed.
- Existing inactive users and their `email_verification_otps` are retained so
  previously started registrations can still be verified.
- Existing outstanding password-reset tokens are marked consumed by the
  migration. Historical rows are retained; this prevents an old token from
  bypassing the new OTP step.

## Apply safely

1. Back up the target PostgreSQL database.
2. Confirm `DATABASE_URL` points to the intended development/test database.
3. Review `migrations/20261120180000_authentication_otp_workflow/migration.sql`.
4. Apply with `npx prisma migrate deploy`.
5. Generate the client with `npx prisma generate`.
6. Run `npm run typecheck` and the focused OTP tests.

Do **not** use `prisma migrate reset` on a database containing banking data.
The migration adds three tables and updates only unconsumed password-reset
tokens; it does not drop or truncate existing tables or financial records.

## New API flow

### Registration

1. `POST /api/v1/auth/register` — `{ name, email, phone?, password }`
2. `POST /api/v1/auth/verify-email` — `{ email, otp }`

### Password reset

1. `POST /api/v1/auth/reset-password/request` — `{ email }`
2. `POST /api/v1/auth/reset-password/verify-otp` — `{ email, otp }`
3. `POST /api/v1/auth/reset-password` — `{ token, password }`

The reset token is returned only after OTP verification and is valid for 15
minutes. Password reset revokes active refresh tokens.
