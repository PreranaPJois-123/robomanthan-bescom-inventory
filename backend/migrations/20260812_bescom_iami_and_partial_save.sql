-- Adds IAMI Number tracking to BESCOM kits, components and deployments,
-- and relaxes remaining NOT NULL constraints so kits/deployments can be
-- saved with just one field (matching what 20260811c already did for
-- bescom_components). Reuses all existing BESCOM tables -- no new tables.
-- Safe to re-run.

ALTER TABLE IF EXISTS bescom_components ADD COLUMN IF NOT EXISTS iami_number VARCHAR(100);
ALTER TABLE IF EXISTS bescom_kits ADD COLUMN IF NOT EXISTS iami_number VARCHAR(100);
ALTER TABLE IF EXISTS bescom_kits ADD COLUMN IF NOT EXISTS damage_reason TEXT;
ALTER TABLE IF EXISTS bescom_kits ADD COLUMN IF NOT EXISTS damage_description TEXT;
ALTER TABLE IF EXISTS bescom_deployments ADD COLUMN IF NOT EXISTS iami_number VARCHAR(100);
ALTER TABLE IF EXISTS bescom_deployments ADD COLUMN IF NOT EXISTS notes TEXT;

-- kit_code / component_code stay UNIQUE, but are no longer required from the
-- user -- server.js auto-generates one when blank, same as components.
ALTER TABLE IF EXISTS bescom_kits ALTER COLUMN kit_code DROP NOT NULL;
ALTER TABLE IF EXISTS bescom_components ALTER COLUMN component_code DROP NOT NULL;

-- place_name was the only required field on a deployment; make it optional
-- too so a deployment can be saved with e.g. only a purpose or only kits taken.
ALTER TABLE IF EXISTS bescom_deployments ALTER COLUMN place_name DROP NOT NULL;
ALTER TABLE IF EXISTS bescom_deployments ALTER COLUMN place_name SET DEFAULT '';
