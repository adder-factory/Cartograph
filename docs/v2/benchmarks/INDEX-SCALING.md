# V2 bounded-index scaling benchmark

Status: first synthetic-stage baseline
Measured: 2026-07-22
Raw report: [`index-scaling-aarch64-2026-07-22.json`](./index-scaling-aarch64-2026-07-22.json)

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
`8a15ec2d169886dfe10671dd3d794ad92760cafdbe3478fcb9acc2d4deee52a3`.
Each item performs 32 deterministic BLAKE3 analysis rounds before producing
typed file, symbol, relationship, reference, and search-document facts.

Those two fingerprints, the logical generation digest, all five row counts,
and the ordered BM25 document IDs are committed constants in the benchmark.
The first run cannot adopt a changed workload as a new baseline. A corpus,
configuration, reducer, schema, or retrieval change must deliberately update
the constants and raw evidence together.

All 30 warmup/measured runs at 1, 2, 4, 8, and 16 workers produced:

- logical generation digest
  `647c61f7eb0a697a31774f9d025ea896e35fb6cb54ade6477b47dadaaac04cbf`;
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
stage or end-to-end duration. COPY measures exactly the five table streams,
including their bounded row encoding, but excludes validation, fencing, the
ready transition, publication, and the verification queries.

| Workers | Window | Stage p50 / p95 | COPY p50 / p95 | End-to-end p50 / p95 | Stage items/s | End-to-end items/s | Peak items | Peak reserved bytes |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 2 | 130.00 / 145.17 | 67.01 / 71.30 | 220.24 / 238.57 | 1,969 | 1,162 | 2 | 49,536 |
| 2 | 4 | 92.60 / 93.10 | 59.09 / 60.17 | 174.53 / 175.24 | 2,764 | 1,467 | 4 | 97,536 |
| 4 | 8 | 61.13 / 63.38 | 56.71 / 66.18 | 143.87 / 152.31 | 4,188 | 1,779 | 8 | 193,536 |
| 8 | 16 | 39.34 / 45.48 | 54.37 / 56.17 | 120.60 / 124.78 | 6,507 | 2,123 | 16 | 385,536 |
| 16 | 32 | 28.40 / 32.56 | 54.70 / 65.80 | 108.98 / 115.62 | 9,015 | 2,349 | 32 | 769,536 |

The CPU stage scaled by 4.58 times from 1 to 16 workers. End-to-end throughput
scaled by 2.02 times because COPY and publication become the fixed floor. The
16-worker row improved median end-to-end time by 9.6% over 8 workers while
doubling the bounded reservation window.

## Initial scheduler decision

Use up to 16 parse/extract workers, capped by available parallelism, with one
queued envelope per active worker. Keep the supervisor's byte budget as the
hard admission authority, so larger real AST/fact payloads backpressure before
the item window fills. COPY remains one retained database task; independently
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
