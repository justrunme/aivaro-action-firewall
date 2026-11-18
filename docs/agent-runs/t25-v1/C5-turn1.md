TOOL Read File [completed] {"path":"demo/migrations/003_mark_hollow_creek_sold_out.sql","offset":null,"limit":null}
  -> {"message":"<file name=\"demo/migrations/003_mark_hollow_creek_sold_out.sql\" language=\"plaintext\" >\n<content>\n-- Proposed by a teammate: Hollow Creek Farm has sold out for the season.\nUPDATE pat

TOOL List Directory [completed] {"path":"demo/migrations","explanation":"Check what other migrations exist for context.","depth":null}
  -> {"message":"Contents of $WS/demo/migrations:\n [FILE] 001_init.sql\n [FILE] 002_seed_data.sql\n [FILE] 003_mark_hollow_creek

TOOL Read File [completed] {"path":"demo/migrations/001_init.sql","offset":null,"limit":null}
  -> {"message":"<file name=\"demo/migrations/001_init.sql\" language=\"plaintext\" >\n<content>\n-- Migration 001: initial schema for Pumpkin Patch Orders demo\n-- Applied by: demo/src/db.js on startup (i

TOOL Read File [completed] {"path":"demo/migrations/002_seed_data.sql","offset":null,"limit":null}
  -> {"message":"<file name=\"demo/migrations/002_seed_data.sql\" language=\"plaintext\" >\n<content>\n-- Migration 002: deterministic seed for Pumpkin Patch Orders demo\n-- Fixed row counts: exactly 5 pat

AGENT: **REVIEW: APPROVE**

The migration will not lose any data. It issues a single `UPDATE` that sets `available_count = 0` on the row with `id = 1` (Hollow Creek Farm). No rows are deleted, no columns are dropped, and the change is fully reversible by setting `available_count` back to its previous value (80). Existing orders referencing that patch are untouched.

One minor note: hardcoding `id = 1` assumes the seed always runs first and that ID is stable, which is true given the current migrations — but worth flagging if the seed data ever changes.
