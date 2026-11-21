# Backend environment selection

The backend supports two development modes. Keep their environment files separate.

## Docker Development

Copy `src/.env.docker.example` to the project root as `.env.docker`, fill in local secrets,
and ensure `DOCKERIZED=true`. Docker Compose injects this file into the API and worker
containers. The expected service hosts are `postgres:5432` and `redis:6379`.

Run from the backend project root:

```powershell
docker compose --env-file .env.docker up -d --build
```

## Local Windows Development

Copy `src/.env.local.example` to the project root as `.env.local`, then use the same local-only secrets as
your Docker development file. The connection endpoints must remain:

- PostgreSQL: `127.0.0.1:5433`
- Redis: `127.0.0.1:6381`
- Mailpit SMTP: `127.0.0.1:1025`

The Compose `redis` service must publish its port to the Windows host:

```yaml
ports:
  - "127.0.0.1:6381:6379"
```

Start PostgreSQL, Redis and Mailpit, but stop the containerized API and worker to
avoid two backend instances competing for the same jobs:

```powershell
docker compose --env-file .env.docker up -d postgres redis mailpit
docker compose --env-file .env.docker stop backend worker
```

In a fresh PowerShell terminal, select the local file and start the API:

```powershell
$env:DOTENV_CONFIG_PATH = ".env.local"
$env:NODE_ENV = "development"
$env:DOCKERIZED = "false"
npm run dev
```

To run the local worker too, use a second terminal with the same environment:

```powershell
$env:DOTENV_CONFIG_PATH = ".env.local"
$env:NODE_ENV = "development"
$env:DOCKERIZED = "false"
npm run worker:dev
```

## Switch back to Docker Development

Stop local API/worker processes with Ctrl+C. Then run:

```powershell
docker compose --env-file .env.docker up -d --build backend worker
```

## Automated Testing

Keep `.env.test` separate. The test environment must use the isolated test database
and Redis services, never the development or production data stores.

## Important

- `DOTENV_CONFIG_PATH` is read by both the application config and Prisma's
  `dotenv/config` loader in `prisma.config.ts`.
- Existing process environment variables take precedence over dotenv file values.
  Use a fresh PowerShell terminal or clear stale `DATABASE_URL`, `REDIS_URL`,
  `NODE_ENV`, and `DOCKERIZED` variables before switching modes.
- Do not commit real `.env*` files or share credentials. Use the example files only.
