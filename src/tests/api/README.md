# Backend API smoke tests

This folder contains lightweight HTTP-level smoke tests for the Express app.

Coverage:
- `/health` confirms PostgreSQL and Redis are connected.
- `/ready` confirms readiness.
- Protected account, deposit, admin, and transfer endpoints reject unauthenticated requests.
- Unknown API paths return 404 and include a request ID.

These checks complement the existing feature/integration tests in `src/tests`.
They do not prove every business workflow or payment-provider settlement path.

## Run safely

From the backend project root, use the isolated test infrastructure described in
`src/tests/TEST-ENVIRONMENT.md`. Never point `.env.test` at a production or
shared database/Redis instance.

Run the whole integration suite using the repository's configured script:

```powershell
npm run test:integration
```

If Vitest is configured to load `.env.test` through that script, you can run
only this file with:

```powershell
npx vitest run src/tests/api/backend-api.smoke.test.ts
```

If the direct command does not load `.env.test`, use the existing
`test:integration` script or the project's documented test environment
loader rather than running against your normal development database.
