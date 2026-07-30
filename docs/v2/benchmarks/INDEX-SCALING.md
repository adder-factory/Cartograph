# V2 bounded-index scaling benchmark

Status: historical v2.0.0 release-candidate digest-v4 and byte-aware scheduler evidence

Measured: 2026-07-24

> Historical benchmark: the environment and figures below are preserved release
> evidence, not current installation guidance. The v2.10.0 runtime contract is
> PostgreSQL 18.4+, `pg_search` 0.25.0, and pgvector 0.8.4+.

The committed 2026-07-22 [original](./index-scaling-aarch64-2026-07-22.json)
and [digest-v2](./index-scaling-aarch64-2026-07-22-digest-v2.json) reports remain
historical baselines. The figures below are from the v2.0.0 release-candidate
run emitted directly by the reproducible command at the end of this document.

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

All 30 digest-v4 warmup/measured runs at 1, 2, 4, 8, and 16 workers produced:

- logical generation digest version 4,
  `b6b88a0a91b17a75f670cc61694e3034a316a7d9a09756d6ceb42b8514391937`;
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
| 1 | 2 | 130.56 / 139.33 | 49.44 / 55.10 | 277.64 / 280.16 | 1,961 | 922 | 2 | 268,435,456 |
| 2 | 4 | 81.50 / 86.26 | 43.89 / 61.14 | 213.26 / 223.59 | 3,141 | 1,200 | 4 | 268,435,456 |
| 4 | 8 | 53.19 / 55.07 | 42.01 / 47.21 | 180.61 / 183.16 | 4,813 | 1,417 | 8 | 268,435,456 |
| 8 | 16 | 39.13 / 40.97 | 40.97 / 56.93 | 168.39 / 182.30 | 6,542 | 1,520 | 16 | 268,435,456 |
| 16 | 32 | 30.92 / 32.85 | 40.89 / 48.28 | 157.57 / 160.64 | 8,280 | 1,625 | 32 | 268,435,456 |

The supervised Parse-plus-Reduce stage scaled by 4.22 times from 1 to 16
workers. End-to-end throughput scaled by 1.76 times because canonical
validation, COPY, and publication become the fixed floor. The 16-worker row
improved median end-to-end time by 6.4% over 8 workers while doubling the
bounded reservation window. The separate
[native real-corpus matrix](NATIVE-CORPUS-SCALING.md) now supplies the
production workload counterpoint.

## Proposed scheduler decision

Keep 16 as the upper bound for sufficiently large parse/extract queues, capped
by available parallelism, with one queued envelope per active worker. The
release-candidate selector now considers both supported-file count and exact
indexed source bytes: the 34-file/1.05 MB native corpus selects eight workers,
while this 256-item/6.15 MB fixture selects 16. The supervisor's byte budget
remains the hard admission authority. The synthetic harness reserves the full
256 MiB canonical-validation working ceiling during its supervised Reduce
item, while larger real AST/fact payloads backpressure in Parse before the item
window fills. COPY remains one retained database task; independently streaming
destructive or terminal work from workers remains forbidden.

This is an upper scheduler cap, not a universal worker count. Re-run this
matrix and the frozen native corpus together when changing the adaptive sizing
policy, and do not add a wall-clock threshold to shared CI. CI runs the matrix
as a determinism, publication, BM25, bound, and cleanup gate; machine-local
reports carry the performance interpretation.

## Reproduce

```sh
export CARTOGRAPH_TEST_DATABASE_URL='postgresql://...'
cargo bench --locked -p cartograph-indexer --bench index_scaling
```

The command prints the complete machine-readable report to stdout and fails on
any digest, row-count, BM25, capacity, task-lifecycle, or lease invariant.
