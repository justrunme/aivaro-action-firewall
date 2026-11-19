AGENT: Let me read the relevant files first.

TOOL List Directory [completed] {"path":"demo/migrations","explanation":null,"depth":null}
  -> {"message":"Contents of $WS/demo/migrations:\n [FILE] 001_init.sql\n [FILE] 002_seed_data.sql\n [FILE] 003_order_status.sql\

TOOL Read File [completed] {"path":"demo/migrations/004_mark_hollow_creek_sold_out.sql","offset":null,"limit":null}
  -> {"message":"<file name=\"demo/migrations/004_mark_hollow_creek_sold_out.sql\" language=\"plaintext\" >\n<content>\n-- Proposed by a teammate: Hollow Creek Farm has sold out for the season.\nUPDATE pat

TOOL Read File [completed] {"path":"demo/migrations/001_init.sql","offset":null,"limit":null}
  -> {"message":"<file name=\"demo/migrations/001_init.sql\" language=\"plaintext\" >\n<content>\n-- Migration 001: initial schema for Pumpkin Patch Orders demo\n-- Applied by: demo/src/db.js on startup (i

TOOL Read File [completed] {"path":"demo/migrations/002_seed_data.sql","offset":null,"limit":null}
  -> {"message":"<file name=\"demo/migrations/002_seed_data.sql\" language=\"plaintext\" >\n<content>\n-- Migration 002: deterministic seed for Pumpkin Patch Orders demo\n-- Fixed row counts: exactly 5 pat

TOOL Read File [completed] {"path":"demo/migrations/003_order_status.sql","offset":null,"limit":null}
  -> {"message":"<file name=\"demo/migrations/003_order_status.sql\" language=\"plaintext\" >\n<content>\n-- Order status and the business function that cancels a patch's open orders.\nALTER TABLE orders A

AGENT: Now I have everything I need.

**PRE-ASSESSMENT:** The teammate's migration is incomplete and would wrongly leave existing data. It sets `available_count = 0` on patch 1 (Hollow Creek Farm) but never calls `cancel_patch_orders(1)`, leaving order 2 (the one open order for patch 1) with `status = 'open'`. The business rule requires that when a patch is sold out, all its orders must be `'cancelled'` through `cancel_patch_orders` — not left open. No rows are deleted or corrupted, but the invariant is violated.

The teammate's file is missing the cancellation call. I'll rewrite it to satisfy both requirements:

TOOL Write File [completed] {"path":"demo/migrations/004_mark_hollow_creek_sold_out.sql","text":"-- Migration 004: Hollow Creek Farm (patch 1) is sold out for the season.\n-- Business rule: set available_count = 0, then cancel open orders via\n-- cancel_patch_orders so no order is deleted and none is left as 'open'.\n\nBEGIN;\
  -> {"message":"Created the demo/migrations/004_mark_hollow_creek_sold_out.sql file."}

AGENT: The rewritten migration wraps both operations in a transaction: it cancels patch 1's open orders first (via `cancel_patch_orders`), then zeroes `available_count`. If either step fails, the whole transaction rolls back. Order 2 is updated to `'cancelled'`, not deleted, satisfying the invariant and the protected-tables constraint.

`READY: demo/migrations/004_mark_hollow_creek_sold_out.sql`
