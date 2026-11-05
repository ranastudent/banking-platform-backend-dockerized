/**
 * Phase 35.6 — PostgreSQL and Redis persistence validation.
 *
 * This script writes one uniquely identified probe into a dedicated schema
 * and one uniquely named Redis key, restarts ONLY the local Compose
 * postgres/redis services, verifies both values, then removes its own probe.
 *
 * It never truncates tables, resets a database, deletes volumes, or touches
 * application financial records.
 *
 * Run from the Dockerized backend project root:
 *   npm run test:phase35:persistence
 *
 * The npm script includes --confirm-restart because this test restarts the
 * PostgreSQL and Redis containers and briefly interrupts API/worker DB access.
 */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

const run = (
  args: string[],
  options: { allowFailure?: boolean; timeoutMs?: number } = {},
): CommandResult => {
  const result = spawnSync("docker", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeoutMs ?? 15_000,
  });

  const output = {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };

  if (result.error) {
    throw new Error(
      `Unable to execute Docker Compose. Ensure Docker Desktop is running and "docker" is on PATH. ${result.error.message}`,
    );
  }

  if (!options.allowFailure && output.status !== 0) {
    throw new Error(
      `Command failed: docker ${args.join(" ")}\n${output.stderr || output.stdout}`,
    );
  }

  return output;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const psql = (sql: string, allowFailure = false): CommandResult =>
  run(
    [
      "compose",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "banking_app",
      "-d",
      "banking_dev",
      "-v",
      "ON_ERROR_STOP=1",
      "-t",
      "-A",
      "-c",
      sql,
    ],
    { allowFailure, timeoutMs: 20_000 },
  );

const redisCli = (args: string[], allowFailure = false): CommandResult =>
  run(
    ["compose", "exec", "-T", "redis", "redis-cli", ...args],
    { allowFailure, timeoutMs: 15_000 },
  );

const waitForServices = async (): Promise<void> => {
  const deadline = Date.now() + 120_000;

  while (Date.now() < deadline) {
    const pg = run(
      [
        "compose",
        "exec",
        "-T",
        "postgres",
        "pg_isready",
        "-U",
        "banking_app",
        "-d",
        "banking_dev",
      ],
      { allowFailure: true, timeoutMs: 8_000 },
    );

    const redis = redisCli(["PING"], true);

    if (
      pg.status === 0 &&
      redis.status === 0 &&
      redis.stdout.trim() === "PONG"
    ) {
      return;
    }

    await delay(2_000);
  }

  throw new Error(
    "PostgreSQL and Redis did not become ready within 120 seconds after restart.",
  );
};

const main = async (): Promise<void> => {
  assert(
    process.argv.includes("--confirm-restart"),
    'Safety stop: this test restarts the "postgres" and "redis" Docker Compose services. Run it only when you intend to restart them.',
  );

  const composeFile = run(["compose", "config", "--services"]);
  const services = composeFile.stdout.split(/\r?\n/).map((item) => item.trim());

  assert(
    services.includes("postgres") && services.includes("redis"),
    'Expected Docker Compose services "postgres" and "redis" were not found. Run this command from the Dockerized backend project root.',
  );

  const running = run([
    "compose",
    "ps",
    "--services",
    "--status",
    "running",
  ]);
  const runningServices = running.stdout
    .split(/\r?\n/)
    .map((item) => item.trim());

  assert(
    runningServices.includes("postgres") && runningServices.includes("redis"),
    "Both postgres and redis services must already be running. Start the Dockerized backend first.",
  );

  const actualDatabase = psql("SELECT current_database();").stdout.trim();
  assert(
    actualDatabase === "banking_dev",
    `Safety stop: expected the local Docker database "banking_dev", but connected to "${actualDatabase}".`,
  );

  const appendOnly = redisCli(["CONFIG", "GET", "appendonly"]).stdout
    .split(/\r?\n/)
    .map((item) => item.trim().toLowerCase());
  assert(
    appendOnly.includes("yes"),
    'Redis append-only persistence is not enabled. Expected redis-server "--appendonly yes".',
  );

  const probeId = randomUUID();
  const payload = `phase35-persistence-${probeId}`;
  const redisKey = `phase35:persistence:${probeId}`;

  try {
    console.log("Phase 35.6 — Persistence Testing");
    console.log("Target: local Docker Compose postgres + redis services");
    console.log("Safety: database name verified as banking_dev; no financial rows will be changed.");

    psql(
      "CREATE SCHEMA IF NOT EXISTS phase35_validation; " +
        "CREATE TABLE IF NOT EXISTS phase35_validation.persistence_probe (" +
        "probe_id uuid PRIMARY KEY, payload text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()" +
        ");",
    );

    psql(
      `INSERT INTO phase35_validation.persistence_probe (probe_id, payload) ` +
        `VALUES ('${probeId}', '${payload}') ON CONFLICT (probe_id) DO UPDATE SET payload = EXCLUDED.payload;`,
    );

    const beforeRestartDb = psql(
      `SELECT payload FROM phase35_validation.persistence_probe WHERE probe_id = '${probeId}';`,
    ).stdout.trim();
    assert(beforeRestartDb === payload, "PostgreSQL probe could not be read before restart.");
    console.log("PASS — PostgreSQL probe written and readable before restart.");

    const redisSet = redisCli(["SET", redisKey, payload, "EX", "3600"]);
    assert(redisSet.stdout.trim() === "OK", "Redis did not confirm the persistence probe write.");

    const beforeRestartRedis = redisCli(["GET", redisKey]).stdout.trim();
    assert(beforeRestartRedis === payload, "Redis probe could not be read before restart.");
    console.log("PASS — Redis probe written and readable before restart.");

    console.log("Restarting only postgres and redis services...");
    run(["compose", "restart", "postgres", "redis"], { timeoutMs: 60_000 });
    await waitForServices();

    const afterRestartDb = psql(
      `SELECT payload FROM phase35_validation.persistence_probe WHERE probe_id = '${probeId}';`,
    ).stdout.trim();
    assert(
      afterRestartDb === payload,
      "FAIL — PostgreSQL probe did not survive the container restart.",
    );
    console.log("PASS — PostgreSQL data survived container restart.");

    const afterRestartRedis = redisCli(["GET", redisKey]).stdout.trim();
    assert(
      afterRestartRedis === payload,
      "FAIL — Redis probe did not survive the container restart.",
    );
    console.log("PASS — Redis data survived container restart.");

  } finally {
    // Remove only this run's unique probe, even when a restart or assertion fails.
    // The diagnostic table/schema are kept for subsequent runs.
    psql(
      `DELETE FROM phase35_validation.persistence_probe WHERE probe_id = '${probeId}';`,
      true,
    );
    redisCli(["DEL", redisKey], true);
  }

  console.log("----------------------------------------");
  console.log("Phase 35.6: PASS");
  console.log("PostgreSQL persistence: PASS");
  console.log("Redis persistence: PASS");
  console.log("Probe records: cleaned up");
};

main().catch((error: unknown) => {
  console.error("----------------------------------------");
  console.error("Phase 35.6: FAIL");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
