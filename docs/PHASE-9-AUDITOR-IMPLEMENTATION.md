# Phase 9 — Auditor Pages 45–51

Implemented in the existing React/Vite/TypeScript SPA. No backend files or dependencies were changed.

## Routes

| Page | Frontend route | Implementation |
|---|---|---|
| 45 Auditor Dashboard | `/auditor/dashboard` | Aggregates recent audit logs, transactions, approval records and FX requests. There is no dedicated auditor dashboard endpoint in the supplied backend contract. |
| 46 Audit Logs | `/auditor/audit-logs` | List, action/entityType/userId filters, pagination and audit-log detail. |
| 47 Transaction Review | `/auditor/transactions` | List, backend-supported filters, pagination and transaction detail. |
| 48 Account Activity | `/auditor/account-activity` | Account UUID lookup, account owner/balance summary and paginated related transactions. |
| 49 Approval Records | `/auditor/approvals` | List, decision/reviewerId/requestId filters, pagination and approval-record detail. |
| 50 FX Request Review | `/auditor/fx-requests` | List, status/userId/accountId/requestedCurrency filters, pagination and FX request detail. |
| 51 Currency & Reserve Review | `/auditor/currencies` | Read-only currencies, currency reserves, reserve detail and exchange-rate list. `/auditor/reserves` remains an alias. |

## API endpoints used

- `GET /auditor/audit-logs` and `GET /auditor/audit-logs/:auditLogId`
- `GET /auditor/transactions` and `GET /auditor/transactions/:transactionId`
- `GET /auditor/accounts/:accountId/activity`
- `GET /auditor/approvals` and `GET /auditor/approvals/:approvalRecordId`
- `GET /auditor/fx-requests` and `GET /auditor/fx-requests/:requestId`
- `GET /admin/currencies`, `GET /admin/currencies/:code`
- `GET /admin/currency-reserves`, `GET /admin/currency-reserves/:currencyCode`
- `GET /admin/exchange-rates`

The currency, reserve and exchange-rate endpoints explicitly allow the AUDITOR role in the supplied backend source. No mutation endpoint is exposed in the Auditor UI.

## Notes

- All requests use the existing shared Axios client, API prefix, bearer-token handling and refresh-token interceptor.
- List responses use the backend response envelope and `pagination` metadata.
- Filter values are restricted to documented query fields and enum values.
- Dashboard totals are taken from `pagination.total` on the corresponding endpoint responses. The dashboard does not invent a separate analytics endpoint or mock metric.
- Auditor screens are read-only. No POST/PATCH/DELETE requests are made by this module.
- Light/Dark theme styling uses the existing semantic CSS variables; responsive table overflow and filter layouts are included.
- The uploaded API guide is a static source review, not a live API contract test. Verify with a real AUDITOR test account and seeded records.
