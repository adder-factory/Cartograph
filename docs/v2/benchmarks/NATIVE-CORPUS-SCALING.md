# V2 native real-corpus scaling benchmark

Status: frozen Rust-owned TypeScript/JavaScript/TSX/JSX resolver-v2 contract
Measured: 2026-07-23
Current raw report: [`native-corpus-scaling-aarch64-2026-07-23-resolver-v2.json`](./native-corpus-scaling-aarch64-2026-07-23-resolver-v2.json)

The immutable pre-resolver baseline remains
[`native-corpus-scaling-aarch64-2026-07-23.json`](./native-corpus-scaling-aarch64-2026-07-23.json).
Keeping both makes the intentional golden-contract transition reviewable rather
than overwriting the old evidence.

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
| 1 | 1,275.57 / 1,282.88 | 4,807.41 / 4,883.69 | 6,107.17 / 6,182.94 | 21.95 | 68.28 | 58.03 |
| 2 | 870.54 / 880.80 | 4,827.24 / 4,858.00 | 5,723.64 / 5,750.47 | 32.16 | 70.77 | 60.61 |
| 4 | 690.00 / 693.07 | 4,809.56 / 4,814.94 | 5,525.37 / 5,532.00 | 40.58 | 73.80 | 63.59 |
| 8 | 713.99 / 725.51 | 4,828.16 / 4,828.85 | 5,555.96 / 5,567.61 | 39.22 | 77.59 | 67.41 |
| 16 | 919.55 / 956.64 | 4,832.57 / 4,835.98 | 5,772.22 / 5,813.02 | 30.45 | 90.69 | 80.52 |

Four workers are the measured scheduling knee for this 28-file corpus.
Relative to one worker, native time falls 45.9% and supervised pipeline time
falls 9.5%. Eight workers are 3.5% slower than four while adding 3.80 MiB peak
RSS; 16 workers are 33.3% slower than four and reach 90.69 MiB. At four workers,
COPY consumes 87.0% of median supervised pipeline time, so more parser threads
cannot materially improve this workload.

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
optimize the 3,871-document COPY/ParadeDB indexing floor: COPY batch shape,
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
