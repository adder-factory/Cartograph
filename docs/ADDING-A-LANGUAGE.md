# Adding a Language

This is a cookbook for adding a new language to Cartograph. It assumes you have a
working dev setup (`bun install`, `bun run typecheck`, and `bun run test:fast`
pass).

There are three patterns. **Pick the one that matches the language you're adding.**

| Language shape | Pattern | Examples |
|---|---|---|
| Procedural / OO with named functions, classes, methods | **`LanguageExtractor` config** | `python.ts`, `ruby.ts`, `r.ts` |
| Declarative / template / configuration / no named functions | **Custom extractor class** | `hcl-extractor.ts`, `liquid-extractor.ts`, `sql-extractor.ts` |
| Any language whose grammar ships a `queries/tags.scm` — when you want baseline coverage *fast* | **tags.scm fallback extractor** | `elixir.ts` |

Paths A and B are full hand-written extractors — they emit cartograph's complete
edge graph (imports, typed signatures, the method-vs-function split, …). Path C
is the **new-language onramp**: zero extractor code, just a vendored query, for a
strict-subset floor (definitions + `calls` references). Reach for Path C first;
graduate a language to Path A/B only once it earns the depth.

All three patterns share the same setup steps (1–4) and only diverge at the
extractor itself (step 5).

---

## 1. Source a tree-sitter WASM grammar

Cartograph parses everything via [`web-tree-sitter`](https://www.npmjs.com/package/web-tree-sitter),
so the grammar must be available as a `.wasm` file. Every grammar cartograph
ships is **vendored** in `src/extraction/wasm/`, named `<lang>.wasm` (e.g.
`python.wasm`, `c_sharp.wasm`) — there is no external grammar package. The
build's `copy-assets` script copies every `.wasm` from that directory into
`dist/extraction/wasm/` so the grammars ship inside the npm package.

### Produce the `.wasm`

`scripts/build-grammar-wasm.ts` produces the whole grammar set — it harvests
a grammar's bundled `.wasm` when one load-tests clean, otherwise builds from
source with `tree-sitter-cli` (a devDependency; recent versions ship their
own wasi-sdk — no Docker or local emcc needed). To add one grammar:

```bash
# Install the grammar's source package temporarily...
bun add -d tree-sitter-foo
# ...add a GRAMMARS entry in scripts/build-grammar-wasm.ts:
#   { wasm: 'foo', pkg: 'tree-sitter-foo', sample: '<minimal snippet>' }
# ...then build just that one:
bun scripts/build-grammar-wasm.ts --only=foo --force-build
# → src/extraction/wasm/foo.wasm, load-tested in web-tree-sitter 0.26.x
```

Remove the temporary grammar package before committing unless the package is
intentionally becoming a project dependency.

The `.wasm` must be ABI-compatible with web-tree-sitter 0.26.x (it accepts
ABI 13-15). The build script load-tests every output — but the load-test
only confirms the grammar PARSES, not that its node-type vocabulary matches
the extractor you'll write. A wrong-dialect grammar passes the load-test yet
extracts nothing, so always cross-check against your probe in step 2.

**License check.** Tree-sitter grammars are usually MIT or Apache-2.0 —
confirm before committing the wasm and note the source/version in a header
comment so the provenance is recoverable later. Keep checked-in grammar asset
provenance in `docs/GRAMMAR-ASSETS.md`.

**Count guard.** `__tests__/pr19-improvements.test.ts` asserts an *exact*
count of vendored `.wasm` files (a "did a grammar get dropped?" tripwire).
Adding one fails it — bump the expected count there (it's a one-line `toBe`).

---

## 2. Probe the AST

Don't guess at node types. Parse a representative sample and dump the tree:

```js
// scratch/probe.mjs — run from the repo root (so web-tree-sitter resolves)
import { Parser, Language } from 'web-tree-sitter';
import { readFileSync } from 'node:fs';
await Parser.init();
const lang = await Language.load(readFileSync('./src/extraction/wasm/foo.wasm'));
const parser = new Parser();
parser.setLanguage(lang);

const sample = `
// realistic code here — cover every construct you plan to extract
`;

const tree = parser.parse(sample);
function dump(n, d = 0, max = 4) {
  if (d > max) return;
  const text = n.text.length > 60 ? n.text.slice(0, 60).replace(/\n/g, '\\n') + '...' : n.text.replace(/\n/g, '\\n');
  console.log(`${'  '.repeat(d)}${n.type}  "${text}"`);
  for (let i = 0; i < n.namedChildCount; i++) dump(n.namedChild(i), d + 1, max);
}
dump(tree.rootNode);
```

```bash
node scratch/probe.mjs
```

Cover every construct you plan to extract: function definitions, classes, methods,
imports, assignments, calls, references. Watch for surprises:

- Some grammars wrap names in extra layers (`identifier > simple_identifier`)
- Field names (`childForFieldName`) often differ from what the docs imply
- Operator nodes can be named, unnamed, or both — call `child(i)` vs `namedChild(i)`
  and inspect

Save the probe output before you start coding — you'll refer to it constantly.

---

## 3. Register the language

Adding a language is **one new file plus two registry lines**. The per-language
registry (`src/extraction/languages/`) is the single source of truth — extension
maps, include globs, grammar config, and the EXTRACTORS lookup are all derived
from it.

**Step 3a — Create `src/extraction/languages/foo.ts`** with a `LanguageDef`:

```ts
import type { LanguageExtractor } from '../tree-sitter-types.js';
import type { LanguageDef } from './types.js';

// Path A languages (procedural / OO — Python, Ruby, R) define a
// LanguageExtractor here and reference it from the def below.
export const fooExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: ['class_definition'],
  // ... see Section 5a for the full shape
};

export const FOO_DEF: LanguageDef = {
  name: 'foo',
  displayName: 'Foo',
  extensions: ['.foo'],
  includeGlobs: ['**/*.foo'],
  grammar: {
    wasmFile: 'foo.wasm',
    extractor: fooExtractor,
  },
  // For Path B languages (HCL / SQL / Liquid — non-OO), set
  // customExtractor instead of (or in addition to) `extractor`:
  // customExtractor: (filePath, source) => new FooExtractor(filePath, source).extract(),
};
```

**Step 3b — Register in `src/extraction/languages/registry.ts`** (2 lines):

```ts
import { FOO_DEF } from './foo.js';   // alphabetical
// ...
const ALL_DEFS: readonly LanguageDef[] = [
  // ... existing definitions, alphabetical
  FOO_DEF,
  // ...
];
```

**Step 3c — Add `'foo'` to the `Language` union (`src/graph/core-types.ts`) AND to
`VALID_LANGUAGES` (`src/config.ts`)** — two lines, two files:

```ts
// src/graph/core-types.ts
export type Language =
  | 'typescript'
  | ...
  | 'foo'                  // ← add here
  | 'unknown';

// src/config.ts — VALID_LANGUAGES must stay in sync with the union.
// A compile-time guard (`_LanguageCoverageOk`) fails the typecheck in
// step 4 if you add to one and not the other.
const VALID_LANGUAGES = [
  ...
  'foo',                   // ← and here
  'unknown',
] as const satisfies readonly Language[];
```

`DEFAULT_CONFIG.include`, `EXTENSION_MAP`, the legacy `EXTRACTORS` lookup, and
`getLanguageDisplayName()` are all derived from the registry — no other
parallel lists to keep in sync. Add the union and `VALID_LANGUAGES` entries in
the same change so config validation, TypeScript narrowing, and extractor code
all agree.

> **Why per-file?** Two PRs adding two different languages used to collide on
> the same `EXTRACTORS` map, the same `EXTENSION_MAP`, the same `Language`
> union, and the same central wasm table. With per-file `LanguageDef`s, two
> language PRs only conflict if their alphabetical positions in `registry.ts`
> happen to land on the same line — almost never. See
> `src/extraction/languages/` for worked examples.

Update the public docs in the same change:

- Add the language to `docs/SUPPORT-MATRIX.md`.
- If the README compact matrix needs a new grouping, update `README.md`.

`__tests__/readme-drift.test.ts` checks the registry count and support-matrix
display names so public docs fail fast when a language is added without docs.

---

## 4. Type-check before writing the extractor

Run `bun run typecheck` now (tsgo — fast). If it's not clean, the wiring is
wrong — fix that before adding extraction logic, otherwise type errors will
pile up.

---

## 5a. Path A — Plug into `LanguageExtractor`

Use this when the language has named function/class/method declarations (Python, Ruby,
Java, R, etc.). Create `src/extraction/languages/<lang>.ts`:

```ts
import type { LanguageExtractor } from '../tree-sitter-types.js';

export const fooExtractor: LanguageExtractor = {
  // Map AST node types → graph kinds. Empty array = "this kind doesn't
  // exist in this language."
  functionTypes: ['function_definition'],
  classTypes: ['class_definition'],
  methodTypes: ['function_definition'],   // often the same node, dispatched by context
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['import_statement'],
  callTypes: ['call'],
  variableTypes: ['assignment'],

  // Field names tree-sitter exposes for extractors to read.
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',

  // Optional hooks — implement what you need:
  getSignature: (node, source) => { ... },
  isExported: (node, source) => { ... },
  isAsync: (node) => { ... },

  // Escape hatch: take over a specific node type entirely. Return true to
  // tell the core "I handled this, skip default dispatch."
  visitNode: (node, ctx) => {
    // R uses this to handle `name <- function() {}` because tree-sitter's
    // function_definition has no name field — the name is on the LHS of
    // the enclosing assignment.
    return false;
  },
};
```

Reference it from your `LanguageDef` (Section 3a):

```ts
// in src/extraction/languages/foo.ts
export const FOO_DEF: LanguageDef = {
  name: 'foo',
  // ...
  grammar: { wasmFile: 'foo.wasm', extractor: fooExtractor },
};
```

The core (`TreeSitterExtractor` in `src/extraction/tree-sitter.ts`) does the rest:
walks the AST, dispatches based on your `*Types` arrays, calls your hooks, manages
the scope stack, and emits nodes/edges.

**Worked example: R** (`src/extraction/languages/r.ts`). R's `function_definition`
has no name (it's anonymous), so `functionTypes` is empty and the `visitNode` hook
intercepts `binary_operator` assignments and emits the function manually via
`ctx.createNode('function', name, ...)`.

## 5b. Path B — Custom extractor class

Use this when the language is declarative (HCL, SQL, dbt) or has a fundamentally
different shape than functions/classes/methods (Liquid templates, Pascal `.dfm` form
files). Create `src/extraction/<lang>-extractor.ts`:

```ts
import type { Edge, ExtractionError, ExtractionResult, Node, UnresolvedReference } from '../types.js';
import { getParser } from './grammars.js';
import { generateNodeId, getNodeText } from './tree-sitter-helpers.js';

export class FooExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
  }

  extract(): ExtractionResult {
    const startTime = Date.now();
    const parser = getParser('foo');
    if (!parser) {
      this.errors.push({ message: 'foo grammar not loaded', severity: 'error', code: 'grammar_unavailable' });
      return this.result(startTime);
    }
    const tree = parser.parse(this.source);
    if (!tree) { ... return this.result(startTime); }

    try {
      const fileNodeId = this.createFileNode();
      // Walk the AST, emit nodes via this.nodes.push and this.edges.push
      // Emit references via this.unresolvedReferences.push so the resolver
      // pass can match them across files.
      ...
      return this.result(startTime);
    } finally {
      tree.delete();   // ← important: tree-sitter trees back onto WASM memory
    }
  }

  private result(startTime: number): ExtractionResult {
    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }
}
```

Wire the dispatch via `customExtractor` in your `LanguageDef` (Section 3a):

```ts
// in src/extraction/languages/foo.ts
import { FooExtractor } from '../foo-extractor.js';
import type { LanguageDef } from './types.js';

export const FOO_DEF: LanguageDef = {
  name: 'foo',
  displayName: 'Foo',
  extensions: ['.foo'],
  includeGlobs: ['**/*.foo'],
  // For languages that need a tree-sitter parser AND a custom extractor
  // (HCL, SQL): set both `grammar` and `customExtractor`. The grammar
  // entry only registers the wasm so the parser is available; the
  // customExtractor takes the dispatch.
  grammar: { wasmFile: 'foo.wasm', extractor: { /* skeleton */ } },
  customExtractor: (filePath, source) => new FooExtractor(filePath, source).extract(),
};
```

The dispatch in `src/extraction/tree-sitter.ts` reads `customExtractor` off
the language def — no per-language `if` branches to maintain.

**Worked examples:**

- `src/extraction/hcl-extractor.ts` — Terraform / HCL. Block-based DDL. Each
  top-level block becomes a node whose qualified name matches the Terraform
  reference form (`var.X`, `local.X`, `module.X`, `aws_s3_bucket.foo`) so the
  resolver can match references across files automatically.
- `src/extraction/sql-extractor.ts` — SQL DDL. CREATE TABLE / VIEW / FUNCTION /
  TRIGGER / TYPE / SCHEMA → graph nodes; foreign keys, view source tables,
  trigger target tables and executed functions → edges.
- `src/extraction/liquid-extractor.ts` — Shopify Liquid templates. Regex-based
  (no tree-sitter) since the template grammar isn't useful for code intelligence.

---

## 5c. Path C — tags.scm fallback extractor

Path C is for when you want a language *indexed today* without writing (or
maintaining) an extractor. Most tree-sitter grammars ship a
`queries/tags.scm` — the ecosystem's standard code-navigation query, with
`@definition.{class,function,method,module,…}`, `@reference.call`, `@name`,
and sometimes `@doc` captures. `TagsQueryExtractor`
(`src/extraction/tags-query-extractor.ts`) runs that query and turns the
captures into cartograph `Node`s + `calls` references. **No per-language
extractor code.**

What you get: definitions (name + kind + location), `contains` nesting, and
call references. What you *don't* get: imports, typed signatures, or
cartograph's richer edges. A `tags.scm` is a strict subset of what a hand
extractor sees — a floor, not parity.

Steps:

1. **Vendor the query.** Flag the grammar's `build-grammar-wasm.ts` entry with
   `tagsScm: true`; the build script harvests `queries/tags.scm` from the
   grammar package into `src/extraction/tags/<lang>.scm` alongside the `.wasm`.
   `copy-assets` ships `src/extraction/tags/*.scm` into `dist/`.

2. **Register the language** (step 3) with BOTH `grammar` (so the `.wasm`
   loads) AND a `customExtractor` that dispatches `TagsQueryExtractor` —
   same shape as a Path B language, but the extractor is generic:

   ```ts
   grammar: { wasmFile: 'foo.wasm', extractor: { /* skeleton */ } },
   customExtractor: (filePath, source) =>
     new TagsQueryExtractor(filePath, source, 'foo').extract(),
   ```

3. **That's it.** `TagsQueryExtractor` maps `@definition.<kind>` suffixes onto
   `NodeKind` (`DEFINITION_KIND_MAP`); a suffix it doesn't know is skipped.

**Worked example:** `src/extraction/languages/elixir.ts` — the first language
onboarded this way. Its `tags.scm` (`src/extraction/tags/elixir.scm`) also
shows the `@ignore` convention: grammars suppress keyword pseudo-calls
(Elixir's `def` / `defmodule`) with a pattern that captures the keyword as
`@ignore`, and `TagsQueryExtractor` drops any definition / reference whose
`@name` node is an `@ignore` node.

---

## 6. Pick `NodeKind` and `EdgeKind` values

`NodeKind` and `EdgeKind` are fixed unions in `src/graph/core-types.ts`
re-exported by `src/types.ts`. Map your language's constructs onto the closest
existing kind rather than introducing new ones — adding a new kind is a
cross-cutting change that touches search, resolution, and context-building code.

Common mappings used by recent extractors:

| Language construct | NodeKind |
|---|---|
| Function / procedure / standalone routine | `function` |
| Method on a class | `method` |
| Class / type / table / declarative resource | `class` |
| Trait / mixin | `trait` |
| Interface / protocol | `interface` |
| Module / package / file-level scope / Terraform module | `module` |
| Namespace / schema / SQL schema / Terraform provider | `namespace` |
| Variable / Terraform variable | `variable` |
| Constant / Terraform local / R top-level binding | `constant` |
| Type alias / SQL composite type | `type_alias` |
| Enum (any) | `enum` |
| Import / library / source / require | `import` |
| Output / re-export / Terraform output | `export` |

Edges are usually one of:

| Edge | When |
|---|---|
| `contains` | Parent contains child (file → block, class → method) |
| `calls` | Function/method invokes another |
| `imports` | File pulls in another module/file |
| `references` | Generic mention of another symbol (FK, lookup, attribute access) |
| `extends` / `implements` | Inheritance relationships |

Emit references through `unresolvedReferences` (with `referenceName` set to a
qualified name that matches what you put on the target node's `qualifiedName`) —
the resolver pass matches them across files using the `name-matcher` and
`import-resolver` modules.

---

## 7. Tests

Tests live in `__tests__/extraction.test.ts`, grouped by language with a
`describe('<Language> Extraction', ...)` block. Use `extractFromSource` directly
for unit-style tests:

```ts
import { extractFromSource } from '../src/extraction';

describe('Foo Extraction', () => {
  describe('Language detection', () => {
    it('should detect Foo files', () => {
      expect(detectLanguage('main.foo')).toBe('foo');
    });
  });

  describe('Function extraction', () => {
    it('should extract a top-level function', () => {
      const code = `function add(a, b) a + b`;
      const result = extractFromSource('main.foo', code);
      const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'add');
      expect(fn).toBeDefined();
    });
  });
});
```

Cover the AST shapes you saw in the probe, especially the surprising ones. Pay
particular attention to:

- The smallest possible valid program (`expect(...).toBeDefined()` for the file node)
- Each node-kind mapping (one test per emitted kind)
- Reference forms (call edges, FK / cross-file references, imports)
- Anything you intentionally skipped (anonymous lambdas, dynamic imports, etc.)
  with a negative assertion so the omission is documented

Run the focused language guards first, then the fast suite:

```bash
bun test --timeout 30000 __tests__/language-coverage.test.ts __tests__/pr19-improvements.test.ts
bun run test:fast
```

End-to-end smoke test from a fresh fixture before opening the PR:

```bash
SMOKE=$(mktemp -d) && cat > "$SMOKE/main.foo" <<'EOF'
... realistic input ...
EOF
cd "$SMOKE" && git init -q
bun <repo>/src/bin/cartograph.ts admin init "$SMOKE"
bun <repo>/src/bin/cartograph.ts admin index "$SMOKE"
bun <repo>/src/bin/cartograph.ts status "$SMOKE"
bun <repo>/src/bin/cartograph.ts find "<symbol>" --by name
```

The `status` call should report your file under "Languages" with a non-zero
symbol count, and `find` should surface the symbols you expect at the right
line numbers.

### Add a test-bed fixture

Drop a representative program at `docs/test-beds/<lang>/fixture.<ext>`. The
always-on `__tests__/language-coverage.test.ts` parity-guard auto-discovers
it — no harness edit — and asserts a per-language extraction floor: the
fixture parses without a hard error and the extractor emits at least one real
symbol and one edge. This is the regression tripwire that catches a future
grammar bump or refactor silently zeroing your extractor's output. Keep the
fixture small but exercise the main constructs (a function, a call, a
variable; whatever the language's symbols are).

### Test-file detection

cartograph classifies test files by **convention, not by language** —
`src/path-class.ts` holds the patterns: `tests/` / `spec/` directories,
the `.test.<ext>` / `.spec.<ext>` infix, the `_test.<ext>` / `_spec.<ext>`
suffix, the `test_<name>` / `test-<name>` prefix, and the `<Name>Test`
CamelCase suffix. A new language that follows any of these — most do —
needs **no change**: its test files are picked up by the `is_test`
flag, dead-code exemption, and context ranking automatically. Only a
genuinely novel test-naming convention warrants a new pattern in
`TEST_PATTERNS` (grouped and commented there for exactly that).

---

## 8. Open the PR

Include in the PR description:

- The grammar source + version + license + sha256 (if vendored)
- A small worked example showing what gets extracted
- The full test plan (`bun run typecheck`, `bun run test:fast`,
  `bun run build`, CLI smoke)
- Any known limitations (constructs not supported, AST quirks, things the grammar
  itself can't parse)

Don't claim support for constructs the grammar can't actually parse — this happens
more often than you'd expect (e.g. `tree-sitter-sql` errors out on `CREATE
PROCEDURE` because procedure-body syntax varies sharply across dialects). Say what
works, say what doesn't, and let reviewers decide.

---

## Reference: existing extractors as templates

Read these in source order if your language is similar to one of them:

- **Procedural / OO:** `src/extraction/languages/python.ts` (small, easy to read),
  `ruby.ts` (with bare-call detection), `kotlin.ts` (extension functions),
  `r.ts` (no `def` keyword — uses `visitNode` hook for assignments)
- **Declarative / config:** `src/extraction/hcl-extractor.ts` (Terraform reference
  graph), `sql-extractor.ts` (DDL with FK / view source extraction)
- **Embedded / template:** `src/extraction/svelte-extractor.ts` and
  `src/extraction/vue-extractor.ts` (both delegate the `<script>` block
  to JS/TS tree-sitter with line-offset adjustment; the Vue variant
  also routes `lang="ts"` vs bare `<script>` to typescript vs javascript
  and filters Vue 3 compiler macros), `liquid-extractor.ts`
  (regex-based, no tree-sitter)
- **Form / non-tree-sitter:** `src/extraction/dfm-extractor.ts` (Delphi `.dfm`
  files; line-based regex parser cross-linked with Pascal symbols)

When in doubt, copy the extractor closest in shape to yours and modify from there.
