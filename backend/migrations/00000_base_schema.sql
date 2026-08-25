-- Base schema for the core tables that existed on the original live database
-- but were never captured in a migration file in this repo. Run this FIRST,
-- before 20260721_gap_fill_features.sql (which adds columns/FKs on top of
-- these tables).
--
-- Column names below were verified against every INSERT/SELECT/UPDATE in
-- server.js that touches each table (not guessed) -- including the PK name
-- used in each table's approve/reject routes (some use `request_id`, which
-- matters because Postgres will error if the column doesn't exist).
--
-- Safe to re-run. If you already ran an earlier version of this file, the
-- DO block at the bottom safely patches return_requests (id -> request_id)
-- and adds any missing columns -- it checks before altering, so it will
-- never error whether or not you've run this before.
--
-- Run in the Neon SQL Editor, or:
--   psql "$DATABASE_URL" -f backend/migrations/00000_base_schema.sql

-- Components. product_id is a plain INTEGER (not SERIAL) because the
-- existing /addComponent route in server.js computes the next ID itself
-- with SELECT MAX(product_id)+1 -- this lets us also seed explicit IDs
-- matching your original catalog.
CREATE TABLE IF NOT EXISTS products (
  product_id INTEGER PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  model VARCHAR(255),
  price NUMERIC(12,2) DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  damaged INTEGER DEFAULT 0,
  original_stock INTEGER,
  image TEXT
);

-- Usage / issue records (a "project", "workshop", or "testing" issue)
CREATE TABLE IF NOT EXISTS issues (
  issue_id BIGINT PRIMARY KEY,
  issue_type VARCHAR(50),
  project_name VARCHAR(255),
  venue VARCHAR(255),
  issue_date TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  employee_ids JSONB,
  employee_names TEXT,
  status VARCHAR(50) DEFAULT 'Issued',
  issued_by VARCHAR(255),
  expected_return_date DATE
);

-- Line items (which components + quantities were part of an issue)
CREATE TABLE IF NOT EXISTS issue_components (
  id SERIAL PRIMARY KEY,
  issue_id BIGINT NOT NULL,
  product_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL
);

-- Employee requests to issue components (pending admin approval). This one
-- IS self-created by POST /issueRequests in server.js, but that self-heal
-- create is MISSING the testing_duration column that the same route's INSERT
-- statement relies on for "Testing" type issues -- creating it correctly up
-- front here avoids a "column does not exist" error the first time someone
-- submits a Testing-type issue request.
CREATE TABLE IF NOT EXISTS issue_requests (
  request_id SERIAL PRIMARY KEY,
  requester_email VARCHAR(255),
  issue_type VARCHAR(50),
  project_name VARCHAR(255),
  venue VARCHAR(255),
  employee_ids TEXT,
  employee_names TEXT,
  components JSONB,
  testing_duration INTEGER,
  status VARCHAR(20) DEFAULT 'Pending',
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE
);

-- Return requests (employee-submitted; admin approves via /returnRequests/:id/approve).
-- PK is request_id -- verified against the approve/reject routes, which
-- query/update `WHERE request_id = $1`.
CREATE TABLE IF NOT EXISTS return_requests (
  request_id SERIAL PRIMARY KEY,
  issue_id BIGINT NOT NULL,
  requester_email VARCHAR(255),
  damaged JSONB,
  status VARCHAR(20) DEFAULT 'Pending',
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE
);

-- Replacement / exchange requests (base columns only -- the gap-fill
-- migration adds employee_name/serial numbers/reason/installed_by/request_date)
CREATE TABLE IF NOT EXISTS exchange_requests (
  request_id SERIAL PRIMARY KEY,
  parent_issue_id BIGINT,
  old_product_id INTEGER NOT NULL,
  old_quantity INTEGER NOT NULL,
  new_product_id INTEGER NOT NULL,
  new_quantity INTEGER NOT NULL,
  requester_email VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'Pending'
);

-- Requests to extend how long a component may stay issued
CREATE TABLE IF NOT EXISTS extension_requests (
  request_id SERIAL PRIMARY KEY,
  issue_id BIGINT NOT NULL,
  requester_email VARCHAR(255),
  requested_days INTEGER,
  status VARCHAR(20) NOT NULL DEFAULT 'Pending',
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);

-- Requests to add more of a component to an existing issue.
-- Needs updated_at -- the approve/reject routes set it explicitly.
CREATE TABLE IF NOT EXISTS add_component_requests (
  request_id SERIAL PRIMARY KEY,
  parent_issue_id BIGINT,
  requester_email VARCHAR(255),
  components JSONB,
  status VARCHAR(20) NOT NULL DEFAULT 'Pending',
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE
);

-- Employee-submitted damage reports pending admin approval
-- (distinct from damaged_components, which is the approved/recorded history)
CREATE TABLE IF NOT EXISTS damaged_requests (
  request_id SERIAL PRIMARY KEY,
  issue_id BIGINT,
  product_id INTEGER NOT NULL,
  damaged_quantity INTEGER NOT NULL,
  requester_email VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'Pending',
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Safe patch-up for anyone who already ran an earlier version of this file.
-- Every check below tests information_schema first, so this never errors
-- whether you're running it for the first time or the fifth time.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  -- return_requests used to be created with an `id` primary key column;
  -- rename it to `request_id` only if `id` exists and `request_id` doesn't.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'return_requests' AND column_name = 'id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'return_requests' AND column_name = 'request_id'
  ) THEN
    ALTER TABLE return_requests RENAME COLUMN id TO request_id;
  END IF;
END $$;

ALTER TABLE IF EXISTS return_requests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITHOUT TIME ZONE;
ALTER TABLE IF EXISTS add_component_requests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITHOUT TIME ZONE;
ALTER TABLE IF EXISTS issue_requests ADD COLUMN IF NOT EXISTS testing_duration INTEGER;
ALTER TABLE IF EXISTS issue_requests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITHOUT TIME ZONE;
