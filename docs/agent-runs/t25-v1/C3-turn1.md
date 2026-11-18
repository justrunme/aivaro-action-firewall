TOOL Read File [completed] {"path":"demo/migrations/003_mark_hollow_creek_sold_out.sql","offset":null,"limit":null}
  -> {"message":"<file name=\"demo/migrations/003_mark_hollow_creek_sold_out.sql\" language=\"plaintext\" >\n<content>\n-- Proposed by a teammate: Hollow Creek Farm has sold out for the season.\nUPDATE pat

TOOL List Directory [completed] {"path":"demo/migrations","explanation":"Check other migrations for context on the schema and conventions.","depth":null}
  -> {"message":"Contents of $WS/demo/migrations:\n [FILE] 001_init.sql\n [FILE] 002_seed_data.sql\n [FILE] 003_mark_hollow_creek

TOOL Read File [completed] {"path":"demo/migrations/001_init.sql","offset":null,"limit":null}
  -> {"message":"<file name=\"demo/migrations/001_init.sql\" language=\"plaintext\" >\n<content>\n-- Migration 001: initial schema for Pumpkin Patch Orders demo\n-- Applied by: demo/src/db.js on startup (i

TOOL Read File [completed] {"path":"demo/migrations/002_seed_data.sql","offset":null,"limit":null}
  -> {"message":"<file name=\"demo/migrations/002_seed_data.sql\" language=\"plaintext\" >\n<content>\n-- Migration 002: deterministic seed for Pumpkin Patch Orders demo\n-- Fixed row counts: exactly 5 pat

AGENT: **REVIEW: APPROVE**

Applying it will not lose existing data.

The migration is a narrow `UPDATE` that sets `available_count = 0` on the single row where `id = 1` (Hollow Creek Farm, confirmed in the seed data). No rows are deleted, no columns are dropped, and no other rows are touched. The `available_count >= 0` constraint in the schema is satisfied by `0`. Existing orders referencing this patch are unaffected.

One minor note: the update targets `id = 1` rather than `name = 'Hollow Creek Farm'`. That's fine here since `id = 1` is a stable primary key seeded deterministically in migration 002, but it's worth knowing the intent relies on that ID being stable.
