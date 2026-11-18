# JustRunMe Roadmap

Everything on this page is **NOT IMPLEMENTED** unless a row says otherwise.
Nothing here may be presented as a working feature in the README, the video or
the submission text. Priorities: P1 and P2 are planned before the Kiroween
deadline if the main chain (Rehearse, Run, Recover) already works. P3 is after
the contest.

| Idea | What it would do | Priority | Spec |
|------|------------------|----------|------|
| Counterfactual Replay screen in the Console | A Console view over the existing comparison (T17, `justrunme compare`, which is implemented): the rehearsed plans side by side, the fixed rule and the signed `plan_selected` receipt. The comparison itself is not on this page because it is implemented | P1 | R15 |
| LOGIC BYPASS detection | See a trigger or constraint switched off inside a plan (event trigger in the rehearsal copy, statement log, trigger firing counts); found by T25 v1 | P1 | none yet |
| Chaos Twin | Rehearse a plan with one injected fault at a named operation marker and report the resulting state | P2 | R16 |
| Phone passkey approval | WebAuthn assertion bound to the action payload hash | P2 | R6.8 |
| Fidelity override with signed justification | Operator overrides a fingerprint mismatch with a signed reason | P2 | R3.4 |
| Ghost Agent | Proposes adversarial scenarios (interrupt, re-run, schema change) that JustRunMe runs in the disposable copy. A deterministic rule set comes first; an LLM-driven version needs credentials and is excluded from judge mode | P3 | none |
| Pruning of `<db>_jrm_prev_<t>` databases | Undo keeps the replaced database for inspection; a command to list and drop old ones with a retention limit (explicit operator action, never automatic) | P2 | none |
| Recovery suggestion | Suggest a restore plan after a failed run. Undo itself always needs an explicit operator command | P3 | none |
| Multi-agent missions | Several agents working under one contract | P3 | none |
| Extension catalogue | Pluggable agent capabilities | P3 | none |

## Notes on merged ideas

- Intent contracts are the Mission Contract (R1).
- The execution drift guard is the fidelity fingerprint (R3).
- Incident investigation and the visual action history are Mission Replay built
  only from signed receipts (R8, T18).
- Whole-mission rollback is Undo Mission (R4, R5). The public name is
  "Undo Mission".

## Rules for moving an item out of this page

1. A requirement with an ID exists in `requirements.md`.
2. There is an end-to-end test that passes in CI.
3. Only then may the README mention it as working.
