# Tasks

## Index Staleness

- [x] Fix empty-result freshness hints for clean-git content drift.
  - `src/mcp/tools/shared.ts` checks only `FreshnessInfo.isStale` and `hasUncommittedChanges()` before emitting "Index in sync - empty result is a true negative".
  - Repro: corrupt or miss a tracked file's indexed `content_hash`, bump its mtime, keep HEAD and `git status` clean, then run an empty-result tool such as `cartograph_find`; `FreshnessInfo.contentDriftedFiles > 0` but the footer still claims a true negative.
  - Expected fix: treat `contentDriftedFiles > 0` as freshness risk in `freshnessHintForEmptyResult()` and structured freshness metadata, recommending `cartograph_changed_since` and/or `cartograph_admin({action: 'sync'})`; add a regression test covering the clean-git content-drift path.

## Next Session: Cartograph Friction

- [x] Improve ambiguous symbol disambiguation UX.
  - See `NEXT_SESSION_GO.md` task 1.
- [x] Add task-scoped review filters.
  - See `NEXT_SESSION_GO.md` task 2.
- [x] Extract shared freshness-risk semantics.
  - See `NEXT_SESSION_GO.md` task 3.
- [x] Improve unresolved refs explainability.
  - See `NEXT_SESSION_GO.md` task 4.
