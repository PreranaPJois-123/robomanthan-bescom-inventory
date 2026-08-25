-- Migration: Gap-fill features on top of the existing Postgres schema
-- Adds: minimum-quantity/low-stock tracking, stock receiving + suppliers,
-- audit logging, generated-reports registry, and replacement (exchange)
-- history fields. Safe to run multiple times (all IF NOT EXISTS / IF EXISTS).
--
-- Run this once against your existing database:
--   psql "$DATABASE_URL" -f backend/migrations/20260721_gap_fill_features.sql

-- 1) Minimum quantity per component, used for real low-stock alerts
--    (existing UI used a % of original_stock -- this adds an explicit threshold)
ALTER TABLE IF EXISTS products
  ADD COLUMN IF NOT EXISTS min_quantity INTEGER NOT NULL DEFAULT 5;

-- 2) Suppliers
CREATE TABLE IF NOT EXISTS suppliers (
  supplier_id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  contact_info VARCHAR(255),
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);

-- 3) Stock Receiving
CREATE TABLE IF NOT EXISTS stock_received (
  receipt_id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(product_id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  supplier_id INTEGER REFERENCES suppliers(supplier_id),
  supplier_name VARCHAR(255), -- denormalized fallback if supplier_id not chosen from list
  invoice_number VARCHAR(100),
  received_by VARCHAR(255),
  received_by_email VARCHAR(255),
  remarks TEXT,
  received_date TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);

-- 4) Audit Logs (immutable -- application code never issues UPDATE/DELETE on this table)
CREATE TABLE IF NOT EXISTS audit_logs (
  log_id BIGSERIAL PRIMARY KEY,
  actor_email VARCHAR(255),
  actor_role VARCHAR(50),
  action VARCHAR(100) NOT NULL,       -- e.g. 'STOCK_RECEIVED', 'COMPONENT_USED', 'COMPONENT_RETURNED', 'COMPONENT_REPLACED', 'COMPONENT_DAMAGED'
  description TEXT NOT NULL,          -- human readable summary, e.g. "John received 20 Arduino UNO"
  metadata JSONB,                     -- structured details (productId, quantity, etc.)
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs (action);

-- 5) Reports registry (generated PDF/Excel files, including the automatic weekly one)
CREATE TABLE IF NOT EXISTS reports (
  report_id SERIAL PRIMARY KEY,
  report_type VARCHAR(20) NOT NULL,      -- 'daily' | 'weekly' | 'monthly' | 'custom'
  format VARCHAR(10) NOT NULL,           -- 'pdf' | 'excel'
  file_name VARCHAR(255) NOT NULL,
  period_start DATE,
  period_end DATE,
  generated_by VARCHAR(255),             -- 'system-cron' for automatic reports
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);

-- 6) A real "returned" timestamp on issues, used by the dashboard/reports
--    to compute today's/this-week's returns (previously only status='Returned'
--    was recorded, with no date).
ALTER TABLE IF EXISTS issues
  ADD COLUMN IF NOT EXISTS returned_date TIMESTAMP WITHOUT TIME ZONE;

-- 7) Replacement (exchange_requests) history fields
ALTER TABLE IF EXISTS exchange_requests
  ADD COLUMN IF NOT EXISTS employee_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS old_serial_number VARCHAR(100),
  ADD COLUMN IF NOT EXISTS new_serial_number VARCHAR(100),
  ADD COLUMN IF NOT EXISTS reason TEXT,
  ADD COLUMN IF NOT EXISTS installed_by VARCHAR(255),
  ADD COLUMN IF NOT EXISTS request_date TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW();

-- Optional: backfill min_quantity to something proportional to original_stock
-- so existing components don't all show as "at minimum" the moment this runs.
-- Uncomment if you want that behaviour:
-- UPDATE products SET min_quantity = GREATEST(1, ROUND(original_stock * 0.2)) WHERE min_quantity = 5;
