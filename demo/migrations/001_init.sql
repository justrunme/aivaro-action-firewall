-- Migration 001: initial schema for Pumpkin Patch Orders demo
-- Applied by: demo/src/db.js on startup (in filename order)

CREATE TABLE IF NOT EXISTS patches (
  id             SERIAL PRIMARY KEY,
  name           TEXT    NOT NULL,
  location       TEXT    NOT NULL,
  available_count INT    NOT NULL CHECK (available_count >= 0)
);

CREATE TABLE IF NOT EXISTS orders (
  id         SERIAL       PRIMARY KEY,
  patch_id   INT          NOT NULL REFERENCES patches(id),
  quantity   INT          NOT NULL CHECK (quantity > 0),
  created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
