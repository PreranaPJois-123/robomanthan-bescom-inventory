# CHANGELOG

## CORS crash fix + restored missing Edit/Delete routes (2026-08-25)

- **Fixed the startup crash.** `app.options("*", cors())` was removed.
  This app's installed Express (`^5.2.1`) uses `path-to-regexp` v6+, which
  no longer accepts a bare `"*"` as a route pattern — that's the exact
  cause of `PathError: Missing parameter name at index 1: *`. The regex
  form (`app.options(/.*/, cors())`) has the same underlying
  incompatibility, so it wasn't used either. The line turned out to be
  unnecessary anyway: `app.use(cors(corsOptions))`, already mounted a few
  lines above, handles OPTIONS preflight for every route on its own —
  that's standard behavior of the `cors` npm package, not something that
  needs a second explicit route. Verified by actually starting the server
  (`npm start`) and sending a real preflight `OPTIONS` request — no crash,
  correct `204` with the right `Access-Control-Allow-*` headers.
- **CORS origins**: `http://localhost:5500` and `http://127.0.0.1:5500`
  stay hard-coded (fixed, non-sensitive dev values). The production
  frontend origin is no longer hard-coded — it now comes from a new
  `FRONTEND_URL` environment variable (comma-separated if you ever need
  more than one), set on Render. The old hard-coded entry in
  `allowedOrigins` was actually the *backend's own* Render URL, not the
  Hostinger frontend origin — that wouldn't have matched real preflight
  requests from Hostinger anyway.
- **Added a small error handler** so a blocked CORS request (or any other
  server error) returns clean JSON instead of Express's default HTML page
  with a full stack trace.
- **Restored `PUT /bescom/components/:id` (Edit) and
  `DELETE /bescom/components/:id` (Delete), which were missing from this
  version of `server.js` entirely** — the frontend already calls both
  (`bescom.js`) and the UI already has working Edit/Delete buttons, but
  without these two routes both were silently 404ing. Confirmed via a
  live Postgres + running server test: add → edit (name changes, Serial
  Number stays the same) → delete (row actually removed from the
  database, confirmed with a direct `SELECT`) all work end-to-end again.
- Confirmed unchanged and still correct: `frontend/config.js`
  (`API_URL = "https://robomanthan-bescom-inventory.onrender.com"`),
  every frontend `fetch()` call consistently uses `API_URL`, the
  single-account `saurav@robomanthan.com` restriction, Serial Number
  generation/search, PDF/Excel reports, and the dashboard summary. No
  database schema or migration changes; no existing BESCOM data touched.

---

## Serial Number + Delete (2026-08-25)

- **Removed "Component ID" from the UI entirely** (table column, Add/Edit
  form label, search placeholder, PDF report, Excel report). The
  underlying `component_id` database primary key was never exposed to
  users in the first place (confirmed by inspection) — what the UI called
  "Component ID" was actually the separate, optional `component_code`
  field. That field still exists internally (now labeled "Component
  Code" in the Add/Edit form) for backward compatibility with search, but
  no longer appears in the Components table.
- **Added a proper, database-generated Serial Number**
  (`backend/migrations/20260826_component_serial_number.sql`): a
  dedicated Postgres sequence backs `bescom_components.serial_number`
  (integer, `NOT NULL`, `UNIQUE`, indexed). New rows get it automatically
  via `DEFAULT nextval(...)` — never computed client-side as
  `components.length + 1`, and never reused after a delete, since
  sequences only move forward. Existing components are backfilled in
  alphabetical order (matching the existing UI sort), confirmed against
  real test data to match exactly: Adaptor→1, Antennae→2, Antennae
  connector→3, Banana clips→4, ... Editing a component never touches its
  serial number.
- **Added a real Delete**: `DELETE /bescom/components/:id` — restricted to
  `saurav@robomanthan.com` via the same `authenticateToken` +
  `requireBescomAccess` chain as every other mutating BESCOM route,
  actually removes the row from Postgres, logs a `BESCOM_COMPONENT_DELETED`
  audit entry, and returns a friendly 409 (instead of a raw DB error) if
  the component is still attached to a kit or deployment record. Frontend
  adds a red "🗑 Delete" button next to Edit, with a named confirmation
  dialog, and refreshes the table + dashboard summary from the backend
  (preserving whatever search/category filter was active) after a
  successful delete.
- **Bugs found and fixed during testing** (both caught by actually running
  the migration against a real local Postgres instance, not just reading
  the SQL): (1) the original `setval(...)` call failed on a fresh/empty
  `bescom_components` table because Postgres sequences can't be set below
  their minvalue of 1 — fixed with an explicit `IF max IS NULL` branch.
  (2) the cleanup migration's `DELETE FROM audit_logs` / `damage_history`
  statements failed on a database that never had those gap-fill tables —
  guarded with `information_schema.tables` existence checks.
- Reports: both the PDF and Excel component exports now show a "Serial
  Number" column instead of Component ID/Code, in the order
  `Component Name | Serial Number | Total Stock | Available Stock |
  Damaged Quantity | Damage Reason | Status`.

---

## BESCOM-only conversion (2026-08-25)

This application was converted into a **single-tenant, BESCOM-only**
inventory system, with access restricted to a single account.

- **Removed the entire "SmartStock" product/issue/customer system**: the
  `products`, `issues`, `issue_components`, `issue_requests`,
  `return_requests`, `exchange_requests`, `extension_requests`,
  `add_component_requests`, `damaged_requests`, `damaged_components`,
  `customer_transactions`, `suppliers`, `stock_received`, `reports`,
  `signup_requests`, and `users` tables, and every backend route and
  frontend page built on them (`index.html`, `script.js`, `signup.html`,
  `damaged-report.*`, `/products`, `/issue*`, `/return*`, `/markDamaged`,
  `/damagedProducts*`, `/customerSignup`, `/components*`,
  `/myTransactions`, `/transactions/*`, `/admin/*`, `/suppliers`,
  `/stock/*`, `/reports/*` (SmartStock's, not BESCOM's), and the weekly
  SmartStock report cron job). See
  `backend/migrations/20260825_bescom_only_cleanup.sql` for the DB-level
  removal, which is destructive and irreversible by design.
- **BESCOM is now the only inventory/module in the app.** `bescom.html` is
  the landing page after login; the `bescom_*` tables are the only
  inventory data model left.
- **Re-introduced a single hard-coded authorized email,
  `saurav@robomanthan.com`.** Note: an earlier changelog entry below
  describes *removing* a hard-coded email in favor of a
  `BESCOM_ONLY_EMAILS` env var, because at the time hard-coding one
  employee's address while every other `@robomanthan.com` address quietly
  got full admin rights was an unintended privilege bug. This is a
  different situation: the app is now deliberately restricted to exactly
  one person, by explicit request, so a single hard-coded constant
  (checked in `authenticateToken` on every request, not just at login) is
  the correct, intentional implementation here — not a regression of that
  earlier fix.
- `/login` now only accepts `saurav@robomanthan.com`; every other email is
  rejected with the same "access denied" message regardless of whether it
  looks like a valid company address.
- `authenticateToken` re-validates the email inside every JWT on every
  request, not just at login, so an old or otherwise-valid token for a
  different account is rejected on every protected route.
- Removed now-unused backend files: `reportData.js`, `reportGenerator.js`,
  `weeklyReportCron.js`, and `updateInventory.js` (the last of which also
  contained a hard-coded local database password — worth rotating that
  credential if it was ever a real one).
- Removed the SmartStock product seed migration
  (`backend/migrations/seed_original_catalog.sql`).

---

Scope of this pass: a targeted engineering audit and fix-set, plus an
application-wide visual redesign delivered through the shared stylesheet.
This is **not** a ground-up rewrite — the existing tech stack, routes, and
data model are preserved; the changes below are what was actually verified
and fixed, not a wishlist.

---

## Authentication (real bug fix)

- **Removed the hard-coded employee email.** `saurav@robomanthan.com` was
  the *only* address that received the `bescom_admin` role — every other
  `@robomanthan.com` address (hr@, admin@, manager@, etc.) already logged
  in successfully, but silently received **full admin** rights instead of
  BESCOM-only access. That's a privilege bug, not just a naming one.
- Role assignment now reads a `BESCOM_ONLY_EMAILS` environment variable
  (comma-separated list). No individual employee email is hard-coded in
  the source anymore. Any `@robomanthan.com` address not in that list gets
  full admin, matching the documented intent.
- Fixed a malformed `</body>` placement in `login.html` (the customer
  sign-in/sign-up modal markup was sitting outside `<body>`).

## Dashboard

- `weeklyReplacement` was a permanent stub returning `0`. It now sums real
  data from `damage_history` for the trailing 7 days, guarded so a fresh
  database (before that table exists) still returns `0` instead of
  crashing the `/dashboard` route.
- Fixed a NaN/undefined risk in `manageDashboard()`: stock/damaged totals
  are now coerced with `Number(...) || 0` before summing, so a null field
  can no longer turn the whole KPI into `NaN`.

## BESCOM module

- Added the missing validation that "damaged quantity cannot exceed total
  stock" — on both the `POST`/`PUT /bescom/components` routes (source of
  truth) and the Add/Edit Component form (instant feedback). Previously
  neither layer checked this.
- The `PUT` route's existing "total can't be less than issued + damaged"
  check now correctly considers a damaged-quantity change submitted in the
  same request, instead of only comparing against the old damaged value.

## Reports / PDF (the "boring PDF" fix)

- New `backend/pdfTheme.js`: shared PDFKit helpers (branded header band,
  KPI summary cards, bordered tables with shaded headers that repeat when
  a table spans multiple pages, footer with "Page X of Y" on every page).
- The main inventory PDF (`reportGenerator.js`) and the BESCOM PDF now
  both render through this shared theme, so they look like they come from
  the same product instead of two different one-off scripts.
- Both PDF generators were smoke-tested against sample data (generated,
  then text-extracted back out) to confirm they render correctly and the
  numbers match the input — not just "the code compiles."
- Excel exports (main report + BESCOM) got a matching visual pass: dark
  header row with white bold text, frozen header row, zebra striping.

## Global UI redesign

- Rewrote `frontend/style.css` as a single design system (CSS custom
  properties for color/spacing/shadow/radius, refined typography, cards,
  buttons, inputs, tables, modals, status-badge classes) used by every
  page. This was done as a **re-skin, not a restructure** — every selector
  that `script.js`/`bescom.js` already depends on still exists, so nothing
  that JS touches was broken; only the visual treatment changed.
- Added a slim secondary "module nav" strip (Dashboard / BESCOM / Reports)
  under the main header on the dashboard and BESCOM pages, correctly
  hidden for non-admins on the Reports link (mirrors the existing
  `reportsBtn` admin-only gating).
- Trimmed `bescom.css` — removed rules for kit/usage/tab UI that no longer
  exists after the earlier BESCOM simplification, and added styling for
  the `.bescom-hint`/`.bescom-optional` classes that were previously
  unstyled.
- Restyled `damaged-report.html`'s standalone stylesheet to match the same
  navy/blue palette instead of the old orange theme, without merging it
  into the shared stylesheet (it doesn't load `style.css`, so this avoids
  any selector collisions).

## What this pass did *not* cover

Given the size of this codebase (~9,000 lines across frontend/backend), a
few items from the original request weren't reached and should be treated
as open follow-ups rather than "done":

- A structural sidebar-nav rebuild of every page (the module-nav strip
  above is the safe, additive version of this; a true fixed sidebar would
  need care around every page's existing layout assumptions).
- A field-by-field audit of every remaining API call in `script.js`
  (~30 endpoints). The ones inspected in this pass (`/damagedProducts`,
  `/components`, `/myTransactions`, `/admin/summary`, `/dashboard`) were
  already consistent; the rest weren't individually re-verified.
- Search/filter functionality was reviewed by reading the code, not by
  running the app end-to-end against a live database.
- No new database migration was needed for anything fixed in this pass.

## Files touched

- `backend/server.js` — auth fix, BESCOM validation, BESCOM PDF/Excel
  report rewrite.
- `backend/reportData.js` — real `weeklyReplacement` calculation.
- `backend/reportGenerator.js` — PDF rewritten on the shared theme, Excel
  header styling.
- `backend/pdfTheme.js` — **new** shared PDF drawing helpers.
- `frontend/style.css` — full design-system rewrite.
- `frontend/bescom.css` — trimmed to match, dead rules removed.
- `frontend/bescom.js` — damaged-vs-total validation.
- `frontend/script.js` — dashboard NaN guard, module-nav admin gating.
- `frontend/index.html`, `frontend/bescom.html` — module-nav strip added.
- `frontend/login.html` — malformed `</body>` fixed.
- `frontend/damaged-report.css` — palette aligned with the rest of the app.
