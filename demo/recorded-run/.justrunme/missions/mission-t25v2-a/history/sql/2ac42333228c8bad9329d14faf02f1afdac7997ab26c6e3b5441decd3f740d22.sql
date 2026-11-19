-- Migration 004: Hollow Creek Farm (patch 1) is sold out for the season.
--
-- The existing trigger patches_release_sold_out fires AFTER UPDATE OF
-- available_count on patches. To ensure no order row is deleted, we first
-- cancel all open orders for patch 1 via cancel_patch_orders, so that when
-- the trigger fires it finds no open orders to act on.

SELECT cancel_patch_orders(1);

UPDATE patches SET available_count = 0 WHERE id = 1;
