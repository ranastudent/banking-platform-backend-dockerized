import { registerDepositProviderAdapter } from "./provider.registry";
import { bkashAdapter } from "./adapters/bkash.adapter";
import { wiseAdapter } from "./adapters/wise.adapter";
import { stripeAdapter } from "./adapters/stripe.adapter";
import { createMockDepositAdapters } from "./adapters/mock.adapter";

/**
 * Development default is a virtual provider simulator. It never calls provider
 * APIs and never moves real money. Real/sandbox adapters are registered only
 * when the operator explicitly selects the provider mode and supplies access.
 */
export const registerConfiguredDepositAdapters = (): void => {
  const has = (...keys: string[]) => keys.every((key) => Boolean(process.env[key]?.trim()));
  const mode = (process.env.PAYMENT_PROVIDER_MODE || "mock").trim().toLowerCase();
  const simulatorEnabled = (process.env.PAYMENT_SIMULATOR_ENABLED || "true").toLowerCase() === "true";
  const isProduction = (process.env.NODE_ENV || "development") === "production";

  if (mode === "mock" && simulatorEnabled && !isProduction) {
    for (const adapter of createMockDepositAdapters()) registerDepositProviderAdapter(adapter);
    return;
  }

  if (mode === "sandbox" || mode === "production") {
    if (has("BKASH_APP_KEY", "BKASH_APP_SECRET", "BKASH_USERNAME", "BKASH_PASSWORD", "BKASH_CALLBACK_URL")) {
      registerDepositProviderAdapter(bkashAdapter);
    }
    if (has("WISE_WEBHOOK_SECRET", "WISE_INCOMING_PAYMENT_INSTRUCTIONS") &&
        (has("WISE_ACCESS_TOKEN") || has("WISE_CLIENT_ID", "WISE_CLIENT_SECRET"))) {
      registerDepositProviderAdapter(wiseAdapter);
    }
    // Stripe Checkout (card payments) requires a Stripe test/live secret key,
    // webhook signing secret, and HTTPS return URLs.
    if (has("STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_SUCCESS_URL", "STRIPE_CANCEL_URL")) {
      const stripeKey = process.env.STRIPE_SECRET_KEY!.trim();
      const expectedPrefix = mode === "sandbox" ? "sk_test_" : "sk_live_";
      if (!stripeKey.startsWith(expectedPrefix)) {
        throw new Error(`Stripe key does not match PAYMENT_PROVIDER_MODE=${mode}; expected ${expectedPrefix}...`);
      }
      registerDepositProviderAdapter(stripeAdapter);
    }
  }
};
