AGENT: Let me read the relevant files first.

TOOL Read File [completed] {"path":"demo/migrations/004_mark_hollow_creek_sold_out.sql","offset":null,"limit":null}
  -> {"message":"<file name=\"demo/migrations/004_mark_hollow_creek_sold_out.sql\" language=\"plaintext\" >\n<content>\n-- Proposed by a teammate: Hollow Creek Farm has sold out for the season.\nUPDATE pat

TOOL List Directory [completed] {"path":"demo/migrations","explanation":"See all migration files present","depth":null}
  -> {"message":"Contents of $WS/demo/migrations:\n [FILE] 001_init.sql\n [FILE] 002_seed_data.sql\n [FILE] 003_order_status.sql\

TOOL Read File [completed] {"path":"demo/migrations/001_init.sql","offset":null,"limit":null}
  -> {"message":"<file name=\"demo/migrations/001_init.sql\" language=\"plaintext\" >\n<content>\n-- Migration 001: initial schema for Pumpkin Patch Orders demo\n-- Applied by: demo/src/db.js on startup (i

TOOL Read File [completed] {"path":"demo/migrations/002_seed_data.sql","offset":null,"limit":null}
  -> {"message":"<file name=\"demo/migrations/002_seed_data.sql\" language=\"plaintext\" >\n<content>\n-- Migration 002: deterministic seed for Pumpkin Patch Orders demo\n-- Fixed row counts: exactly 5 pat

TOOL Read File [completed] {"path":"demo/migrations/003_order_status.sql","offset":null,"limit":null}
  -> {"message":"<file name=\"demo/migrations/003_order_status.sql\" language=\"plaintext\" >\n<content>\n-- Order status and the business function that cancels a patch's open orders.\nALTER TABLE orders A

AGENT: Now I have everything I need.

**PRE-ASSESSMENT:** The teammate's migration sets `available_count = 0` on patch 1 but never calls `cancel_patch_orders(1)`. That leaves order 2 (the existing open order against patch 1) with `status = 'open'`, which violates the business invariant: a sold-out patch must have all its orders in `'cancelled'` status. No data is deleted or corrupted, but the invariant is broken — the order ends up in a wrong state.

The fix is straightforward: call `cancel_patch_orders(1)` in the same migration, after the `UPDATE`.

TOOL Write File [completed] {"path":"demo/migrations/004_mark_hollow_creek_sold_out.sql","text":"-- Mark Hollow Creek Farm (patch 1) as sold out for the season.\n-- Business rule: orders are never deleted; open orders must be cancelled\n-- through cancel_patch_orders before (or alongside) zeroing available_count.\nSELECT cance
  -> {"message":"Created the demo/migrations/004_mark_hollow_creek_sold_out.sql file."}

AGENT: The cancellation runs first so that by the time `available_count` hits 0 the invariant already holds. Order 2 (5 pumpkins from Hollow Creek Farm, status `'open'`) will be moved to `'cancelled'`; the row is preserved and no other patches or orders are touched.

`READY: demo/migrations/004_mark_hollow_creek_sold_out.sql`
