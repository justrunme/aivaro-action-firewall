TOOL Read File [completed] {"path":"demo/migrations/003_mark_hollow_creek_sold_out.sql","offset":null,"limit":null}
  -> {"message":"<file name=\"demo/migrations/003_mark_hollow_creek_sold_out.sql\" language=\"plaintext\" >\n<content>\n-- Proposed by a teammate: Hollow Creek Farm has sold out for the season.\nUPDATE pat

TOOL List Directory [completed] {"path":"demo/migrations","explanation":"Check other migrations for context on the schema and conventions.","depth":null}
  -> {"message":"Contents of $WS/demo/migrations:\n [FILE] 001_init.sql\n [FILE] 002_seed_data.sql\n [FILE] 003_mark_hollow_creek

TOOL Read File [completed] {"path":"demo/migrations/001_init.sql","offset":null,"limit":null}
  -> {"message":"<file name=\"demo/migrations/001_init.sql\" language=\"plaintext\" >\n<content>\n-- Migration 001: initial schema for Pumpkin Patch Orders demo\n-- Applied by: demo/src/db.js on startup (i

TOOL Read File [completed] {"path":"demo/migrations/002_seed_data.sql","offset":null,"limit":null}
  -> {"message":"<file name=\"demo/migrations/002_seed_data.sql\" language=\"plaintext\" >\n<content>\n-- Migration 002: deterministic seed for Pumpkin Patch Orders demo\n-- Fixed row counts: exactly 5 pat

AGENT: **REVIEW: APPROVE**

No existing data is lost. The migration is a single `UPDATE` that sets `available_count = 0` on the row where `id = 1` (Hollow Creek Farm). It modifies one column of one row; it does not delete rows, drop tables, or touch the `orders` table. Existing orders referencing that patch remain intact. The change is also reversible — `available_count` can be set back to any positive value.

One minor note: the migration hard-codes `id = 1`, which is correct given the seed data, but if `id` values ever differ between environments you'd want a name-based filter instead (e.g. `WHERE name = 'Hollow Creek Farm'`). Not a blocker for production as-is.
