# Next Session: `go`

When the user says exactly `go`, read this file first.

There are currently no unchecked handoff tasks. The structural follow-up
session is complete.

## Completed Structural Work

- [x] Canonical tool contract pilot for `cartograph_coverage`.
- [x] Shared argument normalization for MCP and generated CLI surfaces.
- [x] Generated tool-surface contract matrix.
- [x] Installer/doctor state-machine tests and BYO/no-model guidance fix.
- [x] Graph invariant regression suite.
- [x] Mock hygiene guardrail and CI step.
- [x] CI portability convention, self-check, and CI step.
- [x] Local Cartograph DB checkpoint/vacuum housekeeping.

## Latest Verified State

- Branch: `main`
- Latest verified commit: `3c38be4 test: add structural guardrail suites`
- GitHub Actions run: `26921677690` — success
- Sonar analysis: `5ebf1264-34b3-4c1d-8d24-7a952ed69c5b` — quality gate OK
- Sonar measures: 0 violations, 0 code smells, coverage 90.0%, new coverage 91.1%
- Cartograph compare: `HEAD~1..HEAD` introduced 0 per-file biomarker findings
- Local DB after housekeeping: `.cartograph/cartograph.db` about 279M, WAL 0B

## If `go` Is Used Again

1. Run `git status --short --branch`.
2. Run `cartograph_status` if code exploration is needed.
3. If the user has not provided a new task, ask what they want to work on next.
