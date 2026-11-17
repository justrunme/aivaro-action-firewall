/**
 * Exit codes of the justrunme CLI (T18). Stable: CI scripts may depend on them.
 * Every non-zero result also prints JSON with `error.code` naming the exact reason.
 */

export const EXIT = Object.freeze({
  OK: 0, // command did what was asked; for rehearse: verdict SAFE
  INTERNAL: 1, // unexpected error (bug or environment failure)
  USAGE: 2, // unknown command, missing or invalid argument
  CONFIG: 3, // contract or target file invalid, operator key missing
  DATA_LOSS: 10, // rehearse: verdict DATA LOSS (measured, nothing real touched)
  REHEARSAL_FAILED: 11, // rehearse: a step failed in the copy, or the copy did not start
  NO_PLAN_SELECTED: 12, // compare: no plan survived the rule
  RUN_FAILED: 13, // run: a step failed in the real run; the capture is ready for undo
  RECOVERY_FAILED: 14, // undo: restore or verification did not reach RECOVERED
  COMPARISON_REFUSED: 20, // compare refused (base or conditions differ, report invalid, ...)
  AUTHORIZATION_REFUSED: 21, // authorize refused (DATA_LOSS, FIDELITY_MISMATCH, PLAN_NOT_SELECTED, ...)
  RUN_REFUSED: 22, // run refused (no authorization, expired, target changed, ...)
  UNDO_REFUSED: 23, // undo refused (capture invalid, unsupported resource)
  MAINTENANCE_REFUSED: 24, // reanchor or lock recovery refused
  REHEARSAL_REFUSED: 25, // rehearse refused before running anything (SELF_REFERENCE, UNBINDABLE_STEP, CHAIN_INVALID)
  RUN_INCOMPLETE: 15, // run: completed, but steps that need approval were skipped
  REHEARSAL_UNCLEAN: 16, // rehearse: copy not fully removed (containers, volumes, network or worktree left)
  EMERGENCY_RECOVERED: 17, // undo --emergency-recovery: RECOVERED and verified, evidence_status "unverified" (journal, not chain)
  INTEGRITY: 30, // verify or replay found a broken chain, a policy violation or a bad selection;
  //               or a command did its work but could not record it (error.code RESULT_UNRECORDED)
  CHAIN_LOCKED: 31, // the receipt chain lock is held or stuck; see `justrunme lock inspect`
})

/** Exit code for a rehearsal verdict. */
export const verdictExit = (verdict) => (verdict === 'SAFE' ? EXIT.OK : verdict === 'DATA LOSS' ? EXIT.DATA_LOSS : EXIT.REHEARSAL_FAILED)
