# Phase 35 — Dockerized local development

## Services
- `backend`: Express API on `127.0.0.1:5000`
- `postgres`: local PostgreSQL 17; host port `127.0.0.1:5433`
- `redis`: local Redis 7.4; internal Compose network only
- `worker`: BullMQ worker using the same application image
- `migrate`: one-shot `prisma migrate deploy` job, gated on PostgreSQL health
- `mailpit`: local SMTP sink; web UI at `http://127.0.0.1:8025`

## First-time setup (Windows CMD)
1. Copy `.env.docker.example` to `.env.docker`:
   `copy .env.docker.example .env.docker`
2. Start the stack:
   `docker compose up --build`

After the image has been built, `docker compose up` starts the stack. Rebuild after source/dependency changes with `docker compose up --build`.

## Useful commands
- Status: `docker compose ps`
- Logs: `docker compose logs -f backend worker`
- Migration logs: `docker compose logs migrate`
- Stop: `docker compose down`
- Stop without deleting data: `docker compose down`
- Rebuild: `docker compose up --build`

Do NOT use `docker compose down -v` unless intentionally deleting the local PostgreSQL and Redis volumes.

## Local endpoints
- API: `http://127.0.0.1:5000`
- Health: `http://127.0.0.1:5000/health`
- Readiness: `http://127.0.0.1:5000/ready`
- Swagger (development): `http://127.0.0.1:5000/api-docs`
- Mailpit UI: `http://127.0.0.1:8025`
- PostgreSQL from host tools: `localhost:5433`, database `banking_dev`

## Important safety notes
- These credentials and secrets are local-development placeholders only.
- Compose uses its own PostgreSQL and Redis; it does not point to Neon or Upstash.
- `migrate` runs the existing committed migrations only. It does not reset, drop, or seed the database.
- The default seed script is intentionally not run automatically.
- `postgres` and `redis` data are stored in named volumes and survive `docker compose down`.
- Do not use this Compose configuration as a production deployment without a separate secrets, TLS, backup, monitoring, and network-hardening review.
