> **Historical document.** This describes gap-fill features added to the
> old multi-inventory "SmartStock" system, which has since been removed —
> see `CHANGELOG.md` ("BESCOM-only conversion") and `README.md` for the
> current, BESCOM-only version of this app. Most of what's described below
> (stock receiving, suppliers, weekly reports, the SmartStock dashboard
> cards) no longer exists in this codebase. Kept for historical context
> only.

# Gap-Fill Changes — Inventory Tracking Features

This adds the missing inventory-management features on top of the existing
Postgres/Express backend and vanilla HTML/JS frontend. **Nothing existing was
redesigned or removed** — all additions are new files, new routes, and small,
targeted edits (see "Existing files touched" below).

## What was added

| Feature | Where |
|---|---|
| Minimum quantity + real low-stock detection | `products.min_quantity` column (migration) |
| Stock Receiving (component, qty, supplier, invoice #, received by, date, remarks) | `POST /stock/receive`, `stock_received` table, "Receive Stock" button/modal |
| Suppliers | `suppliers` table, `GET/POST /suppliers` |
| Replacement history (serial numbers, reason, installed by) | New columns on `exchange_requests`, extended Exchange modal fields |
| Dashboard cards: Total Components, Available Inventory, Low Stock, Today's Usage, Today's Stock Received, Weekly Usage, Weekly Replacement | `GET /dashboard`, rendered below the existing 4 dashboard cards |
| Reports: Daily / Weekly / Monthly / Custom, in PDF and Excel, with logo/company name/summary | `GET /reports/pdf`, `GET /reports/excel`, "Reports" button/modal |
| Automatic weekly report (Sunday 11:59 PM) | `backend/weeklyReportCron.js`, stored in `backend/reports/`, listed in `GET /reports/list`, downloadable via `GET /reports/download/:fileName` |
| Immutable Audit Log (stock received / component used / returned / replaced / damaged) | `audit_logs` table (append-only — no UPDATE/DELETE anywhere), `GET /audit`, "Audit Log" button/modal |

## New backend files
- `backend/migrations/20260721_gap_fill_features.sql` — run this once against your DB
- `backend/audit.js` — `logAudit(pool, {...})` helper
- `backend/reportData.js` — shared dashboard/report queries
- `backend/reportGenerator.js` — PDF (PDFKit) + Excel (ExcelJS) builders
- `backend/weeklyReportCron.js` — Sunday 11:59 PM cron job
- `backend/reports/` — generated report files land here (gitignored contents, folder kept via `.gitkeep`)

## Existing files touched (small, targeted edits only)
- `backend/server.js` — added `require`s at top; added audit-log calls inside the existing `/issue`, `/returnIssue`, `/markDamaged`, and `/exchangeRequests/:id/approve` handlers (no behavior change to their existing logic, just an extra log write); extended `POST /exchangeRequests` to accept optional `employeeName`/serial number/`reason`/`installedBy` fields; appended all new routes at the end of the file; started the cron job at the bottom.
- `backend/package.json` — added `pdfkit` and `node-cron` to dependencies.
- `frontend/index.html` — added 3 admin-only buttons (Receive Stock / Reports / Audit Log) using the exact same show/hide pattern as the existing admin buttons; added 3 new modals; added optional serial-number/reason/installed-by fields to the existing Exchange modal.
- `frontend/script.js` — added `checkRole()` show/hide for the 3 new buttons; extended the exchange-request submit handler to send the new optional fields; appended all new functions (stock receiving, reports, audit log, dashboard extras) at the end of the file; `manageDashboard()` now also calls `loadDashboardExtras()`.

## Setup steps

1. **Run the migration** against your existing database:
   ```bash
   psql "$DATABASE_URL" -f backend/migrations/20260721_gap_fill_features.sql
   ```
   It's all `IF NOT EXISTS` / `IF EXISTS` — safe to re-run.

2. **Install new dependencies**:
   ```bash
   cd backend
   npm install
   ```

3. **New optional environment variables** (add to `backend/.env` if you want them; both have sensible fallbacks):
   ```
   COMPANY_NAME=RoboManthan
   COMPANY_LOGO_PATH=/absolute/path/to/logo.png
   ```
   If `COMPANY_LOGO_PATH` isn't set or the file doesn't exist, the PDF report just skips the logo and prints the company name as text.

   All pre-existing env vars are unchanged: `DB_USER`, `DB_HOST`, `DB_NAME`, `DB_PASSWORD`, `DB_PORT`, `JWT_SECRET`, `ADMIN_PASSWORD`, `PORT`.

4. **Start the server as usual**:
   ```bash
   npm start
   ```
   You should see `[weeklyReportCron] Scheduled: every Sunday at 23:59` in the logs — that confirms the cron job registered.

## Things worth testing before you rely on this in production

- `POST /stock/receive` with a real product ID — confirm `products.stock` increases and a row lands in `stock_received`.
- `GET /dashboard` — confirm the 7 numbers match what you'd expect from your current data.
- `GET /reports/pdf?periodType=weekly` — open the downloaded PDF and check the sections render sensibly with your real data volume (a business with thousands of usage rows in a week will produce a long PDF; you may want to add pagination/summarization later if that becomes unwieldy).
- Manually trigger `generateAndStoreWeeklyReport(pool)` from `weeklyReportCron.js` (e.g. in a one-off script) to confirm the cron path works before waiting for Sunday.
- Confirm `min_quantity` defaults (5) make sense for your components — you may want to set real per-component minimums via a direct `UPDATE products SET min_quantity = ... WHERE product_id = ...` after migrating.

## Known limitations / not implemented

- Prisma/MySQL were **not** introduced — this stays on the existing raw-`pg`/PostgreSQL setup, per your gap-fill decision.
- No new frontend page for managing suppliers (the `suppliers` table/routes exist, but stock receiving currently accepts a free-text supplier name; wire up a supplier picker later if you want normalized supplier records).
- The Excel export for reports is separate from the existing damaged-report Excel export — both continue to work independently.
