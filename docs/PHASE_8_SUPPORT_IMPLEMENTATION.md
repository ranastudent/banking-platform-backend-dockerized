# Phase 8 — Support Pages 38–44

This phase adds the seven Support screens to the existing React + Vite + TypeScript SPA. It reuses the existing Axios client, token refresh flow, React Query, Sonner toasts, role guard, portal shell, and semantic light/dark design tokens. No backend files or dependency versions are changed.

## Page and API mapping

| Page | Screen | API contract |
|---|---|---|
| 38 | Support Dashboard | `GET /support/audit-logs?page=1&limit=20` (recent-record summary only; there is no dedicated support dashboard aggregate endpoint) |
| 39 | Customer Search | `GET /support/customers?q=&page=&limit=` |
| 40 | Customer Accounts | `GET /support/customers/accounts/:accountId` |
| 41 | Customer Transactions | `GET /support/customers/:customerId/transactions?page=&limit=&status=&type=&provider=&currencyCode=` |
| 42 | Beneficiary Assistance | `GET /support/customers/:customerId/beneficiaries/:beneficiaryId` |
| 43 | Support Operations | `POST /support/customers/:customerId/support-operations` with `{ operationType, description }` |
| 44 | Support Audit Logs | `GET /support/audit-logs?page=&limit=&action=&entityType=` and `GET /support/audit-logs/:auditLogId` |

All paths are relative to the existing `/api/v1` Axios base URL. The existing API client continues to provide bearer-token injection and refresh handling.

## Contract and safety notes

- Customer lookup requires `q` with 1–100 characters. The screen uses `limit=10` and backend page pagination.
- Customer transaction filters use only the documented enum values. `currencyCode` is uppercased before sending.
- Account assistance requires an account UUID. The backend intentionally returns 404 for non-customer-owned accounts and missing accounts.
- Beneficiary assistance is read-only and requires both customer UUID and beneficiary UUID. The backend verifies ownership.
- Support operation values are limited to `ACCOUNT_INQUIRY`, `TRANSACTION_INQUIRY`, `BENEFICIARY_ASSISTANCE`, and `GENERAL_SUPPORT`. Description length is 3–1000 characters. The operation writes a Support audit record; it does not mutate the customer.
- Support audit action filter must match `SUPPORT_[A-Z0-9_]+`. Audit log details are read-only.
- No support ticket API or Support FX-request API is present in the supplied Support routes, so these were not implemented as active Phase 8 pages.
- Dashboard metrics are calculated only from the latest 20 audit records returned by the documented audit endpoint. They are labelled as recent sample metrics, not lifetime or ticket totals. No unsupported dashboard endpoint or fabricated data is used.

## Updated routes

- `/support/dashboard`
- `/support/customers`
- `/support/accounts`
- `/support/transactions`
- `/support/beneficiaries`
- `/support/operations`
- `/support/audit-logs`

The Support sidebar now links to these seven implemented pages. Existing CUSTOMER, ADMIN, and AUDITOR routes and feature files are retained.

## Validation performed

- TypeScript/TSX transpilation syntax checks: passed for changed TSX files.
- CSS parser validation: passed.
- Full `npm run typecheck` / `npm run build`: not run to completion in the packaging environment because `npm ci` could not complete network dependency installation. Run both locally after extracting the archive.
