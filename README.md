# Banking Platform Backend

Node.js + Express + TypeScript API backend with PostgreSQL, Prisma, Redis, background jobs, and deposit APIs.

## Requirements
- Node.js 22.18+ (Node 22 LTS recommended)
- npm 10+
- Docker Desktop (recommended for PostgreSQL, Redis, and Mailpit)

## Run with Docker Compose (recommended)
1. Copy `.env.docker.example` to `.env.docker` and change local-only credentials if needed.
2. Start the stack from this directory:

```powershell
docker compose up -d --build
docker compose ps
docker compose logs -f backend
```

Compose runs the migration service before the API and worker. The API is exposed on `http://127.0.0.1:5000`; health is at `/health`.

## Run the API on Windows with Docker services
1. Start infrastructure only:

```powershell
docker compose up -d postgres redis mailpit
```

2. Copy `.env.local.example` to `.env` and use local host ports (PostgreSQL 5433, Redis 6381).
3. Install dependencies and apply migrations:

```powershell
npm ci
npx prisma migrate deploy
npm run dev
```

The backend development command is `tsx watch src/server.ts`. This is an API server; it does not run Vite or React.

## Database migrations
Use `npx prisma migrate deploy` for applying committed migrations. Do not use `prisma migrate reset` or `db push` against a database containing data unless you intentionally want to change/reset it.

## Integration tests
Integration tests use a dedicated test database and Redis. Copy `.env.test.example` to `.env.test`, configure the test-only credentials, and start isolated services:

```powershell
docker compose --profile test up -d test-postgres test-redis
npm run test:run
```

Never point `.env.test` to production or your normal development database.

## Environment files
Only `.env.example`, `.env.docker.example`, `.env.local.example`, and `.env.test.example` templates are included. Real `.env`, `.env.docker`, and `.env.test` files are intentionally excluded from this ZIP. Create local environment files from the examples.

## Important
This is a development/portfolio banking application. Use isolated test accounts and mock providers; do not connect real customer funds or payment rails without a formal security, compliance, and provider-integration review.
