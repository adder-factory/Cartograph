# V2 bounded-index scaling benchmark

Status: synthetic-stage baseline plus digest-v2 validation refresh
Measured: 2026-07-22
Original raw baseline: [`index-scaling-aarch64-2026-07-22.json`](./index-scaling-aarch64-2026-07-22.json).
Current digest-v2 raw report: [`index-scaling-aarch64-2026-07-22-digest-v2.json`](./index-scaling-aarch64-2026-07-22-digest-v2.json).
The original artifact remains byte-for-byte historical evidence. Every digest,
timing, and table value below comes only from the separately committed digest-v2
report after migration 5 and capacity-aware canonical validation.

## What this proves

The benchmark runs the real Rust `StageRunner`, one supervisor-owned generation,
the deterministic database reducer, all five PostgreSQL COPY streams, atomic
publication, and a ParadeDB BM25 query. Each worker count gets one warmup and
five measured runs. Every run uses a fresh isolated schema so a larger prior
BM25 index cannot bias later samples.

The frozen `synthetic-typescript-stage-v1` fixture contains 256 TypeScript-shaped
items and 6,145,536 source bytes. Its source digest is
`b23964be1dfad94c41d158358db1f60187729c399ed623d107c6b4cc0f46d6d1`.
Its length-delimited fixture/config fingerprint is
`2c02e8357bee04c11d89f383c316077b8eb2228bd4262d2404cb1535885083d9`.
Each item performs 32 deterministic BLAKE3 analysis rounds before producing
typed file, symbol, relationship, reference, and search-document facts.

Those two fingerprints, the logical generation digest, all five row counts,
and the ordered BM25 document IDs are committed constants in the benchmark.
The first run cannot adopt a changed workload as a new baseline. A corpus,
configuration, reducer, schema, or retrieval change must deliberately update
the constants and raw evidence together.

All 30 digest-v2 warmup/measured runs at 1, 2, 4, 8, and 16 workers produced:

- logical generation digest version 2,
  `3fcf25b6aef136419808799cc59b4b95ceb3f5014acef35192645242b4dd5d25`;
- 256 files, 256 symbols, 255 edges, 255 references, and 256 search documents;
- BM25 first hit `30000000-0000-4000-8000-000000000001` for
  `needle cartograph benchmark`;
- zero current stage items and reserved bytes after reduction;
- a completed supervisor, which cannot publish while an active task remains;
- no exact operation-lease row after publication; and
- no residual benchmark schema after cleanup.

Before timing, the harness also deliberately rejects project registration
after a fresh schema migration, then proves the setup owner removed that schema.
This exercises cleanup before `run_clean_sample` can own a normal fixture.

## Environment

- Host: Apple arm64, 14 logical CPUs
- Rust: 1.96.1, optimized `bench` profile
- PostgreSQL: 18.4
- ParadeDB `pg_search`: 0.23.5
- pgvector: 0.8.1
- Image: digest-pinned `paradedb/paradedb:0.23.5`
- State: local service already healthy; one warmup per worker count; fresh
  Cartograph schema and BM25 index per sample

## Results

Durations are wall-clock milliseconds. Throughput is based on the median
stage or end-to-end duration. Stage time covers the bounded parallel Parse
stage plus the one-item supervised canonical Reduce stage. Their reservations
are sequential, so peak bytes are the larger live reservation, not their sum.
COPY measures exactly the five table streams, including their bounded row
encoding, but excludes validation, fencing, the ready transition, publication,
and the verification queries.

| Workers | Window | Stage p50 / p95 | COPY p50 / p95 | End-to-end p50 / p95 | Stage items/s | End-to-end items/s | Peak items | Peak reserved bytes |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 2 | 150.98 / 152.60 | 66.90 / 77.91 | 240.11 / 251.22 | 1,696 | 1,066 | 2 | 268,435,456 |
| 2 | 4 | 99.14 / 100.14 | 62.53 / 69.96 | 182.56 / 191.73 | 2,582 | 1,402 | 4 | 268,435,456 |
| 4 | 8 | 68.85 / 70.26 | 59.74 / 66.80 | 149.26 / 156.19 | 3,718 | 1,715 | 8 | 268,435,456 |
| 8 | 16 | 52.01 / 54.58 | 57.33 / 57.66 | 130.72 / 131.34 | 4,922 | 1,958 | 16 | 268,435,456 |
| 16 | 32 | 37.91 / 39.59 | 58.05 / 62.26 | 116.38 / 125.13 | 6,754 | 2,200 | 32 | 268,435,456 |

The supervised Parse-plus-Reduce stage scaled by 3.98 times from 1 to 16 workers. End-to-end throughput
scaled by 2.06 times because canonical validation, COPY, and publication become
the fixed floor. The 16-worker row improved median end-to-end time by 11.0% over
8 workers while doubling the bounded reservation window. The real-corpus run
still determines the production default.

## Initial scheduler decision

Use up to 16 parse/extract workers, capped by available parallelism, with one
queued envelope per active worker. Keep the supervisor's byte budget as the
hard admission authority. The synthetic harness reserves the full 256 MiB
canonical-validation working ceiling during its supervised Reduce item, while
larger real AST/fact payloads backpressure in Parse before the item window fills.
COPY remains one retained database task; independently
streaming destructive/terminal work from workers is still forbidden.

This is an initial scheduler cap, not a universal performance promise. The
fixture deliberately exercises the executor and persistence path before the
real Rust TypeScript extractor exists. Re-run this same matrix on the frozen
real extractor corpus before locking production defaults, and do not add a
wall-clock threshold to shared CI. CI runs the matrix as a determinism,
publication, BM25, bound, and cleanup gate; machine-local reports carry the
performance interpretation.

## Reproduce

```sh
export CARTOGRAPH_TEST_DATABASE_URL='postgresql://...'
cargo bench --locked -p cartograph-indexer --bench index_scaling
```

The command prints the complete machine-readable report to stdout and fails on
any digest, row-count, BM25, capacity, task-lifecycle, or lease invariant.
