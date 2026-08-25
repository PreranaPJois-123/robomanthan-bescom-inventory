-- BESCOM-only cleanup migration
--
-- This application has been converted into a single-tenant, BESCOM-only
-- inventory system, restricted to a single authorized account
-- (saurav@robomanthan.com, enforced in backend/server.js).
--
-- This migration permanently drops every table that belonged to the old
-- "SmartStock" product/issue/customer system, plus its request/workflow
-- tables and the login accounts that went with it. Nothing here touches
-- any bescom_* table, and it explicitly does NOT touch:
--   - bescom_components, bescom_kits, bescom_kit_components
--   - bescom_deployments, bescom_deployment_components, bescom_deployment_kits
--   - audit_logs        (shared, append-only; already only ever written to
--                         by BESCOM routes going forward)
--   - damage_history     (shared; keeps its 'bescom_component'/'bescom_kit' rows)
--
-- This is destructive and irreversible -- take a database backup/export
-- before running it if you want to keep the old SmartStock data anywhere.
--
-- Run:
--   psql "$DATABASE_URL" -f backend/migrations/20260825_bescom_only_cleanup.sql

BEGIN;

-- Historical audit log entries from the old SmartStock routes (all of
-- which used non-BESCOM action names: COMPONENT_TAKEN, COMPONENT_USED,
-- COMPONENT_RETURNED, COMPONENT_DAMAGED, STOCK_RECEIVED, PRODUCT_UPDATED,
-- PRODUCT_DELETED). audit_logs is otherwise append-only by design; this is
-- a one-time removal of rows that reference a data model that no longer
-- exists, not an ongoing pattern of editing the audit trail. Every action
-- BESCOM writes is prefixed BESCOM_, so this keeps 100% of BESCOM history.
-- Guarded with a table-existence check so this migration also runs cleanly
-- on a brand new database that never had the gap-fill audit_logs table.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'audit_logs') THEN
    DELETE FROM audit_logs WHERE action NOT LIKE 'BESCOM_%';
  END IF;
END $$;

-- Any historical damage_history rows that were logged against the old
-- SmartStock product catalog (module = 'product') are no longer
-- meaningful once the products table itself is gone. BESCOM's own rows
-- (module = 'bescom_component' / 'bescom_kit') are left untouched.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'damage_history') THEN
    DELETE FROM damage_history WHERE module = 'product';
  END IF;
END $$;

-- Request/workflow tables (depend on issues/products)
DROP TABLE IF EXISTS issue_requests CASCADE;
DROP TABLE IF EXISTS return_requests CASCADE;
DROP TABLE IF EXISTS exchange_requests CASCADE;
DROP TABLE IF EXISTS extension_requests CASCADE;
DROP TABLE IF EXISTS add_component_requests CASCADE;
DROP TABLE IF EXISTS damaged_requests CASCADE;

-- Issue / usage tracking
DROP TABLE IF EXISTS issue_components CASCADE;
DROP TABLE IF EXISTS issues CASCADE;

-- Customer-facing "take/return" transactions
DROP TABLE IF EXISTS customer_transactions CASCADE;

-- Damaged-stock history tied to the old product catalog
DROP TABLE IF EXISTS damaged_components CASCADE;

-- Stock receiving / suppliers / generated reports registry
DROP TABLE IF EXISTS stock_received CASCADE;
DROP TABLE IF EXISTS suppliers CASCADE;
DROP TABLE IF EXISTS reports CASCADE;

-- The product catalog itself
DROP TABLE IF EXISTS products CASCADE;

-- Accounts: signup requests and the multi-user accounts table. Access is
-- now a single hard-coded, backend-enforced account, so there is no
-- longer any concept of stored user records or self-service signup.
DROP TABLE IF EXISTS signup_requests CASCADE;
DROP TABLE IF EXISTS users CASCADE;

COMMIT;
