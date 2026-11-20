# Backend archive repair notes

## What was fixed
- Mailer skips SMTP AUTH for local Mailpit hosts (`mailpit`, `localhost`, `127.0.0.1`, `::1`).
- Docker Compose publishes Mailpit SMTP on `127.0.0.1:1025` and the web UI on `127.0.0.1:8025`.
- `.env.example` now includes local Mailpit SMTP settings.
- Mailer unit test checks both local Mailpit and authenticated SMTP configuration behavior.

## Important: clean dependency installation
This archive intentionally excludes `node_modules` and `dist`. The uploaded archive contained an incomplete `node_modules/jsonwebtoken` directory: its package metadata declared `main: index.js`, but `index.js` was missing. `npm install` did not repair it because npm considered the package installed.

After extracting this archive, in the backend folder run:

```bash
npm ci
npm run typecheck
npm run dev
```

If you already have the project folder and want to repair that folder without replacing source files, stop the local Node process and run `npm ci` in the backend root. This replaces the existing `node_modules` from the lockfile.

## Local Mailpit setup
Run from the folder containing `docker-compose.yml`:

```bash
docker compose up -d mailpit
```

For `npm run dev` on Windows, copy `.env.example` to `.env` (then fill in your own database, Redis, JWT, and admin settings), and use:
- `SMTP_HOST=127.0.0.1`
- `SMTP_PORT=1025`
- `SMTP_USER=local`
- `SMTP_PASSWORD=local`

Open the Mailpit inbox at `http://localhost:8025`.

For the Dockerized backend service, keep `SMTP_HOST=mailpit` and `SMTP_PORT=1025` in your local `.env.docker`; Compose service DNS is used inside containers.

## Security note
Local `.env`, `.env.docker`, and `.env.test` files were excluded from this archive because they can contain credentials. Keep your own local copies and do not commit or share them. If any real database password, API key, or SMTP credential was included in a shared archive, rotate it.
