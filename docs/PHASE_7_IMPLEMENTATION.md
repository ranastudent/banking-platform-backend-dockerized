# Phase 7 — Admin Operations Implementation

This update implements the Admin pages mapped to design pages 20–37 of the supplied Admin UI design archive.

## Page mapping

| Design page | Frontend route | Feature |
|---|---|---|
| 20 | `/admin/dashboard` | Admin dashboard |
| 21 | `/admin/users` | User management and status updates |
| 22 | `/admin/users/:userId` | User details |
| 23 | `/admin/accounts` | Account management |
| 24 | `/admin/accounts/:accountId` | Account details |
| 25 | `/admin/transactions` | Transaction management |
| 26 | `/admin/transactions/:transactionId` | Transaction details |
| 27 | `/admin/audit-logs` | Audit logs |
| 28 | `/admin/currencies` | Currency management |
| 29 | `/admin/exchange-rates` | Exchange-rate management |
| 30 | `/admin/reserves` | Currency reserves and adjustments |
| 31 | `/admin/fx-approvals` | FX approval decisions |
| 32 | `/admin/risk-reviews` | Risk review decisions |
| 33 | `/admin/fraud` | Fraud dashboard |
| 34 | `/admin/fraud/alerts` | Fraud alert triage and case creation |
| 35 | `/admin/fraud/cases` | Fraud case workflow, notes, evidence references, assignments |
| 36 | `/admin/fraud/models` | Fraud model registry and lifecycle |
| 37 | `/admin/monitoring` | Monitoring event ingestion and reprocessing |

## Implementation notes

- Uses the existing React Router, Axios API client, authentication lifecycle, role guards, TanStack Query and Sonner toast notifications.
- Uses the existing shared portal shell and semantic Light/Dark theme tokens; responsive tables and forms were added for Phase 7.
- Existing Customer pages and shared authentication/customer components were retained.
- All admin routes remain behind the existing ADMIN role guard. Backend authorization remains authoritative.
- Collection pages handle loading, error, empty and retry states. Detail pages show the record fields returned by the API.
- List queries use conservative `page=1&limit=100` where the API guide documents page/limit or the controller reads these values. Fraud cases are fetched without pagination because the guide states the controller returns the latest 100 cases.
- Monitoring events have no documented GET/list endpoint. The UI therefore supports POST ingestion and POST reprocessing only; it does not fabricate a monitoring event list. The ingestion JSON editor is intentional because the API guide does not define the complete event payload schema.
- Fraud evidence submission requires an existing storage reference. The UI collects `evidenceType` and `storageRef`; no file upload endpoint was documented.
- Exchange-rate `rate`, `buyRate`, `sellRate` and `spread` are submitted as numbers; `version` is numeric and `effectiveFrom` is ISO datetime.
- FX decision comments are required by the documented contract. Risk decision comments are optional.
- The API guide is a static source review, not a live API contract test. Verify response envelopes and field names against the running backend before production use.

## Run locally

```bash
npm ci
npm run dev
```

Build/typecheck:

```bash
npm run build
```

Configure `VITE_API_BASE_URL` to the API origin only (for example `http://localhost:5000`). The shared Axios client appends `/api/v1` exactly once.
