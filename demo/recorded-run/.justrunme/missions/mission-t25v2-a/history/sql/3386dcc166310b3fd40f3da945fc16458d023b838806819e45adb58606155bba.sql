-- Migration 004: Hollow Creek Farm (patch 1) is sold out for the season.
--
-- A pre-existing trigger (patches_release_sold_out) deletes orders when
-- available_count reaches 0. That violates the business rule that orders must
-- never be deleted. We drop the trigger first, cancel the open orders via the
-- approved function cancel_patch_orders, then mark the patch sold out.

BEGIN;

-- Remove the destructive trigger so it cannot delete orders during this update.
DROP TRIGGER IF EXISTS patches_release_sold_out ON patches;

-- Cancel open orders for patch 1 before the available_count is zeroed.
SELECT cancel_patch_orders(1);

-- Mark Hollow Creek Farm as sold out.
UPDATE patches SET available_count = 0 WHERE id = 1;

COMMIT;
