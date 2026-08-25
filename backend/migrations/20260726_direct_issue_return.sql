-- Direct Issue/Return Workflow migration
-- Adds rack tracking + description to products, and a single
-- customer_transactions table that replaces the old *_requests
-- approval tables. Safe to re-run.

ALTER TABLE products ADD COLUMN IF NOT EXISTS rack_number VARCHAR(50);
ALTER TABLE products ADD COLUMN IF NOT EXISTS description TEXT;

CREATE TABLE IF NOT EXISTS customer_transactions (
  transaction_id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES users(id),
  customer_name VARCHAR(255) NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(product_id),
  quantity INTEGER NOT NULL,
  project_name VARCHAR(255) NOT NULL,
  purpose VARCHAR(255) NOT NULL,
  rack_number VARCHAR(50),
  issue_date TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
  return_date TIMESTAMP WITHOUT TIME ZONE,
  status VARCHAR(20) NOT NULL DEFAULT 'Issued' -- 'Issued' | 'Returned'
);

CREATE INDEX IF NOT EXISTS idx_customer_transactions_customer_id
  ON customer_transactions(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_transactions_status
  ON customer_transactions(status);

-- Drop the old request/approval tables now that the direct issue/return
-- workflow replaces them. These are no longer referenced by server.js.
DROP TABLE IF EXISTS issue_requests;
DROP TABLE IF EXISTS return_requests;
DROP TABLE IF EXISTS exchange_requests;
DROP TABLE IF EXISTS extension_requests;
DROP TABLE IF EXISTS add_component_requests;
DROP TABLE IF EXISTS damaged_requests;
DROP TABLE IF EXISTS signup_requests;
