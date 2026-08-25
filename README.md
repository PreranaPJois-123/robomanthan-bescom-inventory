# BESCOM Inventory Management System

## Overview

This is a single-tenant inventory management system for **BESCOM**. It is
the only inventory/organization this application manages, and it is
accessible to exactly one authorized account.

The system tracks BESCOM components and kits, records deployments (kits
and components taken out to a place/college/site and later returned), and
keeps an append-only audit trail and damage history.

---

## Access

Only **saurav@robomanthan.com** can log in and use this application. This
is enforced on the backend, on every request (not just at the login
screen) — see `backend/server.js`, `authenticateToken`. Anyone else who
attempts to log in receives:

> Access denied. This inventory system is restricted to authorized users.

The password is set via the `ADMIN_PASSWORD` environment variable on the
backend (see [Environment Variables](#environment-variables) below).

---

## Features

### Components

* Add, edit, delete, and search BESCOM components
* Every component has a system-generated, permanent **Serial Number**
  (never user-editable, never reused after a delete — backed by a
  dedicated Postgres sequence, not client-side counting)
* Track total / issued / damaged / available quantity per component
* Record damage with a reason, description, and running damage history
* Optional IAMI number tracking

### Kits

* Add, edit, and search BESCOM kits
* Attach required components (and quantities) to a kit
* Track total / issued / damaged / available kits

### Deployments (usage tracking)

* Record kits and/or components taken to a place, with purpose and
  responsible person
* Partial or full returns, tracked per component/kit
* Deployment status: In Use / Partially Returned / Returned / Completed

### Reports & Audit

* PDF and Excel exports of the current BESCOM component inventory
* Immutable audit log of every create/update/damage/deployment action
  (`GET /audit`) — entries are append-only, never edited or deleted by
  application code

---

## Technology Stack

* **Frontend:** HTML5, CSS3, vanilla JavaScript
* **Backend:** Node.js, Express
* **Database:** PostgreSQL
* **Authentication:** JSON Web Tokens (JWT), single hard-coded authorized
  account

---

## Project Structure

```text
robomanthan-bescom-inventory
│
├── frontend
│   ├── login.html      # single email/password login form
│   ├── bescom.html      # the only application page after login
│   ├── bescom.js
│   ├── bescom.css
│   ├── style.css        # shared base styles (login box, navbar, etc.)
│   └── config.js        # API_URL
│
├── backend
│   ├── server.js         # Express app: auth + all /bescom/* routes
│   ├── audit.js           # append-only audit log helper
│   ├── pdfTheme.js        # shared PDF report styling
│   ├── run-bescom-migrations.js
│   └── migrations/
│
├── CHANGELOG.md
└── README.md
```

---

## Database Tables

All application data lives in these tables (see `backend/migrations/`):

* `bescom_components`
* `bescom_kits`
* `bescom_kit_components`
* `bescom_deployments`
* `bescom_deployment_components`
* `bescom_deployment_kits`
* `damage_history` (shared append-only damage log)
* `audit_logs` (shared append-only audit trail)

No other inventory, tenant, customer, or product data exists in this
application.

---

## Installation

### Clone Repository

```bash
git clone <repository-url>
```

### Backend Setup

```bash
cd backend
npm install
```

### Environment Variables

Create `backend/.env`:

```text
DB_USER=...
DB_HOST=...
DB_NAME=...
DB_PASSWORD=...
DB_PORT=5432
JWT_SECRET=some-long-random-string
ADMIN_PASSWORD=the-one-account's-password
PORT=3000
```

`saurav@robomanthan.com` is hard-coded as the only authorized email in
`backend/server.js` (`ALLOWED_ADMIN_EMAIL`) — it is not configurable via
environment variable, by design.

### Run Migrations

```bash
node run-bescom-migrations.js
```

This creates all `bescom_*` tables and (as the final step) drops every
table that belonged to the old multi-inventory system. **This is
destructive and irreversible** — see the comment at the top of
`backend/migrations/20260825_bescom_only_cleanup.sql` before running it
against a database you still need the old data from.

### Start Backend Server

```bash
node server.js
```

### Run Frontend

Open `frontend/login.html` in a browser (or serve the `frontend/`
directory with any static file server). Update `frontend/config.js` if
your backend isn't running at the default configured URL.

---

## Security Notes

* Every protected backend route requires a valid JWT **and** re-checks
  that the email inside it is exactly `saurav@robomanthan.com` — this
  check happens in `authenticateToken` on every request, so it isn't
  bypassable by skipping the login UI.
* There is no signup flow and no multi-user accounts table. There is
  exactly one account, and it is not stored in the database at all — it's
  a backend constant checked against `ADMIN_PASSWORD`.
* `audit_logs` is append-only: no route in this codebase issues `UPDATE`
  or `DELETE` against it.
