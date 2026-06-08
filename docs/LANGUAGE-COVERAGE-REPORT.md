# Cartograph Language-Coverage Report

> Regenerated **2026-06-08** from
> `COVERAGE=1 bun test --timeout 30000 __tests__/language-coverage.test.ts`
> against `docs/test-beds/<lang>/fixture.<ext>`.

Cartograph carries a fixture smoke set for the main symbol-emitting and
parser-only language modes:

- **60 fixture-backed language modes** parsed without a hard error.
- **53 symbol-emitting modes** produced at least one real symbol and one edge.
- **7 zero-symbol modes** are intentional parser-only or framework-dispatch
  modes: `css`, `embedded_template`, `html`, `jsdoc`, `json`, `regex`, `yaml`.

The support matrix is the source of truth for shipped languages:
[SUPPORT-MATRIX.md](SUPPORT-MATRIX.md). This report is the regression fixture
snapshot used to catch parser, extractor, and tags-query drift.

## Current Fixture Snapshot

`symbols` excludes the synthetic per-file node. `refs` are unresolved
references that become graph edges after cross-file resolution.

| Language mode | Nodes | Symbols | Edges | Refs | Non-file node kinds |
|---|---:|---:|---:|---:|---|
| abap | 3 | 2 | 2 | 0 | class:1, method:1 |
| apex | 3 | 2 | 2 | 4 | class:1, method:1 |
| arkts | 8 | 6 | 7 | 7 | import:1, struct:1, field:1, method:3, class:1 |
| astro | 5 | 3 | 7 | 3 | component:1, import:1, constant:1, function:1 |
| aura | 3 | 2 | 2 | 4 | component:1, field:1 |
| bash | 4 | 3 | 3 | 4 | variable:1, function:2 |
| c | 9 | 6 | 8 | 10 | import:2, constant:1, struct:2, function:3 |
| cpp | 11 | 7 | 10 | 13 | import:3, constant:1, class:2, method:3, function:1 |
| csharp | 13 | 10 | 12 | 11 | import:2, class:4, property:1, field:1, method:4 |
| css | 1 | 0 | 0 | 0 | file only |
| cuda | 4 | 2 | 3 | 3 | import:1, function:2 |
| dart | 9 | 7 | 8 | 7 | import:1, class:2, field:2, method:2, function:1 |
| elixir | 4 | 3 | 3 | 1 | module:1, function:2 |
| embedded_template | 1 | 0 | 0 | 0 | file only |
| fish | 4 | 3 | 3 | 3 | variable:1, function:2 |
| glsl | 4 | 3 | 3 | 2 | struct:1, function:2 |
| go | 10 | 8 | 11 | 12 | import:1, struct:2, field:2, method:2, function:1, constant:1 |
| graphql | 34 | 33 | 33 | 13 | type_alias:3, class:8, field:14, interface:2, enum:2, enum_member:3, function:1 |
| groovy | 7 | 5 | 6 | 3 | import:1, class:1, method:3, function:1 |
| haskell | 5 | 4 | 4 | 0 | module:1, function:3 |
| hcl | 5 | 4 | 4 | 1 | variable:1, resource:2, export:1 |
| html | 1 | 0 | 0 | 0 | file only |
| java | 14 | 11 | 13 | 18 | import:2, class:4, field:2, method:5 |
| javascript | 8 | 6 | 8 | 10 | import:1, class:1, method:3, function:1, constant:1 |
| jsdoc | 1 | 0 | 0 | 0 | file only |
| json | 1 | 0 | 0 | 0 | file only |
| jsx | 6 | 3 | 5 | 10 | import:2, class:1, method:1, component:1 |
| julia | 4 | 3 | 3 | 2 | module:1, struct:1, function:1 |
| kotlin | 12 | 10 | 11 | 14 | import:1, class:3, field:2, method:3, function:1, constant:1 |
| lean | 10 | 8 | 9 | 1 | import:1, struct:1, field:1, enum:1, enum_member:2, function:2, type_alias:1 |
| liquid | 4 | 2 | 3 | 1 | import:1, component:1, variable:1 |
| lua | 13 | 10 | 12 | 5 | variable:5, import:2, function:4, method:1 |
| luau | 5 | 4 | 4 | 1 | type_alias:1, function:1, variable:1, method:1 |
| objc | 10 | 7 | 9 | 8 | import:2, protocol:1, class:1, property:2, method:3 |
| ocaml | 5 | 4 | 4 | 2 | type_alias:1, field:1, function:2 |
| ocaml_interface | 4 | 3 | 3 | 0 | type_alias:1, function:2 |
| pascal | 10 | 9 | 9 | 8 | module:1, class:2, field:2, method:2, function:1, constant:1 |
| php | 11 | 9 | 10 | 8 | import:1, class:2, field:2, method:3, function:1, constant:1 |
| prisma | 16 | 15 | 15 | 3 | enum:1, enum_member:3, struct:2, field:9 |
| properties | 7 | 6 | 6 | 0 | constant:6 |
| python | 8 | 6 | 7 | 11 | import:1, class:2, method:2, function:1, variable:1 |
| r | 8 | 6 | 7 | 10 | import:1, function:2, constant:3, variable:1 |
| regex | 1 | 0 | 0 | 0 | file only |
| rescript | 10 | 9 | 9 | 15 | struct:2, field:2, function:4, variable:1 |
| ruby | 11 | 9 | 10 | 6 | import:1, class:2, field:1, method:4, function:1, constant:1 |
| rust | 10 | 8 | 12 | 18 | import:1, struct:2, method:3, trait:1, function:1, variable:1 |
| scala | 10 | 9 | 9 | 10 | class:4, field:1, method:4 |
| solidity | 8 | 6 | 7 | 2 | import:1, class:1, struct:1, field:2, method:2 |
| sql | 4 | 3 | 3 | 2 | table:2, function:1 |
| svelte | 8 | 5 | 13 | 9 | component:1, import:2, variable:3, function:1 |
| swift | 12 | 10 | 11 | 10 | import:1, struct:1, field:2, class:2, method:3, function:1, constant:1 |
| tsx | 7 | 4 | 6 | 13 | import:2, interface:1, class:1, method:1, component:1 |
| typescript | 9 | 7 | 9 | 16 | import:1, interface:1, class:1, field:1, method:2, function:1, constant:1 |
| vbnet | 6 | 4 | 5 | 1 | import:1, class:1, property:1, method:2 |
| verilog | 2 | 1 | 1 | 0 | module:1 |
| visualforce | 3 | 2 | 2 | 3 | component:1, route:1 |
| vue | 9 | 5 | 15 | 17 | component:1, import:3, interface:1, constant:2, function:1 |
| xml | 7 | 6 | 6 | 7 | method:5, type_alias:1 |
| yaml | 1 | 0 | 0 | 0 | file only |
| zsh | 4 | 3 | 3 | 3 | variable:1, function:2 |

## 2026-06-07 Coverage Changes

- Added fixtures for the new Tree-sitter expansion modes: `css`,
  `embedded_template`, `haskell`, `html`, `jsdoc`, `json`, `julia`,
  `ocaml`, `ocaml_interface`, `regex`, and `verilog`.
- Added Salesforce fixtures for `apex`, `aura`, and `visualforce`.
- Added the missing `luau` fixture so that expansion tranche's fixture tree
  matched the registry at the time.
- Expanded the parity guard to require 51 fixtures and to distinguish
  symbol-emitting modes from documented parser-only modes.
- Updated `scripts/extraction-coverage.ts` so parser-only modes are reported as
  intentional zero-symbol coverage instead of likely extractor failures.

## 2026-06-08 Coverage Changes

- Added fixture coverage for `abap`, `astro`, `lean`, and `vbnet`.
- Raised the parity guard floor to 60 discovered fixtures.
- Regenerated the snapshot from `COVERAGE=1 bun test --timeout 30000
  __tests__/language-coverage.test.ts`.

Agda remains the known upstream parser gap for the current `web-tree-sitter`
runtime; see [SUPPORT-MATRIX.md](SUPPORT-MATRIX.md#tree-sitter-catalog-notes).

## Test Surface

- `__tests__/language-coverage.test.ts` is always on and runs one row per
  fixture. With `COVERAGE=1`, it writes `/tmp/language-coverage.json`.
- `__tests__/tree-sitter-upstream-languages.test.ts` covers grammar loading and
  representative parser-only / tags-query extraction for the 2026-06-07
  Tree-sitter expansion.
- `scripts/extraction-coverage.ts` is a diagnostic, not a gate. It walks
  grammar node types and highlights extractor blind spots for symbol-emitting
  languages.
