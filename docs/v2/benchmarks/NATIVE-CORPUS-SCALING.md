# V2 native real-corpus scaling benchmark

Status: frozen resolver-v2 plus generation-scoped bulk-relation contract
Measured: 2026-07-24
Current raw report: [`native-corpus-scaling-aarch64-2026-07-24-bulk-relations-v2.json`](./native-corpus-scaling-aarch64-2026-07-24-bulk-relations-v2.json)

The immutable row-foreign-key resolver-v2 baseline remains
[`native-corpus-scaling-aarch64-2026-07-23-resolver-v2.json`](./native-corpus-scaling-aarch64-2026-07-23-resolver-v2.json).
The pre-resolver baseline remains
[`native-corpus-scaling-aarch64-2026-07-23.json`](./native-corpus-scaling-aarch64-2026-07-23.json).
Keeping all three reports makes both the intentional resolver contract change
and the storage optimization reviewable instead of overwriting old evidence.

## What this proves

This gate runs the production Rust discovery, bounded read/hash, native
Tree-sitter extraction, project resolution, canonical reduction, PostgreSQL
COPY, atomic publication, and ParadeDB BM25 lookup at 1, 2, 4, 8, and 16
workers. It does not call Bun, TypeScript, or an LLM.

The corpus freezes 24 representative Cartograph v1 source files plus the four
TypeScript/JavaScript/TSX/JSX v1.1.33 oracle sources. It contains 28 files and
1,052,338 source bytes. Every source is compiled into the Rust test with
`include_str!`; a length-delimited path/content fingerprint prevents a changed
checkout from silently becoming a new baseline:

`5be02b94045f978010d7c8ffeba1a8568a16aaad1ff15f884609524aa61f4d20`

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

- logical digest version 2,
  `dee0d3a02dfb43ce9d024fd37a7fb851343c5dad0138db827ab35a3e04e42cb3`;
- 28 files, 3,843 symbols, 3,699 edges, 12,660 references, and 3,871
  search documents;
- edge kinds `calls`, `contains`, `extends`, `field_access`, `implements`,
  `instantiates`, `returns`, and `type_of`;
- 1,852 exactly resolved and 10,808 explicitly unresolved references;
- zero parser diagnostics;
- an 8,473,292-byte modeled canonical generation, 61,210,798-byte resolve
  charge, and 47,754,838-byte validation charge; and
- the same ordered five-document BM25 result for `detectSecretsHandling`.

The contract change is deliberate. Three declaration-only overload/signature
symbols and their documents are now explicit, implementation bodies contribute
bounded identifier/keyword text, and import aliases plus lexical scopes decide
references. The old resolver linked any unique project-wide same-name symbol,
including private declarations in unrelated modules. Resolver v2 removes those
false-positive edges, permits only exported cross-file fallback, resolves exact
relative default/named/namespace imports, chooses a unique overload
implementation, stops ambiguous stems before directory-index fallback, and
keeps class members out of bare lexical calls. Ambiguous or bare-package imports
remain explicit. Named import declaration sites are resolved by their exact
binding span before same-name lexical or project candidates. Seven former
same-name member matches in this corpus are now unresolved and four false graph
edges are gone; BM25 ordering is unchanged. That is why resolved/edge counts
fall even though the resolver is more precise.

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

Native duration covers discovery through canonical Reduce. COPY duration is the
exact five-table stream observer and includes bounded row encoding. The report
also records files, symbols, edges, references, and search-document COPY
durations independently. Completed and failing-table measurements survive a
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
generation metadata is retained; the product does not yet expose generation
deletion, although the retained generation foreign keys define cascade behavior
for that future path.

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
| 1 | 1,261.97 / 1,281.04 | 284.38 / 286.79 | 8.38 / 8.61 | 1,582.43 / 1,584.19 | 22.19 | 66.94 | 56.75 |
| 2 | 861.05 / 862.87 | 279.57 / 280.69 | 8.16 / 8.41 | 1,173.74 / 1,180.69 | 32.52 | 69.02 | 58.84 |
| 4 | 681.52 / 683.74 | 285.68 / 295.55 | 8.07 / 8.21 | 1,007.45 / 1,008.13 | 41.08 | 71.47 | 61.27 |
| 8 | 711.70 / 721.56 | 287.12 / 291.30 | 8.56 / 9.14 | 1,029.70 / 1,046.12 | 39.34 | 78.75 | 68.56 |
| 16 | 945.40 / 957.23 | 281.14 / 281.71 | 8.18 / 8.24 | 1,263.45 / 1,274.07 | 29.62 | 92.94 | 82.72 |

Four workers are the measured scheduling knee for this 28-file corpus.
Relative to one worker, native time falls 46.0% and supervised pipeline time
falls 36.3%. Eight workers are 4.4% slower in native work and 2.2% slower end to
end than four while adding 7.28 MiB peak RSS; 16 workers are 38.7% slower in
native work and reach 92.94 MiB. At four workers, COPY consumes 28.4% and
relation validation 0.8% of the supervised median.

Against the immutable row-foreign-key resolver-v2 baseline, four-worker COPY
falls 94.1%, from 4,809.56 ms to 285.68 ms. The complete supervised pipeline
falls 81.8%, from 5,525.37 ms to 1,007.45 ms, with identical digest, rows,
edge-kind set, resolved/unresolved accounting, and BM25 Top-5.

## Scheduler and optimization decision

Do not replace the synthetic 16-worker upper bound with a universal fixed
four-worker cap. The synthetic 256-item workload still scales through 16,
whereas the real 28-file workload reaches its scheduling knee at four. The supported
recommendation for an eventual production selector is therefore corpus-aware;
the selector itself remains an implementation task:

- use at most four read/parse workers for small projects around this size;
- retain 16 only as the measured upper bound for sufficiently large queues;
- keep one queued item per active worker and the independent byte budget as
  the hard admission authority; and
- re-run both baselines when changing the sizing heuristic.

The COPY/ParadeDB floor is no longer dominant on this corpus. The next measured
performance task is the deterministic corpus-aware worker selector, followed by
resolver/extractor work on larger projects. Retain the per-table and relation
metrics so a future schema, ParadeDB, or corpus change cannot silently recreate
the old write floor.

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
