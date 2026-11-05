# Phase 35 — Dockerized test environment

This test environment is for the Dockerized backend only. It is intentionally
separate from the production backend folder and must never use production
PostgreSQL or Redis endpoints.

## 1. Start isolated test services

From the Dockerized backend project root (the folder containing
`docker-compose.yml`), start the test-profile services:

```cmd
docker compose --profile test up -d test-postgres test-redis
```

The test profile uses separate named volumes and host ports:
- PostgreSQL: `127.0.0.1:5434`, database `banking_test`
- Redis: `127.0.0.1:6380`, logical database `1`

These services are not started by the normal `docker compose up -d` command.
They do not share the application PostgreSQL/Redis volumes.

## 2. Create the test environment file

Copy the template to the backend project root:

```cmd
copy src\.env.test.example .env.test
```

Review `.env.test` before running tests. In particular:
- `DATABASE_URL` must point to `127.0.0.1:5434/banking_test`.
- `REDIS_URL` must point to `127.0.0.1:6380/1`.
- `TEST_DATABASE_NAME` must be `banking_test`.
- `TEST_DATABASE_HOST` and `TEST_REDIS_HOST` must match the URL hostnames.
- Replace the `PRODUCTION_*_HOST` sentinel values with actual production
  hostnames if known. They are comparison values only; the test suite never
  connects to them.

Never copy production connection strings into `.env.test`.

## 3. Apply migrations to the isolated test database

Run from the project root:

```cmd
npm run test:prepare
```

This runs the existing Prisma migrations using `.env.test`. It does not reset
the database and does not touch the main `banking_dev` database.

## 4. Run Phase 35.5 integration tests

```cmd
npm run test:integration
```

This runs the existing Vitest suite under `src/tests`. The repository already
contains coverage for authentication/OTP/JWT/logout, account creation and
ownership, deposits, withdrawals, transfer authorization and financial
invariants, transaction history, and role-based authorization. The suite
uses `src/tests/setup.ts` to verify the configured test database and Redis
before seeding reference currencies.

A successful run must end with Vitest reporting zero failed tests. A successful
HTTP request from a previous manual test is not a substitute for this suite.

## 5. Run Phase 35.6 persistence validation

```cmd
npm run test:phase35:persistence
```

**This command restarts the local `postgres` and `redis` services** in the
normal Docker Compose stack. Run it only when a short interruption to the
Dockerized backend and worker is acceptable. It:
1. Verifies that the target database is exactly `banking_dev`.
2. Verifies Redis AOF is enabled.
3. Writes a uniquely named diagnostic row under
   `phase35_validation.persistence_probe` and a unique Redis key.
4. Restarts only the `postgres` and `redis` services.
5. Waits for both services to become ready and checks that both values remain.
6. Deletes only the probe row and Redis key created by that run.

It does not reset a database, delete a volume, truncate a table, or modify
financial account/transaction records. The diagnostic schema/table is retained
for repeatability.

If you do not want to restart the main development services, do not run this
command. It is deliberately separate from `test:integration`.

## 6. Run Phase 35.7 Dockerization review

```cmd
npm run docker:review
```

This validates the resolved Compose configuration and checks named volumes,
healthchecks, service dependencies, loopback port bindings, non-root runtime,
and `.dockerignore`. It also reports hardening warnings such as fixed
development credentials, missing Redis authentication, mutable image tags,
or missing container restrictions.

A `REVIEW COMPLETE WITH WARNINGS` result means the local Docker configuration
passed required structural checks but is not certified production-ready.
Resolve warnings before exposing the stack to a shared or public environment.

## 7. Run all Phase 35 checks

After preparing `.env.test`, applying migrations, and starting the normal
Dockerized backend:

```cmd
npm run phase35:verify
```

This executes integration tests, persistence validation, and the Docker
configuration review in sequence. The persistence stage restarts PostgreSQL
and Redis; schedule the command accordingly.

## Safety rules

- Do not run tests against the production backend folder.
- Do not use production database or Redis credentials in `.env.test`.
- Never run `prisma migrate reset` against production or shared databases.
- Do not run `docker compose down -v`; it deletes named volumes.
- Keep `.env`, `.env.test`, `.env.docker`, and all credential-bearing files out
  of Git and out of ZIP uploads.
