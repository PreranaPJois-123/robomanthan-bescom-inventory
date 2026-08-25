-- BESCOM module migration
-- Adds bescom_kits, bescom_components, and the bescom_kit_components
-- join table (required quantity of each component per kit).
-- Safe to re-run (uses IF NOT EXISTS throughout).
-- Does not touch any existing SmartStock tables.

CREATE TABLE IF NOT EXISTS bescom_components (
  component_id SERIAL PRIMARY KEY,
  component_code VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(100),
  total_quantity INTEGER NOT NULL DEFAULT 0 CHECK (total_quantity >= 0),
  issued_quantity INTEGER NOT NULL DEFAULT 0 CHECK (issued_quantity >= 0),
  damaged_quantity INTEGER NOT NULL DEFAULT 0 CHECK (damaged_quantity >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'Active',
  description TEXT,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  CHECK (issued_quantity + damaged_quantity <= total_quantity)
);

CREATE TABLE IF NOT EXISTS bescom_kits (
  kit_id SERIAL PRIMARY KEY,
  kit_code VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  kit_type VARCHAR(100),
  total_kits INTEGER NOT NULL DEFAULT 0 CHECK (total_kits >= 0),
  issued_kits INTEGER NOT NULL DEFAULT 0 CHECK (issued_kits >= 0),
  damaged_kits INTEGER NOT NULL DEFAULT 0 CHECK (damaged_kits >= 0),
  status VARCHAR(20) NOT NULL DEFAULT 'Active',
  description TEXT,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  CHECK (issued_kits + damaged_kits <= total_kits)
);

-- One kit -> many components, with the quantity of each component
-- required per single kit.
CREATE TABLE IF NOT EXISTS bescom_kit_components (
  id SERIAL PRIMARY KEY,
  kit_id INTEGER NOT NULL REFERENCES bescom_kits(kit_id) ON DELETE CASCADE,
  component_id INTEGER NOT NULL REFERENCES bescom_components(component_id) ON DELETE RESTRICT,
  required_quantity INTEGER NOT NULL CHECK (required_quantity > 0),
  UNIQUE (kit_id, component_id)
);

CREATE INDEX IF NOT EXISTS idx_bescom_kit_components_kit_id
  ON bescom_kit_components(kit_id);
CREATE INDEX IF NOT EXISTS idx_bescom_kit_components_component_id
  ON bescom_kit_components(component_id);
CREATE INDEX IF NOT EXISTS idx_bescom_components_name
  ON bescom_components(name);
CREATE INDEX IF NOT EXISTS idx_bescom_kits_name
  ON bescom_kits(name);
