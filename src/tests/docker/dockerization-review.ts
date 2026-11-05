/**
 * Phase 35.7 — Dockerization configuration review.
 *
 * Run from the Dockerized backend project root:
 *   npm run docker:review
 *
 * This is a static/configuration review. It does not claim that an image has
 * been penetration-tested or that the deployment is production-certified.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

type CheckState = "PASS" | "WARN" | "FAIL";
type Check = { state: CheckState; label: string; detail: string };

const checks: Check[] = [];

const add = (state: CheckState, label: string, detail: string): void => {
  checks.push({ state, label, detail });
};

const runDockerComposeConfig = (): Record<string, any> => {
  const result = spawnSync("docker", ["compose", "config", "--format", "json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
  });

  if (result.error) {
    throw new Error(`Docker Compose could not be executed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "docker compose config failed");
  }

  return JSON.parse(result.stdout) as Record<string, any>;
};

const includesText = (value: unknown, needle: string): boolean =>
  JSON.stringify(value ?? "").toLowerCase().includes(needle.toLowerCase());

const main = (): void => {
  const dockerfile = readFileSync("Dockerfile", "utf8");
  const dockerignore = readFileSync(".dockerignore", "utf8");
  const compose = runDockerComposeConfig();
  const services = compose.services ?? {};
  const volumes = compose.volumes ?? {};

  const postgres = services.postgres;
  const redis = services.redis;
  const backend = services.backend;
  const worker = services.worker;
  const mailpit = services.mailpit;

  add(
    "PASS",
    "Docker Compose configuration",
    "docker compose config parsed successfully.",
  );

  const postgresVolumes = JSON.stringify(postgres?.volumes ?? []);
  const postgresHasVolume =
    postgresVolumes.includes("banking_postgres_data") ||
    Object.values(postgres?.volumes ?? {}).some((item: any) =>
      String(item?.source ?? "").includes("banking_postgres_data"),
    );
  add(
    postgres && postgresHasVolume && Boolean(postgres.healthcheck) && postgres.restart === "unless-stopped"
      ? "PASS"
      : "FAIL",
    "PostgreSQL durability and health",
    "Requires a persistent named volume, healthcheck, and unless-stopped restart policy.",
  );

  const redisCommand = JSON.stringify(redis?.command ?? []);
  const redisVolumes = JSON.stringify(redis?.volumes ?? []);
  const redisHasVolume =
    redisVolumes.includes("banking_redis_data") ||
    Object.values(redis?.volumes ?? {}).some((item: any) =>
      String(item?.source ?? "").includes("banking_redis_data"),
    );
  const redisAof = redisCommand.toLowerCase().includes("appendonly") &&
    redisCommand.toLowerCase().includes("yes");
  add(
    redis && redisHasVolume && redisAof && Boolean(redis.healthcheck) && redis.restart === "unless-stopped"
      ? "PASS"
      : "FAIL",
    "Redis durability and health",
    "Requires a persistent named volume, AOF enabled, healthcheck, and unless-stopped restart policy.",
  );

  const backendPorts = JSON.stringify(backend?.ports ?? []);
  add(
    backend && backendPorts.includes("127.0.0.1") && Boolean(backend.healthcheck)
      ? "PASS"
      : "FAIL",
    "Backend port exposure and healthcheck",
    "Backend should bind to loopback for local development and expose a healthcheck.",
  );

  const backendDepends = JSON.stringify(backend?.depends_on ?? {});
  add(
    backendDepends.includes("service_healthy") &&
      backendDepends.includes("service_completed_successfully") &&
      backend?.init === true
      ? "PASS"
      : "FAIL",
    "Backend startup dependencies",
    "Backend should wait for healthy dependencies and successful migrations; init should be enabled.",
  );

  const workerDepends = JSON.stringify(worker?.depends_on ?? {});
  add(
    worker && workerDepends.includes("service_healthy") &&
      workerDepends.includes("service_completed_successfully") &&
      worker.init === true
      ? "PASS"
      : "FAIL",
    "Worker startup and process handling",
    "Worker should wait for healthy dependencies and successful migrations, with init enabled.",
  );

  const hasRuntimeStage = /FROM\s+node:[^\s]+\s+AS\s+runtime/i.test(dockerfile);
  const nonRootRuntime = /^\s*USER\s+node\s*$/im.test(dockerfile);
  const multiStage = (dockerfile.match(/^\s*FROM\s+/gim) ?? []).length >= 3;
  add(
    hasRuntimeStage && nonRootRuntime && multiStage ? "PASS" : "FAIL",
    "Docker image build and runtime user",
    "Requires a multi-stage image and non-root node user in the runtime stage.",
  );

  const secretsExcluded =
    dockerignore.includes(".env.*") &&
    dockerignore.includes("!.env.docker.example") &&
    dockerignore.includes("node_modules");
  add(
    secretsExcluded ? "PASS" : "FAIL",
    "Docker build context exclusions",
    "Requires environment files, dependencies, and generated output to be excluded from the build context.",
  );

  add(
    volumes.banking_postgres_data && volumes.banking_redis_data ? "PASS" : "FAIL",
    "Named volume declarations",
    "Both PostgreSQL and Redis named volumes must be declared.",
  );

  const postgresEnvironment = JSON.stringify(postgres?.environment ?? {});
  if (/banking_local_dev_password/i.test(postgresEnvironment)) {
    add(
      "WARN",
      "PostgreSQL credentials",
      "Compose contains a fixed local-development password. Use secret management and unique credentials outside local development.",
    );
  } else {
    add("PASS", "PostgreSQL credentials", "No known sample development password found in resolved Compose config.");
  }

  if (!includesText(redis?.command, "requirepass") && !includesText(redis?.command, "aclfile")) {
    add(
      "WARN",
      "Redis authentication",
      "Redis has no password/ACL configuration. Keep it on a private network and add authentication for shared or production deployments.",
    );
  } else {
    add("PASS", "Redis authentication", "Redis authentication configuration detected.");
  }

  if (String(mailpit?.image ?? "").endsWith(":latest")) {
    add(
      "WARN",
      "Mailpit image pinning",
      "Mailpit uses the mutable latest tag. Pin a tested version for reproducible deployments.",
    );
  } else {
    add("PASS", "Mailpit image pinning", "Mailpit image uses a non-latest tag.");
  }

  if (!backend?.read_only || !backend?.cap_drop) {
    add(
      "WARN",
      "Container hardening",
      "Backend does not declare both read_only filesystem and dropped Linux capabilities. Evaluate these after validating runtime write paths.",
    );
  } else {
    add("PASS", "Container hardening", "Read-only filesystem and capability restrictions are configured.");
  }

  console.log("Phase 35.7 — Final Dockerization Review");
  console.log("----------------------------------------");
  for (const check of checks) {
    console.log(`${check.state.padEnd(4)} | ${check.label}`);
    console.log(`     ${check.detail}`);
  }

  const failed = checks.filter((check) => check.state === "FAIL").length;
  const warnings = checks.filter((check) => check.state === "WARN").length;

  console.log("----------------------------------------");
  console.log(`Checks: ${checks.length}`);
  console.log(`PASS: ${checks.filter((check) => check.state === "PASS").length}`);
  console.log(`WARN: ${warnings}`);
  console.log(`FAIL: ${failed}`);

  if (failed > 0) {
    console.log("Phase 35.7: FAIL — required Docker configuration checks failed.");
    process.exitCode = 1;
  } else if (warnings > 0) {
    console.log("Phase 35.7: REVIEW COMPLETE WITH WARNINGS — not yet production-hardened.");
  } else {
    console.log("Phase 35.7: PASS");
  }
};

try {
  main();
} catch (error) {
  console.error("Phase 35.7: FAIL");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
