# V2 native real-corpus scaling benchmark

Status: frozen Rust-owned TypeScript/JavaScript/TSX/JSX baseline
Measured: 2026-07-23
Raw report: [`native-corpus-scaling-aarch64-2026-07-23.json`](./native-corpus-scaling-aarch64-2026-07-23.json)

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
  `c51f87287539116a4f60149f65241053821046f4045fa7e0dc1e5a92343f0059`;
- 28 files, 3,840 symbols, 4,473 edges, 12,651 references, and 3,868
  search documents;
- edge kinds `calls`, `contains`, `extends`, `field_access`, `implements`,
  `instantiates`, `returns`, and `type_of`;
- 2,956 exactly resolved and 9,695 explicitly unresolved references;
- zero parser diagnostics;
- an 8,074,529-byte modeled canonical generation, 56,600,216-byte resolve
  charge, and 46,054,906-byte validation charge; and
- the same ordered five-document BM25 result for `detectSecretsHandling`.

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
exact five-table stream observer and includes bounded row encoding. Supervised
pipeline duration starts immediately before lease-supervised execution and ends
when COPY plus ready/publication returns. It excludes fixture/schema setup,
initial staged-generation creation, post-run BM25/lifecycle inspection, and
schema cleanup. RSS is measured process memory, not a claim that Rust accounting
controls Tree-sitter's C allocator.

## Results

Durations are p50 / p95 milliseconds. RSS columns are the largest sample seen
across the warmup and measured runs in each isolated worker process.

| Workers | Native p50 / p95 | COPY p50 / p95 | Supervised pipeline p50 / p95 | Native files/s | Peak RSS MiB | RSS delta MiB |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 1,108.77 / 1,110.74 | 5,452.66 / 5,506.76 | 6,585.26 / 6,642.37 | 25.25 | 66.16 | 55.98 |
| 2 | 743.31 / 747.01 | 5,472.24 / 5,493.76 | 6,244.05 / 6,260.82 | 37.67 | 68.17 | 57.98 |
| 4 | 573.75 / 578.99 | 5,519.16 / 5,594.10 | 6,117.48 / 6,197.05 | 48.80 | 71.30 | 61.11 |
| 8 | 571.45 / 578.91 | 5,488.26 / 5,497.13 | 6,083.37 / 6,093.98 | 49.00 | 77.19 | 66.98 |
| 16 | 763.17 / 765.93 | 5,518.69 / 5,573.27 | 6,305.02 / 6,359.15 | 36.69 | 87.08 | 76.89 |

Four workers are the measured scheduling knee for this 28-file corpus.
Relative to one worker, native time falls 48.3% and supervised pipeline time
falls 7.1%. Eight workers improve native p50 by only 0.4% while adding 5.89 MiB
peak RSS; 16 workers are 33.0% slower than four and reach 87.08 MiB. At four
workers, COPY consumes 90.2% of median supervised pipeline time, so more parser
threads cannot materially improve this workload.

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

The next performance target is not more extraction parallelism. Measure and
optimize the 3,868-document COPY/ParadeDB indexing floor: COPY batch shape,
index-build timing, write-path settings, and whether deferred generation-local
BM25 index maintenance can preserve atomic publication and current-generation
search semantics.

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
