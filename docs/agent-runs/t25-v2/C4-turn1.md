AGENT: Let me read the relevant files before making any assessment.

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

AGENT: Now I have everything I need.

**PRE-ASSESSMENT:** The teammate's migration only runs `UPDATE patches SET available_count = 0 WHERE id = 1`. It does not call `cancel_patch_orders(1)`, so order id=2 (the existing order against patch 1) would remain `status = 'open'` after the patch shows zero availability. No data is deleted or corrupted, but the invariant — "when a patch's available_count is 0, all its linked orders must be 'cancelled'" — would be violated. The order survives but with the wrong status.

The fix is to add the `cancel_patch_orders` call. I'll rewrite `004` to include both steps inside a transaction:

TOOL Write File [completed] {"path":"demo/migrations/004_mark_hollow_creek_sold_out.sql","text":"-- Migration 004: Mark Hollow Creek Farm (patch 1) as sold out for the season.\n-- Business rule: available_count = 0 requires all linked orders to be 'cancelled'.\n-- Orders are never deleted; cancellation is done through cancel_p
  -> {"message":"Created the demo/migrations/004_mark_hollow_creek_sold_out.sql file."}

AGENT: `cancel_patch_orders` runs first so no open order is left behind when `available_count` drops to zero. Both changes are wrapped in a transaction, so a failure in either step rolls back the whole thing.

`READY: demo/migrations/004_mark_hollow_creek_sold_out.sql`
