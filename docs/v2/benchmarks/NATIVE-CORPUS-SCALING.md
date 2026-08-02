# V2 native real-corpus scaling benchmark

Status: historical v2.0.0 release-candidate extractor/resolver and digest-v4 contract

Measured: 2026-07-24

> Historical benchmark: the environment and figures below are preserved release
> evidence, not current installation guidance. The v2.1.1 runtime contract is
> PostgreSQL 18.4+, `pg_search` 0.25.0, and pgvector 0.8.4+.

The committed
[`bulk-relations-v2`](./native-corpus-scaling-aarch64-2026-07-24-bulk-relations-v2.json),
[`resolver-v2`](./native-corpus-scaling-aarch64-2026-07-23-resolver-v2.json),
and [pre-resolver](./native-corpus-scaling-aarch64-2026-07-23.json) reports
remain immutable historical baselines. The figures below are from the final
release-candidate command output.

Keeping the older reports makes each intentional extractor, resolver, digest,
and storage-contract change reviewable instead of overwriting prior evidence.

## What this proves

This gate runs the production Rust discovery, bounded read/hash, native
Tree-sitter extraction, project resolution, canonical reduction, PostgreSQL
COPY, atomic publication, and ParadeDB BM25 lookup at 1, 2, 4, 8, and 16
workers. It does not call Bun, TypeScript, or an LLM.

The corpus freezes 24 representative Cartograph v1 source files, the four
TypeScript/JavaScript/TSX/JSX v1.1.33 oracle sources, and six custom-language
tag-search fixtures. It contains 34 files and 1,052,564 source bytes. Every
source is compiled into the Rust test with
`include_str!`; a length-delimited path/content fingerprint prevents a changed
checkout from silently becoming a new baseline:

`ab91088c482ed36d31759382283342654ce6958be4e601429b8181da531c5fc1`

Each worker count runs in its own child process so process RSS does not inherit
another worker count's allocator high-water. Each child performs one warmup and
three measured samples. Every child has a 180-second outer deadline and is
killed and reaped on timeout; the parent then removes all exact schema names
assigned to that child. A separate live regression deliberately hangs a child
and proves kill, reap, and parent-side schema cleanup. Every sample owns a fresh
PostgreSQL schema, generation, lease, and BM25 index. The parent rejects a child
unless its committed corpus, logical digest, literal row counts, edge-kind set,
ordered BM25 IDs, native accounting report, supervisor terminal state, and exact
lease cleanup all pass.

All 20 warmup/measured runs produced:

- logical digest version 4,
  `95bb83066852d14034cbd16774818b8491798063b84d1e25a65c9e87520140cc`;
- 34 files, 4,207 symbols, 6,818 edges, 14,326 references, and 4,207
  search documents;
- edge kinds `calls`, `contains`, `exports`, `extends`, `field_access`,
  `implements`, `instantiates`, `references`, `returns`, and `type_of`;
- 2,852 exactly resolved and 11,486 explicitly unresolved references;
- zero parser diagnostics;
- a 13,097,322-byte modeled canonical generation, 74,672,143-byte resolve
  charge, and 85,429,377-byte validation charge;
- the same ordered five-document BM25 result for `detectSecretsHandling`; and
- the same ordered six-document cross-language BM25 result plus exact-name
  lookup for `tagscanary`, with the secret sentinel absent from all stored
  search evidence.

The contract change is deliberate. The final native pipeline preserves typed
declarations, module/export relationships, value and structural references,
framework signals, reference multiplicity, and v1 custom-language tag
extraction that earlier baselines had not all enabled together. Module-aware
resolution still refuses ambiguous project-wide same-name fallbacks and keeps
unresolved evidence explicit. The unchanged corpus fingerprint, zero
diagnostics, exact cross-worker digest, literal row contracts, and independent
language/resolver fixtures prevent this larger graph from being accepted as a
blind snapshot.

## Environment and measurement

- Host: macOS on Apple arm64, 14 logical CPUs
- Rust: 1.96.1, debug integration-test profile
- Database image: digest-pinned `paradedb/paradedb:0.23.5`
- PostgreSQL: 18.4
- ParadeDB `pg_search`: 0.23.5
- pgvector: 0.8.1
- RSS: isolated child process, sampled every 25 ms; `/proc/self/status` on
  Linux and `ps` current-RSS sampling on macOS. The report records each child's
  successful sample count and the child fails if any sample fails.

Native duration covers discovery through canonical Reduce. The historical
report below used the then-current five-table stream observer. The current V7
harness observes six streams by adding `numerical_sites` (zero rows for this
TypeScript corpus) and records files, symbols, edges, references, numerical
sites, and search-document COPY durations independently. Completed and
failing-table measurements survive a
failed COPY attempt; tables never attempted remain zero. Relation-validation
duration is the set-based database check after COPY and is deliberately outside
the COPY duration. Supervised pipeline duration starts immediately before
lease-supervised execution and ends when COPY, relation validation, ready, and
publication return. It excludes fixture/schema setup, initial staged-generation
creation, post-run BM25/lifecycle inspection, and schema cleanup. RSS is
measured process memory, not a claim that Rust accounting controls Tree-sitter's
C allocator.

## Bulk relation integrity decision

Per-table instrumentation disproved the initial assumption that ParadeDB BM25
maintenance was the whole COPY floor. The expensive path was PostgreSQL checking
file/symbol foreign keys for every edge, reference, and search document.
Migration 6 therefore keeps one generation-level cascade on `edges`,
`references`, and `search_documents`, removes the seven row relation foreign
keys, and validates the same existence relations with one set-difference query
inside the prepare transaction before `ready`.

This does not weaken the accepted-generation boundary. Rust validates the
richer semantic relation contract before COPY, the database check catches a
corrupted copied relation, and any failure rolls back every fact row while
returning a recoverable staging token. A live trigger deliberately injects a
missing edge symbol after valid input and proves the database check rejects and
rolls back the generation. Facts are immutable after preparation. Failed
generation metadata was retained without a public deletion command at the time
of this frozen measurement. The final v2 runtime now exposes separately
confirmed, bounded `db prune`; the foreign-key/cascade behavior measured here
remains the basis of that collector.

The first SQL prototype used anti-joins. A measured four-worker run spent about
5.75 seconds in that check because fresh COPY targets had no useful planner
statistics, so that implementation was rejected. Set difference makes bounded
generation scans and measures 8.07 ms p50 at four workers.

At the four-worker knee, median COPY is now 285.68 ms:

| Table | p50 ms | Share of COPY |
| --- | ---: | ---: |
| Files | 3.42 | 1.2% |
| Symbols | 90.74 | 31.8% |
| Edges | 26.99 | 9.4% |
| References | 83.01 | 29.1% |
| Search documents + BM25 | 81.63 | 28.6% |

## Results

Durations are p50 / p95 milliseconds. RSS columns are the largest sample seen
across the warmup and measured runs in each isolated worker process.

| Workers | Native p50 / p95 | COPY p50 / p95 | Relation check p50 / p95 | Supervised pipeline p50 / p95 | Native files/s | Peak RSS MiB | RSS delta MiB |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 4,691.39 / 4,694.66 | 368.09 / 376.36 | 11.28 / 13.78 | 5,242.05 / 5,501.29 | 7.25 | 142.17 | 131.55 |
| 2 | 2,988.77 / 3,229.41 | 452.31 / 972.98 | 13.96 / 27.10 | 3,850.59 / 4,176.63 | 11.38 | 141.52 | 130.89 |
| 4 | 2,150.84 / 2,231.94 | 402.21 / 461.86 | 11.92 / 16.01 | 2,766.17 / 2,798.29 | 15.81 | 146.17 | 135.56 |
| 8 | 1,724.47 / 1,731.99 | 404.30 / 458.52 | 13.90 / 35.90 | 2,317.41 / 2,360.53 | 19.72 | 154.06 | 143.45 |
| 16 | 1,894.58 / 1,903.36 | 345.74 / 364.25 | 12.82 / 14.27 | 2,422.98 / 2,438.10 | 17.95 | 169.48 | 158.89 |

Eight workers are the measured scheduling knee for this 34-file corpus.
Relative to one worker, native time falls 63.2% and supervised pipeline time
falls 55.8%. Sixteen workers are 9.9% slower in native work and 4.6% slower end
to end than eight while adding 15.42 MiB peak RSS. At eight workers, COPY is
17.4% of the supervised median and relation validation remains below 1%.

## Scheduler and optimization decision

Do not replace the synthetic 16-worker upper bound with a universal fixed
eight-worker cap. The synthetic 256-item workload still scales through 16,
whereas this real 34-file workload reaches its scheduling knee at eight. The
release selector therefore considers both file count and indexed source bytes:

- use eight read/parse workers for a corpus around 34 files and 1.05 MB;
- retain 16 only as the measured upper bound for sufficiently large queues;
- keep one queued item per active worker and the independent byte budget as
  the hard admission authority; and
- re-run both baselines when changing the sizing heuristic.

The COPY/ParadeDB floor is no longer dominant on this corpus. Retain the
per-table and relation metrics so a future schema, ParadeDB, or corpus change
cannot silently recreate the old write floor.

## Reproduce

```sh
export CARTOGRAPH_TEST_DATABASE_URL='postgresql://...'
cargo test --locked --quiet -p cartograph-indexer \
  --test live_supervisor \
  native_corpus::frozen_native_corpus_is_worker_deterministic_and_bounded \
  -- --ignored --exact --nocapture --test-threads=1
```

The command emits one `CARTOGRAPH_NATIVE_CORPUS_MATRIX_REPORT=` JSON line and
fails closed on corpus, logical-output, BM25, lifecycle, child timeout, RSS
sampling failure, or a missing RSS sample. RSS value changes are recorded for
review but deliberately have no wall-clock or machine-memory pass/fail threshold.
