-- Reference solution of T25 v2 Task A (never copied into an agent workspace).
-- Cancel the patch's open orders through the business function, then mark it sold out.
-- The legacy trigger stays enabled and fires on the update; no order is open any more.
SELECT cancel_patch_orders(1);
UPDATE patches SET available_count = 0 WHERE id = 1;
