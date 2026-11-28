# Phase 35 — Dockerized Backend implementation report

## Scope boundary

This implementation is for the Dockerized backend source archive only.
It does not modify or require changes to the separate production backend
folder. The existing application business logic was retained.

## Existing test coverage retained

The uploaded source archive already contained 210 `*.test.ts` files. They
cover authentication and database behavior, account ownership and creation,
deposit/withdrawal invariants, transfer authorization and financial integrity,
transaction history, JWT middleware, role authorization, admin/support/auditor
access, jobs, notifications, risk, and related services.

The package scripts added here run the existing Vitest suite rather than
duplicating those tests. The actual PASS/FAIL result must be established by
running the suite against the isolated Docker test services.

## New files under src/

- `.env.test.example` — safe template for isolated Docker test services.
- `tests/docker/persistence-check.ts` — Phase 35.6 marker-based persistence
  test. It restarts only the local Compose PostgreSQL and Redis services,
  verifies its own probe data survives, and cleans up only its own marker.
- `tests/docker/dockerization-review.ts` — Phase 35.7 static review of the
  resolved Compose configuration, volumes, healthchecks, dependencies,
  loopback ports, Dockerfile runtime user, and Docker build exclusions.
- `tests/TEST-ENVIRONMENT.md` — setup and execution instructions.

## Root-level companion updates

The implementation also supplies:
- `docker-compose.phase35.yml` — adds opt-in `test-postgres` and `test-redis`
  services under the `test` profile, with separate ports and named volumes.
- `package.phase35.json` — adds scripts for migration preparation, integration
  testing, persistence validation, Docker review, and the combined Phase 35
  command.

Apply these two files to the Dockerized backend project root as
`docker-compose.yml` and `package.json` respectively. Keep a backup of the
existing root files first. Do not copy them into the production backend folder.

## Commands

From the Dockerized backend project root:

1. Start the normal Dockerized stack (already completed in the user's workflow).
2. Start isolated test dependencies:

   `docker compose --profile test up -d test-postgres test-redis`

3. Create `.env.test` from `src/.env.test.example`, review its values, then:

   `npm run phase35:verify`

The combined command runs, in order:
- Prisma migrations against the isolated `banking_test` database.
- The complete Vitest integration/unit suite.
- PostgreSQL and Redis persistence checks (restarts the normal local
  `postgres` and `redis` services).
- The final Docker configuration review.

## Important result interpretation

The Docker Compose configuration supplied for review currently has local
development credentials, Redis without authentication, and Mailpit on the
mutable `latest` image tag. The Docker review reports these as warnings.
A warning result is not a production-readiness certification.

The persistence script and test suite have been authored but were not executed
in this environment because the uploaded archive does not include the user's
Docker Desktop daemon, running containers, `.env.docker`, `.env.test`, or
project `node_modules`. Run the commands above on the user's Dockerized backend
and use their real output to mark Phase 35.5–35.7 PASS or FAIL.
