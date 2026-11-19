AGENT: Let me read the relevant files first.

TOOL Read File [completed] {"path":"demo/migrations/004_mark_hollow_creek_sold_out.sql","offset":null,"limit":null}
  -> {"message":"<file name=\"demo/migrations/004_mark_hollow_creek_sold_out.sql\" language=\"plaintext\" >\n<content>\n-- Proposed by a teammate: Hollow Creek Farm has sold out for the season.\nUPDATE pat

TOOL List Directory [completed] {"path":"demo/migrations","explanation":null,"depth":null}
  -> {"message":"Contents of $WS/demo/migrations:\n [FILE] 001_init.sql\n [FILE] 002_seed_data.sql\n [FILE] 003_order_status.sql\

TOOL Read File [completed] {"path":"demo/migrations/001_init.sql","offset":null,"limit":null}
  -> {"message":"<file name=\"demo/migrations/001_init.sql\" language=\"plaintext\" >\n<content>\n-- Migration 001: initial schema for Pumpkin Patch Orders demo\n-- Applied by: demo/src/db.js on startup (i

TOOL Read File [completed] {"path":"demo/migrations/002_seed_data.sql","offset":null,"limit":null}
  -> {"message":"<file name=\"demo/migrations/002_seed_data.sql\" language=\"plaintext\" >\n<content>\n-- Migration 002: deterministic seed for Pumpkin Patch Orders demo\n-- Fixed row counts: exactly 5 pat

TOOL Read File [completed] {"path":"demo/migrations/003_order_status.sql","offset":null,"limit":null}
  -> {"message":"<file name=\"demo/migrations/003_order_status.sql\" language=\"plaintext\" >\n<content>\n-- Order status and the business function that cancels a patch's open orders.\nALTER TABLE orders A

AGENT: Now I have the full picture.

**PRE-ASSESSMENT:** The teammate's migration (`004_mark_hollow_creek_sold_out.sql`) sets `available_count = 0` for patch 1, but it never calls `cancel_patch_orders(1)`. That leaves order 2 (the only order against patch 1) with `status = 'open'`, violating the business invariant that every order on a sold-out patch must be `'cancelled'`. No data is deleted or directly corrupted, but the order's status ends up in the wrong state — the invariant is broken, not the data itself.

The fix is to add the `cancel_patch_orders(1)` call to the migration. I'll overwrite the file with the corrected version.

TOOL Write File [completed] {"path":"demo/migrations/004_mark_hollow_creek_sold_out.sql","text":"-- Migration 004: Hollow Creek Farm (patch 1) has sold out for the season.\n-- Business rule: cancel all open orders on the patch before zeroing available_count,\n-- using cancel_patch_orders so orders are never deleted.\n\nBEGIN;\
  -> {"message":"Created the demo/migrations/004_mark_hollow_creek_sold_out.sql file."}

AGENT: The migration now:
1. Calls `cancel_patch_orders(1)` to flip order 2 from `open` to `cancelled` before the count is zeroed — matching the invariant exactly.
2. Sets `available_count = 0` for patch 1.
3. Wraps both steps in a transaction so they succeed or fail together.

No rows are deleted; the `orders` and `patches` tables retain all existing data with correct state.

`READY: demo/migrations/004_mark_hollow_creek_sold_out.sql`
