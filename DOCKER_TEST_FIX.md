# Docker test runner fix

## Root cause
The test-runner image builds from the Dockerfile `build` stage. That stage copied `src/` but not `docs/`. Vitest imports `src/app.ts`, which imports `src/docs/swagger.ts`; that module synchronously reads `/app/docs/openapi.json`. The file was therefore missing and 124 suites failed during module loading before their tests ran. The 82 passing suites and 480 passing tests in the supplied log are consistent with this single shared import failure.

## Changes
- Dockerfile: copy `docs/` into the `build` stage before compiling/running tests.
- docker-compose.yml: explicitly pass `TEST_POSTGRES_PASSWORD` as `POSTGRES_PASSWORD` to the isolated `test-postgres` service on first initialization.
- No application business logic, password-reset endpoint behavior, or production database configuration was changed.

## Run
From the backend directory:

```powershell
docker compose --env-file .env.docker --profile test run --build --rm test-runner
```

The test runner uses `test-postgres`, `test-redis`, and Mailpit from the test profile. Do not run migrations against Neon/Upstash or the normal development database when testing this flow.

Note: if the test PostgreSQL volume was initialized previously with a different password, changing `POSTGRES_PASSWORD` in Compose does not alter the existing database role password. The container volume must be reconciled deliberately; do not delete volumes as a shortcut.
