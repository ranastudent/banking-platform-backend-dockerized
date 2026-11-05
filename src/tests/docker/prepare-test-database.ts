/**
 * Load the dedicated .env.test file, verify its target is the isolated Docker
 * test database, then invoke the installed Prisma CLI.
 */
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const envPath = resolve(process.cwd(), ".env.test");
const loaded = loadEnv({ path: envPath, override: true });
if (loaded.error) {
  throw new Error(`Unable to load .env.test: ${loaded.error.message}`);
}

const rawUrl = process.env.DATABASE_URL;
if (!rawUrl) throw new Error("DATABASE_URL is missing from .env.test");
const url = new URL(rawUrl);
const expectedHost = process.env.TEST_DATABASE_HOST ?? "127.0.0.1";
const expectedName = process.env.TEST_DATABASE_NAME ?? "banking_test";
if (url.hostname !== expectedHost || url.port !== "5434" || url.pathname.replace(/^\//, "") !== expectedName) {
  throw new Error(
    `Safety stop: test migrations must target ${expectedHost}:5434/${expectedName}; received ${url.hostname}:${url.port}${url.pathname}.`,
  );
}

console.log(`Applying Prisma migrations to isolated test database ${expectedHost}:5434/${expectedName}...`);
const result = spawnSync("npx", ["prisma", "migrate", "deploy"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
  shell: process.platform === "win32",
  windowsHide: true,
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log("Test database migrations: PASS");
