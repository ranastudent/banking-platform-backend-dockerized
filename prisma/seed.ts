import "dotenv/config";
import bcrypt from "bcrypt";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { env } from "../src/config/env";

/**
 * Explicit Docker-development seed.
 *
 * Creates the five supported currencies and the configured ADMIN, SUPPORT,
 * and AUDITOR accounts. No API endpoint or API contract is changed.
 *
 * New-customer demo balances are granted by the existing OTP-verification
 * workflow, not by this seed script.
 */

const assertDevelopmentDatabase = (): void => {
  const nodeEnv = process.env.NODE_ENV?.trim() || "development";
  const dockerized = process.env.DOCKERIZED?.trim().toLowerCase();
  const databaseUrl = new URL(env.databaseUrl);
  const databaseName = decodeURIComponent(databaseUrl.pathname.replace(/^\//, ""));

  if (nodeEnv !== "development" || dockerized !== "true") {
    throw new Error(
      'Refusing to run development seed: NODE_ENV must be "development" and DOCKERIZED must be "true".',
    );
  }

  if (
    !["postgres:", "postgresql:"].includes(databaseUrl.protocol) ||
    databaseUrl.hostname !== "postgres" ||
    databaseName !== "banking_dev"
  ) {
    throw new Error(
      'Refusing to run development seed: DATABASE_URL must target Docker service "postgres" and database "banking_dev".',
    );
  }
};

const requiredValue = (key: string): string => {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
};

const roleAccounts = [
  {
    name: "System Administrator",
    email: env.defaultAdminEmail.toLowerCase(),
    password: env.defaultAdminPassword,
    role: "ADMIN" as const,
  },
  {
    name: "Default Support Agent",
    email: requiredValue("DEFAULT_SUPPORT_EMAIL").toLowerCase(),
    password: requiredValue("DEFAULT_SUPPORT_PASSWORD"),
    role: "SUPPORT" as const,
  },
  {
    name: "Default Auditor",
    email: requiredValue("DEFAULT_AUDITOR_EMAIL").toLowerCase(),
    password: requiredValue("DEFAULT_AUDITOR_PASSWORD"),
    role: "AUDITOR" as const,
  },
] as const;

const currencies = [
  { code: "BDT", name: "Bangladeshi Taka", symbol: "৳", decimalPlaces: 2 },
  { code: "USD", name: "United States Dollar", symbol: "$", decimalPlaces: 2 },
  { code: "EUR", name: "Euro", symbol: "€", decimalPlaces: 2 },
  { code: "GBP", name: "British Pound", symbol: "£", decimalPlaces: 2 },
  { code: "JPY", name: "Japanese Yen", symbol: "¥", decimalPlaces: 0 },
] as const;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.databaseUrl }),
});

async function main(): Promise<void> {
  assertDevelopmentDatabase();

  for (const account of roleAccounts) {
    if (account.password.length < 12) {
      throw new Error(`${account.role} password must contain at least 12 characters.`);
    }
  }

  console.log("Starting Docker development seed...");

  // Important: bcrypt is CPU-intensive. Hash passwords BEFORE opening the
  // interactive transaction so hashing does not consume Prisma's transaction
  // timeout window.
  const preparedAccounts = await Promise.all(
    roleAccounts.map(async (account) => ({
      ...account,
      passwordHash: await bcrypt.hash(account.password, 12),
    })),
  );

  await prisma.$transaction(
    async (tx) => {
      for (const currency of currencies) {
        await tx.currency.upsert({
          where: { code: currency.code },
          update: {
            name: currency.name,
            symbol: currency.symbol,
            decimalPlaces: currency.decimalPlaces,
            isActive: true,
          },
          create: { ...currency, isActive: true },
        });
      }

      for (const account of preparedAccounts) {
        await tx.user.upsert({
          where: { email: account.email },
          update: {
            name: account.name,
            passwordHash: account.passwordHash,
            role: account.role,
            status: "ACTIVE",
            emailVerifiedAt: new Date(),
          },
          create: {
            name: account.name,
            email: account.email,
            passwordHash: account.passwordHash,
            role: account.role,
            status: "ACTIVE",
            emailVerifiedAt: new Date(),
          },
        });

        console.log(`Prepared ${account.role} account: ${account.email}`);
      }
    },
    {
      maxWait: 10_000,
      timeout: 30_000,
    },
  );

  console.log("Five currencies seeded successfully.");
  console.log("ADMIN, SUPPORT, and AUDITOR development accounts are ready.");
  console.log("Development seed completed.");
}

main()
  .catch((error: unknown) => {
    console.error("Development seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
