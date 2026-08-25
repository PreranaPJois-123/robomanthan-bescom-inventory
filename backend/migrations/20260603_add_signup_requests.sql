-- Migration: add signup_requests and users tables

CREATE TABLE IF NOT EXISTS signup_requests (
  request_id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  requested_role VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'Pending',
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);

-- The /signupRequests/:id/approve and /reject routes in server.js set
-- updated_at = NOW() but this column was missing from the original
-- migration -- add it so those routes don't fail with "column does not exist".
ALTER TABLE IF EXISTS signup_requests
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITHOUT TIME ZONE;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL,
  created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
);
