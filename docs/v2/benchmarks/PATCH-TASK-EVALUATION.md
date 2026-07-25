# V2 native patch-task evaluation

Status: locked v1.1.33 parity gate  
Measured: 2026-07-24

## Result

The production Rust `ProjectRuntime`, native extractor/indexer, PostgreSQL
storage, ParadeDB BM25 retrieval, `ContextPacket`, compare-to-ref review, graph
impact, and affected-test evidence meet the frozen v1.1.33 patch-task floors.
The gate does not invoke Bun, TypeScript, an LLM, an embedding service, or a
SQLite library/database.

| Metric | Frozen v1.1.33 floor | Native v2 result |
| --- | ---: | ---: |
| Hit@5 | 1.0000 | 1.0000 |
| MRR | 1.0000 | 1.0000 |
| Edit-site precision | 0.8667 | 1.0000 |
| Edit-site recall | 1.0000 | 1.0000 |
| Affected-test recall | 1.0000 | 1.0000 |
| Abstention accuracy | 1.0000 | 1.0000 |
| Mean payload bytes | 3,927 | 1,176.00 |
| Mean estimated tokens | at most 982 | 294.20 |

One invocation evaluates the complete corpus twice and compares the full
ordered reports for exact equality. Both passes produced the figures above,
including identical evidence membership, BM25 ranks, predicted edit files,
test selections, abstentions, payload bytes, and aggregate scores.

## Locked contract

The five task definitions and expectations are byte-for-byte recreations of
the committed v1.1.33 fixture:

- `watcher-empty-path`
- `auth-malformed-token`
- `refund-negative-input`
- `postgres-noop-maintenance`
- `absent-mobile-push`

The canonical, sorted v1 case-definition JSON retains its original SHA-256
fingerprint:

`48af5dde705ed932c5cc255ca53e8250287fc497ba874a7df5f7cacf8010eeec`

V1's case fingerprint did not cover fixture source contents. V2 therefore also
length-prefixes and hashes all nine ordered path/source pairs with a domain-
separated BLAKE3 contract:

`b35332df4f340cd467fb3e1917a89e7d327b92638daca9d1188ae0de571d745c`

The fast non-database test checks SHA-256 against its standard `abc` vector,
then checks both locked fingerprints. A changed task, expectation, path, source
byte, or ordering contract fails before the live evaluation starts.

## Native route under test

The gate materializes the nine source/test files in a temporary Git repository,
commits the baseline, creates a unique PostgreSQL schema, and indexes the
fixture through `ProjectRuntime` with four workers. It requires exactly nine
published files and a fresh current generation.

For each task it then:

1. normalizes the natural-language task into sorted, non-stop lexical terms;
2. requests a current `ContextPacket` with 8 BM25 candidates, graph depth 3,
   at most 40 graph nodes, 40 compact evidence items, and 20 affected tests;
3. derives a typed, bounded primary edit-candidate set: explicit exact anchors
   win; otherwise only files with the strongest distinct code-aware task-term
   concentration across qualified names and paths are primary;
4. hydrates callable symbols (`function` and `method`) from those primary paths,
   retains the first five in native BM25 order, and predicts their unique
   source paths as edit sites;
5. applies a reversible dirty-worktree probe to those predicted paths and runs
   the real compare-to-`HEAD` review, requiring exact changed-file evidence and
   the honest `stale_index` abstention; and
6. selects affected tests from context traversal, review traversal, and exact
   current-generation references to ranked/changed declarations.

The exact-reference channel is a conservative fallback for currently
unresolved TypeScript import/call graph edges. It cannot hide a total graph
regression: `watcher-empty-path` is separately locked to reach
`tests/watcher.test.ts` through the review packet's reverse graph traversal.
The absent mobile-push task must produce no lexically relevant callable, no edit
or test selection, an evaluation abstention, and the review packet's explicit
`no_changed_files` abstention.

Scoring uses the v1.1.33 definitions: case-insensitive symbol hit in the first
five callable candidates, reciprocal rank of the first expected symbol,
set-based edit precision/recall, set-based affected-test recall, and exact
abstention agreement. Empty expected edit sets score 1 only for an empty
prediction; cases without expected tests are excluded from mean test recall.

## Payload contract

Estimated tokens remain `ceil(UTF-8 bytes / 4)` per case, as in v1. The native
payload is a deterministic newline-delimited projection containing every field
used by the agent decision: normalized query, context/review freshness,
confidence, abstention and truncation, callable ranking, edit paths, each test-
selection channel, and every bounded context/review evidence item with rank,
path, qualified name, and provenance. It omits latency and repeated opaque row
identities, which do not help an agent decide where to edit or which tests to
run. The typed primary edit-candidate evidence raises precision to 1.0000 while
the complete decision payload remains 294.20 tokens on average, instead of
silently comparing two differently bloated payloads.

## Failure and cleanup behavior

The live body runs in a bounded Tokio task with a 180-second deadline. Timeout
aborts and reaps the task before cleanup. Panic, ordinary failure, and success
all return to the parent test, which drops the exact generated schema with
`CASCADE` before asserting or reporting the result. The test is ignored by
default and returns a clear skip when `CARTOGRAPH_TEST_DATABASE_URL` is absent.

Fixture Git setup also uses Tokio child processes directly, never a shell. Each
command has its own 10-second deadline and is killed and reaped on timeout.
System/global Git configuration is disabled, inherited repository/worktree
overrides are removed, hooks point to a nonexistent fixture-local directory,
and commit/tag signing and interactive prompting are explicitly disabled. A
developer's hook, signing agent, pager, credential prompt, or ambient Git
variables therefore cannot hang or redirect the release gate.

The recorded run used:

- PostgreSQL 18.4;
- `pg_search` 0.23.5;
- pgvector 0.8.1; and
- the local Apple arm64 Rust debug integration-test profile.

## Reproduce

The fingerprint-only contract needs no database:

```sh
cargo test --locked -p cartograph-agent --test patch_task_evaluation \
  locked_v1_1_33_patch_contract_fingerprints_match -- --exact
```

Run the live gate against an explicit disposable-capable PostgreSQL/ParadeDB
database:

```sh
export CARTOGRAPH_TEST_DATABASE_URL='postgresql://...'
cargo test --locked -p cartograph-agent --test patch_task_evaluation \
  native_patch_task_gate_meets_v1_1_33_and_repeats_exactly -- \
  --ignored --exact --nocapture --test-threads=1
```

The successful command emits one `CARTOGRAPH_PATCH_TASK_REPORT=` line with the
two fingerprints and exact aggregate metrics. The tracked floors must not be
lowered or rebaselined to accept a regression.
