# Self-evaluation baseline

`baseline-self.json` is an explicitly approved snapshot of the production retrieval path. Do not refresh it automatically to make the regression gate pass.

`baseline-patch-deterministic.json` is the environment-independent patch-task
floor. Its purpose-built fixture measures symbol hit@5, MRR, edit-file
precision/recall, affected-test recall, abstention correctness, and payload.
The deterministic mode must always score; explicit hybrid mode is reported as
an environmental skip when no active embedding rows/backend exist. Run
`npm run eval:patch:fixture` to compare against it, or `npm run eval:patch` to
compare deterministic, auto, and forced-hybrid retrieval on Cartograph's live
self index. The initial snapshot was captured on 2026-07-23 with all five
fixture tasks passing, hit@5/test recall/abstention/MRR at 1.0, and mean
edit-file precision 0.87. Two consecutive runs had identical correctness,
result membership, edit/test selection, and payload bytes.

## 2026-07-10 refresh

The May 2026 baseline predated the current self-suite contract: it used an obsolete fuzzy case id, skipped all semantic cases because embeddings were unavailable, and measured an older retrieval payload shape. Comparing it with the current suite therefore mixed corpus drift, case drift, and retrieval behavior into one failure. The user approved a deliberate rebaseline as part of the full-app hardening review.

The replacement was captured after syncing the Cartograph index at commit `7166391`. Two consecutive, fully scored runs passed 18/18 with identical recall, MRR, result membership, and payload sizes; comparing the runs reported zero regressions and `meanPayloadDelta +0.0%`. The tracked snapshot uses the second report.

The reset acknowledges the current payload cost rather than hiding it: paired cases were about 19.9% larger on average than the stale May snapshot, while the suite and production retrieval path had both materially changed. Future changes are measured against this new floor.

## Refresh policy

1. Obtain explicit approval for the rebaseline and document why the old corpus or contract is no longer comparable.
2. Sync the code graph against the intended commit.
3. Run `npm run eval:self` until two consecutive reports are fully scored; do not use a report with semantic skips.
4. Compare those reports with `bun __tests__/evaluation/compare.ts <first> <second>` and require zero recall, MRR, membership, and payload drift.
5. Track the later report with `codebasePath` normalized to `.` and run the normal retrieval and repository gates.

For the patch fixture, update the baseline only when task expectations or the
route contract intentionally change. Record the reason, run the fixture twice,
and require identical correctness/membership plus payload within budget; never
rebaseline merely to hide a retrieval regression.
