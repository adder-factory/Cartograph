# Cartograph language-coverage report

> Regenerated **2026-05-26** from `__tests__/language-coverage.test.ts`
> against the fixtures in `docs/test-beds/<lang>/fixture.<ext>` — one
> per language. Each fixture is a small idiomatic program exercising
> the language's main symbol forms (a function, a call, a variable /
> field; a type or class where the language has them).
>
> Re-run with: `COVERAGE=1 bun test __tests__/language-coverage.test.ts`
>
> Bumps over the 2026-05-19 edition: Ruby `field` + `constant` (F#34 +
> F#35), C `constant` + `returns` + `field_access` (F#38 + F#39 +
> F#40), C++ `constant` + `returns` (F#38 + F#40 — small surface in
> the fixture; the C++ field_access path is wired identically and
> fires on richer corpora), Go `field_access` + `instantiates` (F#42 +
> F#44), Kotlin `field_access` (F#43), and a new **Vue** language
> entirely (F#47 — `.vue` SFC files via a custom extractor that
> delegates the script block to TS/JS tree-sitter). Pre-F#34/F#38 C
> and Ruby had no `constant`-kind nodes at all; pre-F#39/F#40 C had
> no `field_access`/`returns` edges; pre-F#42 Go had no
> `field_access` edges; pre-F#43 Kotlin had no `field_access` edges;
> pre-F#47 `.vue` files were dropped silently. See "Recent additions"
> below.

**36 languages**, every fixture parsed with no hard error. 35 produced
at least one real symbol and one edge; `yaml` is the documented zero-
emit exception (grammar-loaded shim for the Drupal framework
resolver — see `KNOWN_ZERO_SYMBOL_LANGUAGES` in
`__tests__/language-coverage.test.ts`). The matrices below are the raw
per-language extraction output; "Reading the matrices" interprets it.

## Node-kind matrix

> `·` = zero of that kind in this fixture; numbers are counts.
> `total` counts every node including the per-file `file` node.

| Lang | function | method | class | struct | interface | trait | protocol | enum | enum_member | type_alias | field | property | variable | constant | import | export | module | component | table | resource | total |
|------|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| bash       | 2 | · | · | · | · | · | · | · | · | · | · | · | 1 | · | · | · | · | · | · | · | 4 |
| c          | 3 | · | · | 2 | · | · | · | · | · | · | · | · | · | 1 | 2 | · | · | · | · | · | 9 |
| cpp        | 1 | 3 | 2 | · | · | · | · | · | · | · | · | · | · | 1 | 3 | · | · | · | · | · | 11 |
| csharp     | · | 4 | 4 | · | · | · | · | · | · | · | 1 | 1 | · | · | 2 | · | · | · | · | · | 13 |
| dart       | 1 | 2 | 2 | · | · | · | · | · | · | · | 2 | · | · | · | 1 | · | · | · | · | · | 9 |
| elixir     | 2 | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | 1 | · | · | · | 4 |
| fish       | 2 | · | · | · | · | · | · | · | · | · | · | · | 1 | · | · | · | · | · | · | · | 4 |
| go         | 1 | 2 | · | 2 | · | · | · | · | · | · | 2 | · | · | 1 | 1 | · | · | · | · | · | 10 |
| graphql    | 1 | · | 8 | · | 2 | · | · | 2 | 3 | 3 | 14 | · | · | · | · | · | · | · | · | · | 34 |
| hcl        | · | · | · | · | · | · | · | · | · | · | · | · | 1 | · | · | 1 | · | · | · | 2 | 5 |
| java       | · | 5 | 4 | · | · | · | · | · | · | · | 2 | · | · | · | 2 | · | · | · | · | · | 14 |
| javascript | 1 | 3 | 1 | · | · | · | · | · | · | · | · | · | · | 1 | 1 | · | · | · | · | · | 8 |
| jsx        | · | 1 | 1 | · | · | · | · | · | · | · | · | · | · | · | 2 | · | · | 1 | · | · | 6 |
| kotlin     | 1 | 3 | 3 | · | · | · | · | · | · | · | 1 | · | · | 1 | 1 | · | · | · | · | · | 11 |
| liquid     | · | · | · | · | · | · | · | · | · | · | · | · | 1 | · | 1 | · | · | 1 | · | · | 4 |
| lua        | 4 | 1 | · | · | · | · | · | · | · | · | · | · | 5 | · | 2 | · | · | · | · | · | 13 |
| objc       | · | 3 | 1 | · | · | · | 1 | · | · | · | · | 2 | · | · | 2 | · | · | · | · | · | 10 |
| pascal     | 1 | 2 | 2 | · | · | · | · | · | · | · | 2 | · | · | 1 | · | · | 1 | · | · | · | 10 |
| php        | 1 | 3 | 2 | · | · | · | · | · | · | · | 2 | · | · | 1 | · | · | · | · | · | · | 10 |
| prisma     | · | · | · | 2 | · | · | · | 1 | 3 | · | 9 | · | · | · | · | · | · | · | · | · | 16 |
| properties | · | · | · | · | · | · | · | · | · | · | · | · | · | 6 | · | · | · | · | · | · | 7 |
| python     | 1 | 2 | 2 | · | · | · | · | · | · | · | · | · | 1 | · | 1 | · | · | · | · | · | 8 |
| r          | 2 | · | · | · | · | · | · | · | · | · | · | · | 1 | 3 | 1 | · | · | · | · | · | 8 |
| rescript   | 4 | · | · | 2 | · | · | · | · | · | · | 2 | · | 1 | · | · | · | · | · | · | · | 10 |
| ruby       | 1 | 4 | 2 | · | · | · | · | · | · | · | 1 | · | · | 1 | 1 | · | · | · | · | · | 11 |
| rust       | 1 | 3 | · | 2 | · | 1 | · | · | · | · | · | · | 1 | · | 1 | · | · | · | · | · | 10 |
| scala      | · | 4 | 4 | · | · | · | · | · | · | · | 1 | · | · | · | · | · | · | · | · | · | 10 |
| sql        | 1 | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | 2 | · | 4 |
| svelte     | 1 | · | · | · | · | · | · | · | · | · | · | · | 3 | · | 2 | · | · | 1 | · | · | 8 |
| swift      | 1 | 3 | 2 | 1 | · | · | · | · | · | · | 2 | · | · | 1 | 1 | · | · | · | · | · | 12 |
| tsx        | · | 1 | 1 | · | 1 | · | · | · | · | · | · | · | · | · | 2 | · | · | 1 | · | · | 7 |
| typescript | 1 | 2 | 1 | · | 1 | · | · | · | · | · | 1 | · | · | 1 | 1 | · | · | · | · | · | 9 |
| vue        | 1 | · | · | · | 1 | · | · | · | · | · | · | · | · | 2 | 3 | · | · | 1 | · | · | 9 |
| xml        | · | 5 | · | · | · | · | · | · | · | 1 | · | · | · | · | · | · | · | · | · | · | 7 |
| yaml       | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | · | 1 |
| zsh        | 2 | · | · | · | · | · | · | · | · | · | · | · | 1 | · | · | · | · | · | · | · | 4 |

## Edge + reference matrix

> Combined `edges` and unresolved references (the latter become edges
> after the cross-file resolver pass). `total` = edges + refs.

| Lang | contains | calls | imports | extends | implements | references | type_of | returns | instantiates | field_access | total |
|------|---|---|---|---|---|---|---|---|---|---|---|
| bash       | 3 | 4 | · | · | · | · | · | · | · | · | 7 |
| c          | 8 | 3 | 2 | · | · | · | 1 | 1 | · | 3 | 18 |
| cpp        | 10 | 4 | 3 | · | · | · | 4 | 1 | 1 | · | 23 |
| csharp     | 12 | 4 | 2 | · | · | · | 2 | 1 | 1 | · | 22 |
| dart       | 8 | 4 | 1 | · | · | · | 1 | 1 | · | · | 15 |
| elixir     | 3 | 1 | · | · | · | · | · | · | · | · | 4 |
| fish       | 3 | 3 | · | · | · | · | · | · | · | · | 6 |
| go         | 11 | 4 | 1 | · | · | · | 3 | 1 | 1 | 2 | 23 |
| graphql    | 33 | · | · | 5 | 1 | 3 | 4 | · | · | · | 46 |
| hcl        | 4 | · | · | · | · | 1 | · | · | · | · | 5 |
| java       | 13 | 5 | 2 | · | · | · | 5 | 1 | 1 | 4 | 31 |
| javascript | 7 | 3 | 1 | · | · | 1 | · | · | 1 | · | 13 |
| jsx        | 5 | 1 | 2 | · | · | 2 | · | · | · | · | 10 |
| kotlin     | 10 | 5 | 1 | · | · | · | 3 | 2 | · | 1 | 22 |
| liquid     | 3 | · | · | · | · | 1 | · | · | · | · | 4 |
| lua        | 12 | 5 | · | · | · | · | · | · | · | · | 17 |
| objc       | 9 | 4 | 2 | 1 | 1 | · | · | · | · | · | 17 |
| pascal     | 9 | 5 | · | · | · | · | 2 | 1 | · | · | 17 |
| php        | 9 | 3 | · | · | · | · | 2 | 1 | 1 | · | 16 |
| prisma     | 15 | · | · | · | · | · | 3 | · | · | · | 18 |
| properties | 6 | · | · | · | · | · | · | · | · | · | 6 |
| python     | 7 | 5 | 1 | · | · | · | 2 | 1 | · | 2 | 18 |
| r          | 7 | 10 | · | · | · | · | · | · | · | · | 17 |
| rescript   | 9 | 6 | · | · | · | · | 6 | 3 | · | · | 24 |
| ruby       | 10 | 4 | 1 | · | · | · | · | · | · | · | 15 |
| rust       | 12 | 5 | 1 | · | · | · | 7 | 2 | 1 | 2 | 30 |
| scala      | 9 | 3 | · | · | · | · | 3 | 4 | · | · | 19 |
| sql        | 3 | · | · | · | · | 2 | · | · | · | · | 5 |
| svelte     | 13 | 2 | 2 | · | · | 2 | 2 | 1 | · | · | 22 |
| swift      | 11 | 4 | 1 | · | · | · | 3 | 2 | · | · | 21 |
| tsx        | 6 | 1 | 2 | 1 | · | 2 | 1 | 1 | · | 5 | 19 |
| typescript | 8 | 3 | 1 | · | · | 1 | 6 | 1 | 1 | 3 | 24 |
| vue        | 15 | 3 | 3 | · | · | 4 | 2 | 1 | · | 4 | 32 |
| xml        | 6 | · | · | · | · | 1 | · | · | · | · | 7 |
| yaml       | · | · | · | · | · | · | · | · | · | · | 0 |
| zsh        | 3 | 3 | · | · | · | · | · | · | · | · | 6 |

## Reading the matrices

Three groups, by what the language's source actually carries:

### Statically-typed source languages — full structural + type extraction

C, C++, C#, Dart, Go, Java, Kotlin, Pascal, PHP, ReScript, Rust,
Scala, Swift, TypeScript, TSX, Python — symbols (functions / methods /
classes / structs / fields), `contains` / `calls` / `imports`, and the
type layer: `type_of` (params, fields, locals) plus `returns` where the
language has explicit return-type syntax. Rust (7 `type_of`), TypeScript
and ReScript (6) are the richest on their fixtures. C / C++ now also
emit `returns` edges (F#40, 2026-05-26 — `returnField: 'type'` matches
tree-sitter-c's `function_definition` shape; primitive returns like
`int` / `void` correctly suppress via `BUILTIN_TYPES`). `field_access`
edges for `obj.field` / `this.field` reads ship for TS / TSX / JS / JSX
(`member_expression`), Rust (`field_expression`), Python (`attribute` —
F#26, 2026-05-26), Java (`field_access` — F#27, 2026-05-26),
C / C++ for both `obj.field` and `obj->field` (F#39, 2026-05-26 — both
operators parse to the same `field_expression` node), Go
(`selector_expression` — F#42, 2026-05-26), and Kotlin
(`navigation_expression` — F#43, 2026-05-26 — Kotlin's property leaf
is nested inside `navigation_suffix`, so the dispatch shape gained an
optional `propertyDescendantKind` field to descend through the
intermediate node). See `FIELD_ACCESS_SHAPE_BY_LANGUAGE` in
`src/extraction/ts-extract-bodies.ts` for the per-grammar dispatch table.

### Dynamic / shell languages — structural extraction only

JavaScript, JSX, Ruby, R, Lua, Bash, Zsh, Fish, Elixir — no static type
annotations, so zero `type_of` / `returns` is correct, not a gap. They
still produce functions, calls, imports, and `contains`. Notes:
- **Lua** — `function M:foo()` colon syntax is extracted as a `method`
  (the fixture's `M:size` shows as `method: 1`); the other three
  function forms stay `function`.
- **Bash / Zsh / Fish** — functions, variables, command calls.
- **Elixir** — onboarded via the `tags.scm` fallback extractor; baseline
  coverage (a `module` + `function` definitions + call references).
- **Ruby** — uppercase-LHS assignments (`MODULES = [...]`) extract as
  `constant` nodes (F#34, 2026-05-26), and class-body accessor macros
  (`attr_reader` / `attr_writer` / `attr_accessor` / `class_attribute`)
  emit one `field` per symbol arg (F#35, 2026-05-26). Method-call
  receivers via `obj.method()` are still call-emission only — Ruby's
  AST factors method receivers differently so they don't enter the
  field-access path.

### Schema / config / template DSLs

- **GraphQL** — the richest fixture (34 nodes): an SDL schema maps types
  → `class`, fields → `field`, plus `interface` / `enum` / `enum_member`
  / `type_alias`, with `type_of` field-to-type references.
- **Prisma** — `model` / composite `type` → `struct`, columns → `field`,
  `enum` → `enum` + `enum_member`; relation fields emit `type_of`.
- **SQL** — DDL: `CREATE TABLE` → `table`, `CREATE FUNCTION` → `function`.
- **HCL / Terraform** — `resource`, `variable`, `export` (outputs).
- **Liquid** — templates: `component`, `variable`, `import`.
- **Svelte** + **Vue** — SFC files (multi-block: script + template +
  style). Both use `customExtractor` LangDefs (no tree-sitter
  grammar shipped). One `component` node per file; the `<script>`
  block delegates to TS or JS tree-sitter for the inner symbols
  (so Vue/Svelte inherit field_access, type_of, returns, etc.
  from the JS/TS path automatically). Vue mustache `{{ … }}` and
  Svelte single-brace `{ … }` template expressions sweep for
  function calls so cross-file edges aren't lost in markup;
  PascalCase template tags (`<Modal />`) emit `references` edges
  to component imports. Vue's seven compiler macros (defineProps
  et al.) are filtered from the calls stream.

Embedded schema DSLs are also recognised *inside* a host language — a
Zod schema (TS/JS) or a Pydantic model (Python) yields `struct` /
`field` / `enum_member` nodes. Those run through the schema-recognizer
registry and have their own fixtures + suites
(`__tests__/fixtures/schema-recognizers/`), so they are out of scope
for this language-fixture report.

## Fixtures

One `fixture.<ext>` per language under `docs/test-beds/<lang>/` — 36 in
all. Adding a language adds a fixture there; the parity-guard discovers
it automatically (see the cookbook, `docs/ADDING-A-LANGUAGE.md`).

## Test surface

- **`__tests__/language-coverage.test.ts`** — the always-on
  parity-guard. One `it` row per language asserts the extraction floor
  (parses without a hard error, ≥ 1 real symbol, ≥ 1 edge) — a
  regression tripwire for a grammar bump or refactor silently zeroing
  an extractor. `COVERAGE=1` additionally writes the full per-language
  breakdown to `/tmp/language-coverage.json` and logs a summary line.
- **`__tests__/multi-language-typeof.test.ts`** — per-typed-language
  regression tests asserting minimum `type_of` / `returns` edge counts.
- **`__tests__/extraction.test.ts`** — F#34-F#47 fixture tests for
  the Ruby / C / C++ / Go / Kotlin / TS-interface-extends / Vue
  additions land here (search for `F#34` … `F#47`).
- **`__tests__/tests-edges-imports-fallback.test.ts`** — F#46
  Kotlin / Java / Scala package-path tests-edges resolver tests.

## Recent additions (2026-05-26 arc)

- **F#34 — Ruby `constant` nodes.** `MODULES = [...]` and class-scoped
  `DEFAULT_TIMEOUT = 30` extract as `constant` (signature captured).
  Live-bench: rails 0 → 1516. Code: `src/extraction/languages/ruby.ts`.
- **F#35 — Ruby `field` nodes via class macros.** `attr_reader`,
  `attr_writer`, `attr_accessor`, `class_attribute` synthesise one
  `field` per symbol arg on the enclosing class. Hash-kwarg arguments
  to `class_attribute` are filtered out. DSL macros like `validates`,
  `has_many`, `before_action` correctly do NOT trigger. Live-bench:
  rails 0 → 2060. Code: `src/extraction/languages/ruby.ts`.
- **F#36 — Python multi-line `from X import (A, B)`.** Resolver-side
  fix. `src/resolution/import-resolver.ts > extractPythonImports`
  regex now matches both parenthesised multi-line and legacy
  single-line shapes. Inline `# comment` tails inside paren imports
  stripped so the next name isn't silently dropped. Live-bench:
  pandas `implements` edges 1 → 22.
- **F#38 — C / C++ `#define` constants.** `preproc_def` nodes extract
  as `constant`; flag-only macros (no value) supported.
  `preproc_function_def` (function-like macros) deliberately out of
  scope. Live-bench: redis c 0 → 4257, cpp 0 → 119. Code:
  `src/extraction/languages/c-cpp.ts > extractCPreprocDefConstant`.
- **F#39 — C / C++ `field_access` edges.** `obj.field` AND `obj->field`
  parse to the same `field_expression` node in tree-sitter-c; cpp
  inherits. `parentTypesToSkip: {call_expression}` dedupes
  method-call receivers. Live-bench: redis c 0 → 4624, cpp 0 → 11.
  Code: `FIELD_ACCESS_SHAPE_BY_LANGUAGE` entries for c + cpp.
- **F#40 — C / C++ `returns` edges.** `returnField: 'type'` matches
  tree-sitter-c's `function_definition.type` field. Primitive returns
  (`int`, `void`, …) correctly suppressed by `BUILTIN_TYPES`.
  Live-bench: redis c 0 → 2283, cpp 0 → 7. Code:
  `src/extraction/languages/c-cpp.ts`.
- **F#41 — self-heal hash list.** Every `src/extraction/languages/*.ts`
  extractor (plus `registry.ts`) now contributes to the
  `EXTRACTION_LOGIC_VERSION` hash, so a per-language edit trips the
  re-extract heal on existing indexed projects. Code:
  `src/extraction/extraction-logic-version.ts`.
- **F#42 — Go `field_access` edges.** `obj.field` parses to
  `selector_expression(operand, field=field_identifier)` in
  tree-sitter-go. Method calls `obj.M(...)` wrap the selector in a
  `call_expression`, so `parentTypesToSkip: {call_expression}` dedupes
  them out of the field-access stream — same shape pattern as F#39's
  C/C++ entries. Cgo's `C.foo(...)` pseudo-receiver sits under
  `call_expression` and is filtered by the same skip. Live-bench: gin
  Go 0 → 1211 field_access edges. Code:
  `FIELD_ACCESS_SHAPE_BY_LANGUAGE` entry for go.
- **F#43 — Kotlin `field_access` edges.** `obj.field` parses to
  `navigation_expression(operand, navigation_suffix(., simple_identifier))`
  in tree-sitter-kotlin — the property leaf is NESTED inside the
  intermediate `navigation_suffix` node, unlike every other supported
  grammar where the leaf is a direct child. `FieldAccessShape` gained
  an optional `propertyDescendantKind` field (set to `'simple_identifier'`
  for Kotlin) so the dispatch descends one more level after the
  positional-fallback child lookup; existing entries leave it
  undefined and keep the direct-child behaviour. Method calls
  `obj.m(...)` wrap the navigation_expression in `call_expression`,
  dedupe via the standard parent-skip set. Live-bench: exposed
  (JetBrains/Exposed, 794 .kt files) 0 → 9092 field_access edges.
  Code: `FIELD_ACCESS_SHAPE_BY_LANGUAGE` entry for kotlin and the
  `propertyDescendantKind` extension in `captureBodyFieldAccess`.
- **F#44 — Go `instantiates` + `references` edges.** Two parts:
  (a) `composite_literal` (Go's `Foo{X: 1}` and `&Foo{X: 1}`) joined
  `INSTANTIATION_KINDS`. The shared `composite_literal` AST node also
  carries slice / map / array literals (`[]int{...}`,
  `map[string]int{...}`); a new `STRUCT_LITERAL_CTOR_KINDS` set
  ({type_identifier, qualified_type, generic_type}) gates the emit
  so non-struct shapes don't leak through. Live-bench: gin Go 0 →
  393 instantiates edges.
  (b) `captureBodyConstantReads` extended to also fire on Go bare
  PascalCase-identifier reads — the Go-exported-symbol convention
  (`return Form`, `var x = DefaultWriter`). The matcher diverges from
  the JS/Rust SCREAMING_SNAKE path (`GO_PASCAL_NAME_RE`) and gates
  on a Go-specific `isGoDeclBindingPosition` helper for the var_spec /
  const_spec / parameter_declaration / short_var_declaration /
  range_clause skip positions. Live-bench: gin Go 0 → 647 references
  edges. The `def_use` portion of F#44 deferred — opt-in per CLAUDE.md.
- **F#45 — TS `interface X extends Y` edges.** Pre-fix, the
  inheritance dispatcher had no handler for `extends_type_clause`
  (the tree-sitter-typescript shape for interface-extends-interface);
  every multi-type clause silently dropped to zero edges. Added the
  `extendsTypeClause` handler that walks ALL named children (catching
  multi-extends `interface Cat extends Animal, Mammal` which the
  generic handler's `[namedChild(0)]` fallback truncated to one)
  and drills into `generic_type` wrappers for `extends Map<K, V>`.
  Live-bench: vuejs/core 4 → 153 extends edges. Code:
  `src/extraction/tree-sitter-inheritance.ts`.
- **F#46 — Kotlin / Java / Scala tests-edges via package-path
  imports.** The tests-edges hook's imports-walk fallback previously
  only handled relative paths (`./foo`); Kotlin / Java imports use
  package-rooted paths (`org.jetbrains.exposed.v1.core.Table`) so
  Kotlin tests resolved to zero subjects through that fallback. Added
  `resolvePackagePathImportToIndexedFile` that takes the import's
  tail segment as a basename, looks it up in a precomputed
  basename → [paths] index (one pass over allFilePaths, amortised
  across every test file), then suffix-matches candidates against
  `/org/jetbrains/exposed/v1/core/Table.{kt,java,scala}`. Returns
  null for external libs (`java.util.UUID` has no project file
  matching that suffix). Live-bench: JetBrains/Exposed Kotlin
  tests-edges 23 → 593 (25×). Code:
  `src/index-hooks/tests-edges.ts`.
- **F#47 — Vue SFC (`.vue`) support.** New custom-extractor LangDef
  (`src/extraction/languages/vue.ts` + `src/extraction/vue-extractor.ts`)
  mirroring the Svelte design — strip non-script blocks, delegate
  `<script>` content to TS or JS tree-sitter (routed by `lang="ts"`
  attribute), and sweep templates for `{{ … }}` mustache calls and
  PascalCase component-tag references. Vue 3 compiler macros
  (`defineProps` / `defineEmits` / `defineExpose` / `defineOptions` /
  `defineModel` / `defineSlots` / `withDefaults`) filtered from the
  calls stream. Every .vue file emits a `component` node — Vue
  components are always importable. Live-bench: vuejs/core indexed
  files 524 → 535 (+11 .vue SFCs that were previously dropped
  silently). Added to `EXTRACTION_LOGIC_VERSION` spec
  (`./languages/vue` + `./vue-extractor`; `./svelte-extractor` was
  a pre-existing gap caught during the F#47 review and added
  alongside for parity).
- **F#49 — Skip likely-minified JS-family files.** Content-based
  detector: avg line length > 200 chars indicates minification
  (real hand-formatted JS is 25-40; minified is 566+). Applied in
  both the indexAll path (`eoProcessOneFile`) and the small-batch
  sync path (`indexFileWithContent`). Live-bench: exposed indexed
  files 803 → 800 (3 minified `docs/api/scripts/` files filtered:
  `main.js` / `prism.js` / `sourceset_dependencies.js`); spurious
  function nodes dropped 939 → ~30 (-910). Code:
  `src/extraction/extraction-phases.ts > isMinifiedJsFamily`.
- **F#50 — Indexer edge-count message reflects post-hook DB state.**
  Pre-fix, the CLI's `"N nodes, M edges"` printed the extraction-only
  count, undercounting by 2-3× on real corpora because resolve +
  post-hook passes (go-implements, tests-edges, value-ref-edges, …)
  add edges later. `cgRefreshIndexResultCounts` re-reads from the
  DB after maintenance, before the CLI printer renders. Cost is
  microseconds (one compound COUNT plus three GROUP BY scans).
  Live-bench example: gin's indexer line went from `"2,819 nodes,
  2,904 edges"` to `"2,819 nodes, 9,739 edges"`.
- **F#51 — Shallow-clone hint in `cartograph_status` hotspots
  rollup.** When (a) the repo is a shallow clone AND (b) ≥ half of
  rendered rows show `commitCount === 0`, the rollup gains a one-line
  italic-fenced banner suggesting `git fetch --unshallow`. Mirrors
  the existing `hotspots.ts` banner; kept separate so the
  lightweight status onboarding wording can differ from the
  drill-down tool's voice. Code:
  `src/mcp/tools/status.ts > statusShallowCloneBanner`.

## Recent additions (2026-05-27 arc — B11 Spring/MyBatis)

- **F#64c — Spring `@Value("${k}")` config-key linkage.** New
  `properties` language extractor (line-oriented regex, no
  tree-sitter grammar — same pattern as liquid / hcl / sql) emits
  one `constant` node per `key=value` line. New `spring-value-binding`
  index hook reads B9 `decoratorArgs` off JVM field/property nodes
  whose `@Value` decorator names a `${key}` placeholder, emits a
  `references` edge to the matching constant. Also extended the
  universal decorator-args extractor to recognise Java/Kotlin's
  `annotation_argument_list` and C#'s `attribute_argument_list`
  (pre-F#64c only TS/JS-style `call_expression` was handled, so
  Java `@Value("${k}")` never populated `decoratorArgs`). Code:
  `src/extraction/languages/properties.ts`,
  `src/index-hooks/spring-value-binding.ts`,
  `src/extraction/ts-extract-calls.ts`.
- **F#62 / F#65 fixture catch-up.** Both languages onboarded
  2026-05-26 shipped without `docs/test-beds/<lang>/fixture.<ext>`;
  added in this arc. The `objc` fixture is a full
  `@interface`/`@implementation` shape (3 methods, 2 properties, 1
  protocol, multi-keyword selector). The `yaml` fixture is a Drupal
  routing.yml shape — yaml is documented zero-emit (`yamlExtractor`
  has empty `*Types` lists, see `src/extraction/languages/yaml.ts`),
  so the parity-guard exempts it from the symbol/edge floor via
  `KNOWN_ZERO_SYMBOL_LANGUAGES` in
  `__tests__/language-coverage.test.ts`. The fixture's job is just
  to prove the grammar parses a real-world routing.yml without
  error — symbol emission is the Drupal framework resolver's job.
- **F#64b — MyBatis XML extractor + Java↔XML linkage.** New `xml`
  language (regex-based — the `@tree-sitter-grammars/tree-sitter-xml`
  package ships source-only, no pre-built `.wasm`). Detects MyBatis
  via `<mapper namespace="...">` root marker; emits one `method` node
  per `<select|insert|update|delete|sql>` and one `type_alias` per
  `<resultMap>` / `<parameterMap>`. `<include refid="X"/>` inside
  statement bodies emits unresolved refs shaped as `<Class>::<id>`,
  picked up by the standard resolver's qualifiedName-match path.
  XML comments (`<!-- ... -->`) stripped before regex-scanning so
  doc-text containing element-shaped strings doesn't false-extract.
  New `mybatis-binding` index hook resolves XML statement
  qualifiedNames to Java/Kotlin Mapper-interface method nodes,
  emitting cross-language `references` edges. Code:
  `src/extraction/languages/xml.ts`,
  `src/index-hooks/mybatis-binding.ts`.
