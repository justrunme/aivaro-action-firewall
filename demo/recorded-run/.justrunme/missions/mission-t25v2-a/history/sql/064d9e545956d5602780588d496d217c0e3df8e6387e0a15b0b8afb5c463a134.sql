-- Migration 004: Hollow Creek Farm (patch 1) is sold out for the season.
-- Business rule: when available_count reaches 0, cancel all open orders via
-- cancel_patch_orders so no order is lost or left in an inconsistent state.

BEGIN;

UPDATE patches SET available_count = 0 WHERE id = 1;

SELECT cancel_patch_orders(1);

COMMIT;
