# Mobile Wallet + Stripe Card Payment Setup

This patch adds Stripe Checkout as the card-payment adapter and exposes payment-method metadata for the existing mobile-wallet options.

## Methods

- bKash: existing provider adapter; can use bKash sandbox credentials.
- Nagad and Rocket: available in the local mock simulator. Their real merchant sandbox/live adapters are not implemented in this patch because their API credentials, signing rules and onboarding documentation are provider-issued.
- Stripe: Checkout Session adapter for Visa/Mastercard credit and debit cards. Card network and credit/debit type are detected by Stripe/card issuer; do not collect or store card PAN/CVC in your app.

## A. Local simulator (no real money)

1. Copy `.env.example` values into your local `.env` (do not replace your existing database/auth variables).
2. Set:

```env
NODE_ENV=development
DEPOSIT_EXTERNAL_ENABLED=true
PAYMENT_PROVIDER_MODE=mock
PAYMENT_SIMULATOR_ENABLED=true
```

3. Restart backend. `GET /api/v1/deposits/methods` lists enabled mock methods.
4. Create a deposit with `POST /api/v1/deposits`, provider `BKASH`, `NAGAD`, `ROCKET`, or `STRIPE`, and an `Idempotency-Key` header.
5. Complete a simulated deposit:

```http
POST /api/v1/deposits/simulator/STRIPE/{depositId}/complete
Authorization: Bearer <your-test-token>
Content-Type: application/json

{"outcome":"success"}
```

Use `failed` or `cancelled` to test those outcomes. This endpoint is development-only and does not charge a card or mobile wallet.

## B. Stripe test mode (real Stripe test API, no real charge)

1. Create/activate a Stripe account in a Stripe-supported business country. Bangladesh-based businesses cannot currently open a standard Stripe Payments account directly; do not use false address/business information. Confirm eligibility and legal entity/bank requirements with Stripe.
2. In Stripe Dashboard, switch to **Test mode** and copy the test secret key (`sk_test_...`). Never use `sk_live_...` during development.
3. Install and sign in to Stripe CLI, then forward Stripe events to your local endpoint:

```bash
stripe login
stripe listen --forward-to localhost:5000/api/v1/deposits/webhooks/stripe
```

Copy the CLI webhook signing secret (`whsec_...`) printed by `stripe listen`. It is separate from the API secret key.
4. Set these in `.env`:

```env
PAYMENT_PROVIDER_MODE=sandbox
PAYMENT_SIMULATOR_ENABLED=false
DEPOSIT_EXTERNAL_ENABLED=true
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_SUCCESS_URL=http://localhost:5173/customer/deposit?session_id={CHECKOUT_SESSION_ID}
STRIPE_CANCEL_URL=http://localhost:5173/customer/deposit?stripe_cancelled=1
```

These local URLs return the browser to the frontend deposit page on port 5173. For deployed UAT/production, replace `localhost:5173` with your actual frontend origin and use HTTPS. Keep the `{CHECKOUT_SESSION_ID}` placeholder exactly as documented. Do not leave `your-frontend.example` in either value: the backend now rejects example hostnames before creating a Checkout Session.
5. Restart backend. `GET /api/v1/deposits/methods` should show Stripe as `CONFIGURED`.
6. Create a `STRIPE` deposit. The API response contains a `paymentUrl`; redirect the customer to that Stripe-hosted Checkout page.
7. Test successful, declined, and 3D Secure test cards from Stripe's official testing guide. Do not use real card data in test mode.
8. Confirm webhook delivery and verify that only a server-verified paid Checkout Session settles/credits the deposit.

## C. bKash sandbox

Set `PAYMENT_PROVIDER_MODE=sandbox`, add the bKash sandbox app key, app secret, username, password and callback URL, then test the bKash adapter with the official sandbox. The successful return callback must call Query Payment and then Execute Payment for an initiated payment; cancellation/failure callbacks must not execute it. Confirm the returned amount, currency and merchant invoice number before ledger settlement. Do not mix mock mode and provider sandbox mode.

## D. Production readiness

- Obtain provider approval and use live credentials only after UAT and legal/compliance review.
- Use a secret manager or deployment environment, not committed `.env` files.
- Ensure webhook endpoint is HTTPS and verify the exact provider signature.
- Configure Stripe Dashboard webhook events including `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, and `checkout.session.async_payment_failed` as applicable.
- Confirm payment amount/currency, merchant reference, idempotency and reconciliation before crediting accounts.
- Stripe is not a bank or card network; it is the processor. Visa/Mastercard credit/debit are presented through Stripe Checkout.
- Real bKash/Nagad/Rocket acceptance requires each provider's merchant onboarding and approved API integration. Local mock options do not indicate live-provider readiness.

## API response for UI

`GET /api/v1/deposits/methods` returns `displayName`, `category`, `enabled`, and provider status. For Stripe it also returns supported display options `VISA`, `MASTERCARD`, `CREDIT`, and `DEBIT`. The card brand/type is determined after the customer enters card details on Stripe-hosted Checkout; these are not separately selectable rails.
