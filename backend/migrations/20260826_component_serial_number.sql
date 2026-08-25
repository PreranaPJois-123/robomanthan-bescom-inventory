-- Adds a proper, database-generated "Serial Number" to bescom_components,
-- distinct from both the internal component_id primary key (never shown
-- to the user) and the optional component_code field (an optional,
-- user-typeable code, shown in the Add/Edit form as "Component Code").
--
-- Requirements this satisfies:
--   - integer, NOT NULL, UNIQUE
--   - automatically generated (DEFAULT nextval() from a dedicated sequence,
--     the same mechanism Postgres uses internally for SERIAL/BIGSERIAL --
--     this is NOT computed client-side as `components.length + 1`, which
--     could collide after deletes or concurrent inserts)
--   - never reused after a component is deleted (sequences only move
--     forward; deleting a row does not roll the sequence back)
--   - existing components each get exactly one number, assigned in a
--     stable order (alphabetical by name, matching how the UI already
--     sorts and displays the components list)
--
-- Safe to re-run: every step is guarded (IF NOT EXISTS / existence checks)
-- so running this twice is a no-op the second time. Does not modify
-- total_quantity, damaged_quantity, damage_reason, status, or name for any
-- existing row -- only adds and backfills the new column.

BEGIN;

CREATE SEQUENCE IF NOT EXISTS bescom_component_serial_seq;

ALTER TABLE bescom_components
  ADD COLUMN IF NOT EXISTS serial_number INTEGER;

-- Backfill only rows that don't already have a serial number (so re-running
-- this migration never reassigns an already-assigned number). Ordered by
-- name (then component_id as a tiebreaker) to match the existing UI sort
-- order, e.g. Adapator -> 1, Antennae -> 2, Antennae connector -> 3, ...
WITH ordered AS (
  SELECT
    component_id,
    ROW_NUMBER() OVER (ORDER BY name, component_id) AS rn
  FROM bescom_components
  WHERE serial_number IS NULL
)
UPDATE bescom_components bc
SET serial_number = (
  SELECT COALESCE((SELECT MAX(serial_number) FROM bescom_components), 0)
) + ordered.rn
FROM ordered
WHERE bc.component_id = ordered.component_id;

-- Advance the sequence past the highest serial number now in use, so the
-- very next INSERT continues from there instead of colliding with a
-- backfilled value. Handled with an explicit IF/ELSE (rather than a bare
-- setval call) because setval(seq, 0, true) is invalid on a fresh/empty
-- table -- Postgres sequences can't be set below their minvalue (1).
DO $$
DECLARE
  max_serial INTEGER;
BEGIN
  SELECT MAX(serial_number) INTO max_serial FROM bescom_components;
  IF max_serial IS NULL THEN
    PERFORM setval('bescom_component_serial_seq', 1, false);
  ELSE
    PERFORM setval('bescom_component_serial_seq', max_serial, true);
  END IF;
END $$;

ALTER TABLE bescom_components
  ALTER COLUMN serial_number SET DEFAULT nextval('bescom_component_serial_seq');

ALTER TABLE bescom_components
  ALTER COLUMN serial_number SET NOT NULL;

-- Tie the sequence's lifetime to the column (so DROP COLUMN would clean it
-- up too), same as Postgres does automatically for a native SERIAL column.
ALTER SEQUENCE bescom_component_serial_seq OWNED BY bescom_components.serial_number;

-- Add the UNIQUE constraint only if it doesn't already exist.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bescom_components_serial_number_key'
  ) THEN
    ALTER TABLE bescom_components
      ADD CONSTRAINT bescom_components_serial_number_key UNIQUE (serial_number);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bescom_components_serial_number
  ON bescom_components (serial_number);

COMMIT;
