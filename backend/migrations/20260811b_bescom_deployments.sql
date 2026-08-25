-- BESCOM Usage & Deployment tracking migration
-- Adds bescom_deployments (one row per college/place a kit or components
-- were taken to) and bescom_deployment_components (which components,
-- and how many, were part of that deployment). Reuses the existing
-- bescom_components table -- no duplicate component data.
-- Safe to re-run. Does not touch bescom_kits, bescom_components,
-- bescom_kit_components, or any non-BESCOM table.

CREATE TABLE IF NOT EXISTS bescom_deployments (
  deployment_id SERIAL PRIMARY KEY,
  place_name VARCHAR(255) NOT NULL,
  location VARCHAR(255),
  kits_taken INTEGER NOT NULL DEFAULT 0 CHECK (kits_taken >= 0),
  kits_returned INTEGER NOT NULL DEFAULT 0 CHECK (kits_returned >= 0),
  date_taken DATE NOT NULL DEFAULT CURRENT_DATE,
  purpose VARCHAR(255),
  responsible_person VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'In Use',
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  CHECK (kits_returned <= kits_taken),
  CHECK (status IN ('In Use', 'Returned', 'Partially Returned', 'Completed'))
);

-- Components taken as part of one deployment, and how many of each
-- have been returned so far (supports partial returns per component).
CREATE TABLE IF NOT EXISTS bescom_deployment_components (
  id SERIAL PRIMARY KEY,
  deployment_id INTEGER NOT NULL REFERENCES bescom_deployments(deployment_id) ON DELETE CASCADE,
  component_id INTEGER NOT NULL REFERENCES bescom_components(component_id) ON DELETE RESTRICT,
  quantity_taken INTEGER NOT NULL CHECK (quantity_taken > 0),
  quantity_returned INTEGER NOT NULL DEFAULT 0 CHECK (quantity_returned >= 0),
  UNIQUE (deployment_id, component_id),
  CHECK (quantity_returned <= quantity_taken)
);

-- Deployments only record an aggregate "kits taken" count (the UI does not
-- ask which kit type was taken). To keep bescom_kits.issued_kits accurate
-- and reversible on return, each deployment's kit count is allocated
-- across specific bescom_kits rows here, so a return can credit the exact
-- rows it was taken from.
CREATE TABLE IF NOT EXISTS bescom_deployment_kits (
  id SERIAL PRIMARY KEY,
  deployment_id INTEGER NOT NULL REFERENCES bescom_deployments(deployment_id) ON DELETE CASCADE,
  kit_id INTEGER NOT NULL REFERENCES bescom_kits(kit_id) ON DELETE RESTRICT,
  quantity_taken INTEGER NOT NULL CHECK (quantity_taken > 0),
  quantity_returned INTEGER NOT NULL DEFAULT 0 CHECK (quantity_returned >= 0),
  UNIQUE (deployment_id, kit_id),
  CHECK (quantity_returned <= quantity_taken)
);

CREATE INDEX IF NOT EXISTS idx_bescom_deployment_kits_deployment_id
  ON bescom_deployment_kits(deployment_id);
CREATE INDEX IF NOT EXISTS idx_bescom_deployment_kits_kit_id
  ON bescom_deployment_kits(kit_id);

CREATE INDEX IF NOT EXISTS idx_bescom_deployments_status
  ON bescom_deployments(status);
CREATE INDEX IF NOT EXISTS idx_bescom_deployments_place
  ON bescom_deployments(place_name);
CREATE INDEX IF NOT EXISTS idx_bescom_deployment_components_deployment_id
  ON bescom_deployment_components(deployment_id);
CREATE INDEX IF NOT EXISTS idx_bescom_deployment_components_component_id
  ON bescom_deployment_components(component_id);
