-- Migration: Add damaged tracking and damaged_components table
-- Run this file once against your PostgreSQL database (ProductManager)

-- 1) Ensure `damaged` column exists on products
ALTER TABLE IF EXISTS products
  ADD COLUMN IF NOT EXISTS damaged INTEGER DEFAULT 0;

-- 2) Create damaged_components table to record damaged items during returns
CREATE TABLE IF NOT EXISTS damaged_components (
  id SERIAL PRIMARY KEY,
  issue_id BIGINT NOT NULL,
  product_id INTEGER NOT NULL,
  damaged_quantity INTEGER NOT NULL,
  quantity_issued INTEGER,
  issue_type VARCHAR(50),
  project_name VARCHAR(255),
  return_date TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);

-- 3) (Optional) Ensure original_stock column exists (used by frontend/server seed logic)
ALTER TABLE IF EXISTS products
  ADD COLUMN IF NOT EXISTS original_stock INTEGER;

-- If original_stock is null, you may want to set it equal to current stock for existing rows:
-- UPDATE products SET original_stock = stock WHERE original_stock IS NULL;
