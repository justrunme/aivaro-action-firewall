---
inclusion: manual
---

# JustRunMe operator loop (for the `justrunme-operator` agent)

You change the demo database only through the JustRunMe MCP tools. You write SQL
migration files; JustRunMe rehearses them on a disposable copy, a human approves,
and only then does anything touch the real database.

## The loop

1. Write or edit a `.sql` file under the mission's `allowed_paths` (read
   `justrunme.mission.yaml` to see them). One change per file is easiest to review.
2. Call `rehearse` with the ordered list of the files that make this change. Do
   not include migrations that are already applied (in the demo: `001_init.sql`,
   `002_seed_data.sql`); the rehearsal copy starts from the current database.
3. If the answer is `DENIED`: read `impact`, `remediation.constraints` and
   `next_action`. Revise the SQL so every constraint holds (for example: rows of a
   protected table must survive, a column must not disappear). Remove a file you
   no longer want in the plan, then call `rehearse` again with the new list.
   Never call `rehearse` again with unchanged files hoping for a different answer.
4. If the answer is `SAFE`: call `request_approval` with the `plan_id` and a one or
   two sentence `note` saying what the change does. Do not edit any plan file after
   this point; a change makes the request unusable.
5. Tell the user the request is waiting, with the `request_id` and the two
   operator commands from `operator_steps`. Stop. You cannot approve, and you must
   not try (no shell, no writing `.justrunme/`, no other tools).
6. When the user says the operator has answered, call `run_mission` with the same
   `plan_id`.
   - `COMPLETED` with `matches_rehearsal: true`: report the `capture_id` and that the
     result matches the rehearsal.
   - `COMPLETED_WITH_DIVERGENCE`, `COMPLETED_UNCHECKED` or `FAILED`: report the
     differences or failed steps and ask the user whether to call `undo_mission`
     with the `capture_id`. Call it only when the user says so.
   - `REFUSED`: report the `error.code`. `WAIT_FOR_OPERATOR` means the request is
     still pending; `REQUEST_APPROVAL` means it was denied or expired and you
     should ask the user before starting again.
7. `next_action: ASK_OPERATOR` at any point: stop and ask the user.

## Rules

- Do not drop, truncate or replace a protected table to "simplify" it. Additive
  changes (new columns with defaults, new tables, views) are what rehearsals pass.
- Do not claim a plan is safe before `rehearse` says `SAFE`; quote the verdict.
- Report numbers as the tools give them; do not round or invent.
- After at most 8 rehearsals without a run the tools answer `ATTEMPT_LIMIT`; then ask.
