# V2 large public corpus streaming benchmark

[Benchmark index](README.md) · [Documentation home](../../README.md) ·
[Performance tuning](../../PERF-TUNING.md) · [Native extraction](../EXTRACTION.md)

Status: published `v2.1.11` benchmark record from the final pre-release candidate

This report is committed in release
[v2.1.11](https://github.com/adder-factory/cartograph/releases/tag/v2.1.11) at
signed main/tag commit
[`d2211fbd816d180620159b7e94037cf9f1636234`](https://github.com/adder-factory/cartograph/commit/d2211fbd816d180620159b7e94037cf9f1636234).
The measured run preceded the final `regex-automata` 0.4.17 dependency-lock
refresh. No post-refresh exact-tag benchmark was run, so the timings and digest
below are final-candidate evidence, not an exact tagged-binary rerun.

Measured: 2026-08-04

## Corpus and quality boundary

The public corpus is Microsoft VS Code at exact commit
`dce00340cb3dfc63ff10d6d96be1999ce5ff45cb`. The tracked checkout was unchanged
before and after every measured run; only the project-local benchmark
configuration was untracked. Production discovery admitted 14,693 files and
171,015,058 source bytes.

The benchmark uses the production extraction, resolver, centrality,
cross-relation validation, canonical V13 digest, generation-local ParadeDB
BM25, and atomic publication paths. It does not disable docstrings, call sites,
clone analysis, centrality, diagnostics, or unresolved-reference retention.

Seven paths are declared explicitly because they are outside the ordinary
text-source contract, not to improve timing:

- three committed UTF-16/binary fixture trees; and
- four generated single files that independently exceed the existing
  per-file extraction/output hard bound.

No measured result changes this list, raises a timeout, weakens a limit, or
uses a reduced-quality parser mode.

## Environment

- Host: Apple M4 Max, 14 CPU cores, 36 GB memory
- OS: macOS arm64
- Rust: repository-pinned 1.98.0 release profile
- Database: managed PostgreSQL 18.4, ParadeDB `pg_search` 0.25.0, pgvector
  0.8.4, 256 MiB shared memory
- Requested worker cap: 16; hardware-selected workers: 14
- Generation storage: forced `postgres` for repeatable spill evidence
- Limits: 2 GiB compact native generation/resolver basis, 128 GiB logical
  spill bytes, one billion spill rows

## Locked logical result

The final measured pre-release candidate published canonical V13 digest:

`807bee88ee0a0c98b7127784243dcc2baae229e2e893b675c78505f36537f653`

The earlier baseline used the superseded V12 generation contract, so its
digest bytes are intentionally not compared with V13. Migration 36 makes V12
generations stale because named TypeScript/JavaScript construction references
changed. The old and final runs nevertheless produced the same exact fact
counts:

| Fact | Count |
| --- | ---: |
| Files | 14,693 |
| Symbols | 823,828 |
| Edges | 1,541,789 |
| Reference rows | 2,724,385 |
| Resolved references | 919,860 |
| Explicitly unresolved references | 1,804,558 |
| Numerical sites | 70 |
| Search documents | 823,828 |
| Parser diagnostics | 757 |
| Raw spill rows before canonical reduction | 5,943,286 |
| Logical spill bytes | 4,267,154,015 |

After publication, `status` reported a fresh V13 current generation and a real
`context` query returned 20 current-generation evidence items with no
abstention. An immediate unchanged-source reconciliation returned the same
generation and digest as an explicit no-op in 3.19 seconds with 0.16 GiB
maximum RSS.

## Parser result

The original cold spill parse was first observed in `resolving` at 2 minutes
50 seconds. On the final measured candidate, PostgreSQL timestamps put the last
of all 14,693 extracted-file rows at 23.04 seconds after the generation started.
The first resolved fact batch was committed at 49.77 seconds, after the two
bounded resolver-preparation passes. These are durable database timestamps
rather than an inferred CPU microbenchmark.

The improvement does not skip AST work:

1. a 64-file spill work item now reuses one `NativeExtractor` per encountered
   language, matching the extractor's intended reusable-parser contract; and
2. hot cooperative-cancellation probes use Tokio's atomic monotonic watch
   version instead of taking a watch-value read lock on every AST/clone poll.

Parent cancellation, sibling failure, already-cancelled admission, closed
channels, and exact item deadlines retain dedicated regression coverage.

## End-to-end and memory result

`/usr/bin/time -lp` measured the complete CLI request including discovery,
parse/cache, resolution, typed spill COPY, partition reduction, exact digest,
search-relation/BM25 construction, ready transition, and publication.

| Candidate | Parse cache | Result | Wall seconds | Maximum RSS GiB | Digest |
| --- | --- | --- | ---: | ---: | --- |
| Before parser/validation optimization | cold, 14,693 writes | published | 546.37 | 2.58 | V12 |
| Earlier optimized candidate | warm, 14,693 hits | published | 415.57 | 2.32 | V12 |
| Final measured pre-release candidate | cold, 14,693 writes | published | 467.42 | 2.90 | V13 |

These full-request rows intentionally disclose their different cache states
and digest contracts; they are not presented as an isolated parser A/B result.
The final cold run reached ready state in 462.37 seconds and the surrounding
CLI request completed in 467.42 seconds. A cache hit remains content-, path-,
language-, and extractor-contract-fenced and revalidates the source manifest
before use.

## Streaming and document-reduction findings

Resolver publication originally retained a second fully text-encoded
`Vec<Vec<u8>>` for each fact group. The final measured candidate lazily encodes
each validated typed row directly into the 1 MiB COPY transport buffer. Group
row, logical-byte, and retained-memory caps remain in force.

The first large document partition also exposed an exact 120-second Reduce
failure: conflict validation materialized and hashed large code/natural-text
fields for every unique document. The final query probes the typed reduction
index for another row with the same document ID and performs exact full-field
comparison only for actual duplicate identities. A live regression stages two
byte-different rows with one document ID and proves that the partition still
fails closed. The optimized full corpus subsequently reduced all document
partitions and published the locked digest.

The final run also reproduced the previously generic failure boundary. One
streamed Resolve work item can contain millions of durable rows, so reporting
progress only when that outer item returned made healthy work appear idle for
the production ten-minute watchdog. Resolve now advances the supervisor only
after exact extracted pages, committed fact batches, completed derived passes,
centrality work, and committed score batches. This is work-derived progress,
not a timer pulse, and a true future stall is surfaced with its active stage and
qualified `progress_stalled` reason.

## Reproduce

Use a fresh dedicated schema for a cold measurement and retain the exact source
policy above:

```sh
export CARTOGRAPH_DATABASE_URL='postgresql://...'
export CARTOGRAPH_DATABASE_SCHEMA='cartograph_large_public_benchmark'

/usr/bin/time -lp cartograph index /absolute/path/to/vscode \
  --workers 16 --format json >index-result.json

cartograph status /absolute/path/to/vscode --format json
cartograph context 'trace extension host request dispatch' \
  --project-path /absolute/path/to/vscode --format json
```

The release gate additionally runs memory-vs-PostgreSQL digest parity, the
1/2/4/8/16-worker frozen matrix, hostile conflict/fence tests, the complete
live PostgreSQL suite, and archive/privacy verification. This public-corpus
measurement supplements those deterministic gates; it does not replace them.
