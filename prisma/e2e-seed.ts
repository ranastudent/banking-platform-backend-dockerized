import "dotenv/config";
import bcrypt from "bcrypt";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

/**
 * E2E-only seed.
 *
 * Safety rules:
 * - NODE_ENV must be "test".
 * - The configured database must match TEST_DATABASE_NAME.
 * - The database name must clearly be a test database.
 * - The database and Redis hosts must be the explicitly approved test hosts.
 * - No production database host is accepted.
 *
 * This script is idempotent: running it repeatedly updates the same test users
 * and reuses the same accounts, balances, beneficiary, and notification.
 */

function assertE2eEnvironment(): void {
  if (process.env.NODE_ENV?.trim() !== "test") {
    throw new Error(
      'Refusing to run E2E seed: NODE_ENV must be exactly "test".',
    );
  }

  const databaseUrlValue = process.env.DATABASE_URL?.trim();
  const redisUrlValue = process.env.REDIS_URL?.trim();
  if (!databaseUrlValue || !redisUrlValue) {
    throw new Error("Refusing to run E2E seed: DATABASE_URL and REDIS_URL are required.");
  }
  const databaseUrl = new URL(databaseUrlValue);
  const redisUrl = new URL(redisUrlValue);

  const expectedDatabaseName = process.env.TEST_DATABASE_NAME?.trim();
  const expectedDatabaseHost = process.env.TEST_DATABASE_HOST?.trim().toLowerCase();
  const expectedRedisHost = process.env.TEST_REDIS_HOST?.trim().toLowerCase();
  const productionDatabaseHost = process.env.PRODUCTION_DATABASE_HOST?.trim().toLowerCase();
  const productionRedisHost = process.env.PRODUCTION_REDIS_HOST?.trim().toLowerCase();

  if (
    !expectedDatabaseName ||
    !expectedDatabaseHost ||
    !expectedRedisHost ||
    !productionDatabaseHost ||
    !productionRedisHost
  ) {
    throw new Error(
      "Refusing to run E2E seed: test and production host guard variables are required.",
    );
  }

  const actualDatabaseName = decodeURIComponent(
    databaseUrl.pathname.replace(/^\//, ""),
  );

  const allowedDatabaseHosts = new Set([
    "localhost",
    "127.0.0.1",
    "test-postgres",
  ]);
  const allowedRedisHosts = new Set([
    "localhost",
    "127.0.0.1",
    "test-redis",
  ]);

  if (
    actualDatabaseName !== expectedDatabaseName ||
    !actualDatabaseName.toLowerCase().includes("test")
  ) {
    throw new Error(
      `Refusing to run E2E seed: database "${actualDatabaseName}" is not the configured test database.`,
    );
  }

  if (
    databaseUrl.hostname.toLowerCase() !== expectedDatabaseHost ||
    !allowedDatabaseHosts.has(databaseUrl.hostname.toLowerCase()) ||
    expectedDatabaseHost === productionDatabaseHost
  ) {
    throw new Error("Refusing to run E2E seed: unsafe PostgreSQL host configuration.");
  }

  if (
    redisUrl.hostname.toLowerCase() !== expectedRedisHost ||
    !allowedRedisHosts.has(redisUrl.hostname.toLowerCase()) ||
    expectedRedisHost === productionRedisHost
  ) {
    throw new Error("Refusing to run E2E seed: unsafe Redis host configuration.");
  }

  if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)) {
    throw new Error("Refusing to run E2E seed: unsupported database protocol.");
  }

  if (!["redis:", "rediss:"].includes(redisUrl.protocol)) {
    throw new Error("Refusing to run E2E seed: unsupported Redis protocol.");
  }
}

assertE2eEnvironment();

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!.trim(),
});

const prisma = new PrismaClient({ adapter });

const sharedTestPassword = process.env.E2E_TEST_PASSWORD?.trim();

const TEST_USERS = [
  {
    name: "E2E Customer",
    email: process.env.E2E_CUSTOMER_EMAIL?.trim() || "testuser5@example.test",
    password:
      process.env.E2E_CUSTOMER_PASSWORD?.trim() || sharedTestPassword,
    role: "CUSTOMER" as const,
  },
  {
    name: "E2E Administrator",
    email: process.env.E2E_ADMIN_EMAIL?.trim() || "e2e-admin@example.test",
    password:
      process.env.E2E_ADMIN_PASSWORD?.trim() || sharedTestPassword,
    role: "ADMIN" as const,
  },
  {
    name: "E2E Support Agent",
    email: process.env.E2E_SUPPORT_EMAIL?.trim() || "e2e-support@example.test",
    password:
      process.env.E2E_SUPPORT_PASSWORD?.trim() || sharedTestPassword,
    role: "SUPPORT" as const,
  },
  {
    name: "E2E Auditor",
    email: process.env.E2E_AUDITOR_EMAIL?.trim() || "e2e-auditor@example.test",
    password:
      process.env.E2E_AUDITOR_PASSWORD?.trim() || sharedTestPassword,
    role: "AUDITOR" as const,
  },
];

for (const user of TEST_USERS) {
  if (!user.password || user.password.length < 12) {
    throw new Error(
      `A test password of at least 12 characters is required for ${user.role}. Set its E2E_${user.role}_PASSWORD or E2E_TEST_PASSWORD.`,
    );
  }
}

const currencies = [
  { code: "BDT", name: "Bangladeshi Taka", symbol: "৳", decimalPlaces: 2 },
  { code: "USD", name: "United States Dollar", symbol: "$", decimalPlaces: 2 },
  { code: "EUR", name: "Euro", symbol: "€", decimalPlaces: 2 },
  { code: "GBP", name: "British Pound", symbol: "£", decimalPlaces: 2 },
  { code: "JPY", name: "Japanese Yen", symbol: "¥", decimalPlaces: 0 },
] as const;

async function main(): Promise<void> {
  console.log("Starting isolated E2E database seed...");

  for (const currency of currencies) {
    await prisma.currency.upsert({
      where: { code: currency.code },
      update: {
        name: currency.name,
        symbol: currency.symbol,
        decimalPlaces: currency.decimalPlaces,
        isActive: true,
      },
      create: {
        ...currency,
        isActive: true,
      },
    });

    // Ensure each test currency has a reserve row without resetting balances.
    await prisma.currencyReserve.upsert({
      where: { currencyCode: currency.code },
      update: {},
      create: {
        currencyCode: currency.code,
        availableReserve: "0",
        lockedReserve: "0",
        minimumReserve: "0",
      },
    });
  }

  const users = new Map<string, { id: string; email: string; role: string }>();

  for (const fixture of TEST_USERS) {
    const passwordHash = await bcrypt.hash(fixture.password!, 12);
    const user = await prisma.user.upsert({
      where: { email: fixture.email },
      update: {
        name: fixture.name,
        passwordHash,
        role: fixture.role,
        status: "ACTIVE",
        emailVerifiedAt: new Date(),
      },
      create: {
        name: fixture.name,
        email: fixture.email,
        passwordHash,
        role: fixture.role,
        status: "ACTIVE",
        emailVerifiedAt: new Date(),
      },
      select: {
        id: true,
        email: true,
        role: true,
      },
    });

    users.set(fixture.role, user);
    console.log(`Prepared ${fixture.role}: ${fixture.email}`);
  }

  const customer = users.get("CUSTOMER");
  if (!customer) {
    throw new Error("E2E customer fixture was not created.");
  }

  // Stable account numbers make this seed repeatable and easy to inspect.
  const accountFixtures = [
    {
      accountNumber: "E2E-BDT-00000001",
      accountType: "SAVINGS" as const,
      currencyCode: "BDT",
      availableBalance: "100000.00",
    },
    {
      accountNumber: "E2E-BDT-00000002",
      accountType: "CURRENT" as const,
      currencyCode: "BDT",
      availableBalance: "25000.00",
    },
  ];

  const accounts: Array<{ id: string; accountNumber: string }> = [];

  for (const fixture of accountFixtures) {
    const account = await prisma.account.upsert({
      where: { accountNumber: fixture.accountNumber },
      update: {
        userId: customer.id,
        accountType: fixture.accountType,
        status: "ACTIVE",
      },
      create: {
        userId: customer.id,
        accountNumber: fixture.accountNumber,
        accountType: fixture.accountType,
        status: "ACTIVE",
      },
      select: { id: true, accountNumber: true },
    });

    await prisma.accountBalance.upsert({
      where: {
        accountId_currencyCode: {
          accountId: account.id,
          currencyCode: fixture.currencyCode,
        },
      },
      update: {
        availableBalance: fixture.availableBalance,
        lockedBalance: "0",
      },
      create: {
        accountId: account.id,
        currencyCode: fixture.currencyCode,
        availableBalance: fixture.availableBalance,
        lockedBalance: "0",
      },
    });

    accounts.push(account);
  }

  // This beneficiary is an internal test fixture pointing to the customer's
  // second test account. It is not a real external payee.
  await prisma.beneficiary.upsert({
    where: { id: "00000000-0000-4000-8000-000000000501" },
    update: {
      userId: customer.id,
      beneficiaryType: "INTERNAL",
      displayName: "E2E Test Internal Account",
      accountReference: accounts[1].accountNumber,
      provider: "INTERNAL",
      currencyCode: "BDT",
      status: "ACTIVE",
    },
    create: {
      id: "00000000-0000-4000-8000-000000000501",
      userId: customer.id,
      beneficiaryType: "INTERNAL",
      displayName: "E2E Test Internal Account",
      accountReference: accounts[1].accountNumber,
      provider: "INTERNAL",
      currencyCode: "BDT",
      status: "ACTIVE",
    },
  });

  await prisma.notification.upsert({
    where: { dedupeKey: "e2e-customer-welcome-notification" },
    update: {
      userId: customer.id,
      type: "SYSTEM",
      title: "E2E test notification",
      message: "This notification is seeded for browser testing only.",
      channel: "IN_APP",
      status: "SENT",
    },
    create: {
      userId: customer.id,
      type: "SYSTEM",
      title: "E2E test notification",
      message: "This notification is seeded for browser testing only.",
      channel: "IN_APP",
      status: "SENT",
      dedupeKey: "e2e-customer-welcome-notification",
    },
  });

  console.log("E2E seed completed.");
  console.log(`Customer: ${customer.email}`);
  console.log(`Customer accounts: ${accounts.map((a) => a.accountNumber).join(", ")}`);
  console.log("Starting balances are synthetic test fixtures; no ledger transactions were fabricated.");
}

main()
  .catch((error: unknown) => {
    console.error("E2E seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
