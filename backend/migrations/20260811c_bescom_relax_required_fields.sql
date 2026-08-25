-- Relax BESCOM required-field constraints so a record can be saved with
-- only one piece of information filled in (per updated requirements).
-- component_code / kit_code stay UNIQUE (server.js auto-generates one
-- when the user doesn't type one), but name is no longer NOT NULL, and
-- damage reason/description columns are added.
-- Safe to re-run.

ALTER TABLE IF EXISTS bescom_components ALTER COLUMN name DROP NOT NULL;
ALTER TABLE IF EXISTS bescom_components ALTER COLUMN name SET DEFAULT '';
ALTER TABLE IF EXISTS bescom_components ADD COLUMN IF NOT EXISTS damage_reason TEXT;
ALTER TABLE IF EXISTS bescom_components ADD COLUMN IF NOT EXISTS damage_description TEXT;
ALTER TABLE IF EXISTS bescom_components ADD COLUMN IF NOT EXISTS notes TEXT;

ALTER TABLE IF EXISTS bescom_kits ALTER COLUMN name DROP NOT NULL;
ALTER TABLE IF EXISTS bescom_kits ALTER COLUMN name SET DEFAULT '';
ALTER TABLE IF EXISTS bescom_kits ADD COLUMN IF NOT EXISTS notes TEXT;

-- Simple append-only damage history so damage records aren't overwritten.
-- Works for BESCOM components/kits and (module column) can also be reused
-- generically if extended later.
CREATE TABLE IF NOT EXISTS damage_history (
  id SERIAL PRIMARY KEY,
  module VARCHAR(50) NOT NULL,          -- 'bescom_component' | 'bescom_kit' | 'product'
  item_id INTEGER NOT NULL,
  item_name VARCHAR(255),
  damaged_quantity INTEGER NOT NULL DEFAULT 0,
  damage_reason VARCHAR(255),
  damage_description TEXT,
  recorded_by VARCHAR(255),
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_damage_history_module_item
  ON damage_history(module, item_id);
