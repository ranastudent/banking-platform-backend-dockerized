import { createHmac, timingSafeEqual } from "node:crypto";
import type { PaymentProvider } from "@prisma/client";
import { AppError } from "../../errors/AppError";
import { ErrorCode } from "../../errors/errorCodes";
import type { DepositProviderAdapter } from "../types/deposit.types";
import { EXTERNAL_DEPOSIT_PROVIDERS } from "../types/deposit.types";

/**
 * Provider-specific payment initiation is deliberately fail-closed.
 * Do not pretend to charge a wallet when its merchant API adapter and credentials
 * have not been configured. Provider APIs differ and must be implemented against
 * the contracted provider's current documentation.
 */
const adapters = new Map<PaymentProvider, DepositProviderAdapter>();

export const registerDepositProviderAdapter = (adapter: DepositProviderAdapter): void => {
  if (!EXTERNAL_DEPOSIT_PROVIDERS.includes(adapter.provider)) {
    throw new Error(`Unsupported deposit provider: ${adapter.provider}`);
  }
  adapters.set(adapter.provider, adapter);
};

export const hasDepositProviderAdapter = (provider: PaymentProvider): boolean => adapters.has(provider);

/** Remove an adapter, primarily for isolated integration tests and controlled reconfiguration. */
export const unregisterDepositProviderAdapter = (provider: PaymentProvider): void => {
  adapters.delete(provider);
};

export const getDepositProviderAdapter = (provider: PaymentProvider): DepositProviderAdapter => {
  const adapter = adapters.get(provider);
  if (!adapter) {
    throw new AppError(
      `${provider} payment integration is not configured. External deposits are disabled for this provider.`,
      503,
      ErrorCode.SERVICE_UNAVAILABLE,
    );
  }
  return adapter;
};

const providerSecret = (provider: PaymentProvider): string | undefined => {
  const key = `DEPOSIT_PROVIDER_${provider}_WEBHOOK_SECRET`;
  const value = process.env[key]?.trim();
  return value || undefined;
};

/**
 * Generic HMAC-SHA256 adapter helper. A real provider adapter must map the
 * provider's exact signature scheme, headers, canonical payload and status
 * semantics before registration. This helper alone is not provider approval.
 */
export const verifyGenericHmac = (
  provider: PaymentProvider,
  rawBody: string,
  signature: string | undefined,
): boolean => {
  const secret = providerSecret(provider);
  if (!secret || !signature) return false;
  const supplied = signature.replace(/^sha256=/i, "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(supplied)) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  const actual = Buffer.from(supplied, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

export const normalizeProviderSlug = (slug: string): PaymentProvider | null => {
  const provider = slug.trim().toUpperCase() as PaymentProvider;
  return EXTERNAL_DEPOSIT_PROVIDERS.includes(provider) ? provider : null;
};
