# Docker Development & Integration Test Update

Replace these files in the project:
- `src/config/env.ts`
- `docker-compose.yml`
- `package.json`
- `vitest.config.ts`
- `Dockerfile`

## Configure `.env.test`
Use `.env.test.docker.example` as a template. Keep your test-only credentials, but:
- DATABASE_URL host must be `test-postgres`, port `5432`, database `banking_test`.
- DATABASE_URL password must match the `TEST_POSTGRES_PASSWORD` used by the Compose test-postgres service (URL-encode special characters).
- REDIS_URL must be `redis://test-redis:6379/15`.
- TEST_DATABASE_HOST=`test-postgres`; TEST_REDIS_HOST=`test-redis`.
- SMTP_HOST=`mailpit`.

## Run
Development: `docker compose up -d --build`
Integration tests: `npm run test:docker`

The test command builds/runs the test runner in Docker, starts the test-profile services, deploys existing migrations to `banking_test`, and runs Vitest. Development and test PostgreSQL/Redis volumes remain separate.

No volume deletion, database reset, or production migration is included. Never commit `.env`, `.env.docker`, or `.env.test`.
