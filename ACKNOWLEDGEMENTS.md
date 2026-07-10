# Acknowledgements

Cartograph stands on a great deal of other people's work. This file credits the projects and authors whose code, grammars, and libraries make it possible. Cartograph is released under the MIT License; the licenses of the components below are noted alongside each.

## Origin project

Cartograph is a fork of **[codegraph](https://github.com/colbymchenry/codegraph)** by **Colby Mchenry**, used under the MIT License (Copyright (c) 2026 Colby Mchenry). Cartograph has diverged substantially from upstream but derives from that codebase, and we gratefully acknowledge it as the foundation.

Recent Cartograph improvements have also been informed by public Codegraph issues
and pull requests covering Python package-member calls, Go receiver ownership,
C# primary constructors, PHP include/require imports, chained receiver calls,
additional MCP client targets, Salesforce stack support, Kotlin property/import
disambiguation, embedded repository indexing, MCP resource/prompt probes,
installer auto-allow permissions, aggregate session usage, and quieter daemon
attachment, SAP XSJS import support, Hono route extraction, and Spring
`@ConditionalOnProperty` config-key linkage, MyBatis `SqlSessionTemplate`
statement-id linkage, file-scoped symbol listing, file-scoped dependency
queries, generic supertype normalization for inheritance edges, `.ignore`
indexing overrides for gitignored local source, binary/invalid ignore-file
resilience, OpenTofu `.tofu` detection, GLSL shader indexing,
Groovy/Solidity indexing, ArkTS/CUDA indexing, HLSL shader indexing, Nix
expression indexing, Clojure/ClojureScript indexing, Common Lisp indexing,
CodeWhale installer targeting, TypeScript generic string-literal contract
symbols, non-ASCII context-query keyword extraction, context lookup from
code-like source strings, CodeBuddy/Pi MCP target evaluation, ABAP/abapGit,
VB.NET, Astro, and Lean language support, Angular/Flutter/Symfony/NeuG
framework/resource extraction, and heuristic dynamic-dispatch synthesis. Those
ideas, along with PowerShell CLI completion support, were reimplemented inside
Cartograph's current feature-slice
architecture; CodeIgniter 3 routing and magic model/library property support was
likewise implemented as a native Cartograph resolver. No upstream patch code was
copied blindly. Public
Codegraph issue #602 specifically informed the git-hook freshness workflow;
Cartograph's implementation uses managed hook blocks, Git hook-path resolution,
idempotent installs, and managed-block removal rather than overwriting hooks.

## tree-sitter

Code parsing is built entirely on **[tree-sitter](https://tree-sitter.github.io/tree-sitter/)** by **Max Brunsfeld** and contributors (MIT). Specifically:

- **[web-tree-sitter](https://github.com/tree-sitter/tree-sitter)** (MIT) — the WebAssembly build of the tree-sitter runtime that loads and runs every grammar below.
- **[tree-sitter-cli](https://github.com/tree-sitter/tree-sitter)** (MIT) — used to compile the bundled `.wasm` grammars.

## Bundled tree-sitter grammars

Cartograph ships pre-compiled WebAssembly grammars under `src/extraction/wasm/`, each built from an upstream tree-sitter grammar. We thank every grammar's authors and maintainers:

| Grammar (.wasm) | Upstream project | License |
|---|---|---|
| typescript, tsx | [tree-sitter/tree-sitter-typescript](https://github.com/tree-sitter/tree-sitter-typescript) | MIT |
| abap | [mkoval1/tree-sitter-abap](https://github.com/mkoval1/tree-sitter-abap) | ISC |
| arkts | [harmony-contrib/tree-sitter-arkts](https://github.com/harmony-contrib/tree-sitter-arkts) | MIT |
| astro | [virchau13/tree-sitter-astro](https://github.com/virchau13/tree-sitter-astro) | MIT |
| javascript (also serves jsx) | [tree-sitter/tree-sitter-javascript](https://github.com/tree-sitter/tree-sitter-javascript) | MIT |
| python | [tree-sitter/tree-sitter-python](https://github.com/tree-sitter/tree-sitter-python) | MIT |
| go | [tree-sitter/tree-sitter-go](https://github.com/tree-sitter/tree-sitter-go) | MIT |
| rust | [tree-sitter/tree-sitter-rust](https://github.com/tree-sitter/tree-sitter-rust) | MIT |
| java | [tree-sitter/tree-sitter-java](https://github.com/tree-sitter/tree-sitter-java) | MIT |
| c | [tree-sitter/tree-sitter-c](https://github.com/tree-sitter/tree-sitter-c) | MIT |
| clojure | [oakmac/tree-sitter-clojure](https://github.com/oakmac/tree-sitter-clojure) | MIT |
| common_lisp | [theHamsta/tree-sitter-commonlisp](https://github.com/theHamsta/tree-sitter-commonlisp) | MIT |
| cpp | [tree-sitter/tree-sitter-cpp](https://github.com/tree-sitter/tree-sitter-cpp) | MIT |
| css | [tree-sitter/tree-sitter-css](https://github.com/tree-sitter/tree-sitter-css) | MIT |
| cuda | [tree-sitter-grammars/tree-sitter-cuda](https://github.com/tree-sitter-grammars/tree-sitter-cuda) | MIT |
| c_sharp | [tree-sitter/tree-sitter-c-sharp](https://github.com/tree-sitter/tree-sitter-c-sharp) | MIT |
| embedded_template | [tree-sitter/tree-sitter-embedded-template](https://github.com/tree-sitter/tree-sitter-embedded-template) | MIT |
| ruby | [tree-sitter/tree-sitter-ruby](https://github.com/tree-sitter/tree-sitter-ruby) | MIT |
| bash (also serves zsh) | [tree-sitter/tree-sitter-bash](https://github.com/tree-sitter/tree-sitter-bash) | MIT |
| php | [tree-sitter/tree-sitter-php](https://github.com/tree-sitter/tree-sitter-php) | MIT |
| apex | [aheber/tree-sitter-sfapex](https://github.com/aheber/tree-sitter-sfapex) | MIT |
| haskell | [tree-sitter/tree-sitter-haskell](https://github.com/tree-sitter/tree-sitter-haskell) | MIT |
| html | [tree-sitter/tree-sitter-html](https://github.com/tree-sitter/tree-sitter-html) | MIT |
| jsdoc | [tree-sitter/tree-sitter-jsdoc](https://github.com/tree-sitter/tree-sitter-jsdoc) | MIT |
| json | [tree-sitter/tree-sitter-json](https://github.com/tree-sitter/tree-sitter-json) | MIT |
| julia | [tree-sitter/tree-sitter-julia](https://github.com/tree-sitter/tree-sitter-julia) | MIT |
| kotlin | [fwcd/tree-sitter-kotlin](https://github.com/fwcd/tree-sitter-kotlin) | MIT |
| lean | [Julian/tree-sitter-lean](https://github.com/Julian/tree-sitter-lean) | MIT |
| luau | [tree-sitter-grammars/tree-sitter-luau](https://github.com/tree-sitter-grammars/tree-sitter-luau) | MIT |
| scala | [tree-sitter/tree-sitter-scala](https://github.com/tree-sitter/tree-sitter-scala) | MIT |
| swift | [alex-pinkus/tree-sitter-swift](https://github.com/alex-pinkus/tree-sitter-swift) | MIT |
| objc | [jiyee/tree-sitter-objc](https://github.com/jiyee/tree-sitter-objc) | MIT |
| ocaml, ocaml_interface | [tree-sitter/tree-sitter-ocaml](https://github.com/tree-sitter/tree-sitter-ocaml) | MIT |
| hcl | [tree-sitter-grammars/tree-sitter-hcl](https://github.com/tree-sitter-grammars/tree-sitter-hcl) | Apache-2.0 |
| lua | [tree-sitter-grammars/tree-sitter-lua](https://github.com/tree-sitter-grammars/tree-sitter-lua) | MIT |
| sql | [DerekStride/tree-sitter-sql](https://github.com/DerekStride/tree-sitter-sql) | MIT |
| r | [r-lib/tree-sitter-r](https://github.com/r-lib/tree-sitter-r) | MIT |
| prisma | [victorhqc/tree-sitter-prisma](https://github.com/victorhqc/tree-sitter-prisma) | MIT |
| dart | [UserNobody14/tree-sitter-dart](https://github.com/UserNobody14/tree-sitter-dart) | MIT |
| fish | [esdmr/tree-sitter-fish](https://github.com/esdmr/tree-sitter-fish) | MIT |
| glsl | [theHamsta/tree-sitter-glsl](https://github.com/theHamsta/tree-sitter-glsl) | MIT |
| hlsl | [tree-sitter-grammars/tree-sitter-hlsl](https://github.com/tree-sitter-grammars/tree-sitter-hlsl) | MIT |
| groovy | [amaanq/tree-sitter-groovy](https://github.com/amaanq/tree-sitter-groovy) | MIT |
| graphql | [bkegley/tree-sitter-graphql](https://github.com/bkegley/tree-sitter-graphql) | MIT |
| nix | [nix-community/tree-sitter-nix](https://github.com/nix-community/tree-sitter-nix) | MIT |
| pascal | [Isopod/tree-sitter-pascal](https://github.com/Isopod/tree-sitter-pascal) | MIT |
| regex | [tree-sitter/tree-sitter-regex](https://github.com/tree-sitter/tree-sitter-regex) | MIT |
| rescript | [rescript-lang/tree-sitter-rescript](https://github.com/rescript-lang/tree-sitter-rescript) | MIT |
| elixir | [elixir-lang/tree-sitter-elixir](https://github.com/elixir-lang/tree-sitter-elixir) | Apache-2.0 |
| yaml | [tree-sitter-grammars/tree-sitter-yaml](https://github.com/tree-sitter-grammars/tree-sitter-yaml) | MIT |
| solidity | tree-sitter-solidity by Joran Honig | MIT |
| verilog | [tree-sitter/tree-sitter-verilog](https://github.com/tree-sitter/tree-sitter-verilog) | MIT |
| vbnet | [CodeAnt-AI/tree-sitter-vb-dotnet](https://github.com/CodeAnt-AI/tree-sitter-vb-dotnet) | MIT |

Each compiled `.wasm` carries the license of its originating grammar (MIT except `hcl` and `elixir`, which are Apache-2.0, and `abap`, which is ISC). Grammar attributions are derived from `scripts/build-grammar-wasm.ts`; if a project has moved or a license has changed, please open an issue and we'll correct the credit.

Additionally, `src/extraction/tags/elixir.scm` is vendored verbatim from **tree-sitter-elixir**'s `queries/tags.scm` (Apache-2.0).

## Runtime dependencies

| Package | Author / Org | License | Used for |
|---|---|---|---|
| [zod](https://github.com/colinhacks/zod) | Colin McDonnell | MIT | Runtime validation at every external boundary (MCP tool input, config, LLM output, SQL I/O, CLI args). |
| [commander](https://github.com/tj/commander.js) | TJ Holowaychuk & contributors | MIT | CLI argument parsing and command tree. |
| [@clack/prompts](https://github.com/bombshell-dev/clack) | Nate Moore | MIT | Interactive terminal prompts for the installer wizard. |
| [@parcel/watcher](https://github.com/parcel-bundler/watcher) | Devon Govett / Parcel | MIT | Native filesystem watcher for incremental re-indexing. |
| [openai](https://github.com/openai/openai-node) | OpenAI | Apache-2.0 | SDK for OpenAI-compatible local LLM backends (chat / embed / summarize tiers). |
| [re2-wasm](https://github.com/uwx/re2-wasm) | Google (RE2), WASM packaging by contributors | BSD-3-Clause | Linear-time RE2 regex engine (no catastrophic backtracking). |
| [web-tree-sitter](https://github.com/tree-sitter/tree-sitter) | tree-sitter project | MIT | WASM tree-sitter runtime (see above). |

**Optional dependencies** (vector search; loaded when present):

| Package | Author / Org | License | Used for |
|---|---|---|---|
| [sqlite-vec](https://github.com/asg017/sqlite-vec) | Alex Garcia | MIT / Apache-2.0 | SQLite vec0 vector-search extension for embedding KNN. |
| [usearch](https://github.com/unum-cloud/usearch) | Ash Vardanian / Unum | Apache-2.0 | HNSW vector index (NAPI prebuilt) for similarity queries. |

## Runtime platform

- **[Bun](https://bun.sh)** by **Oven** (Jarred Sumner & contributors), MIT — the required runtime (Bun >= 1.3). Cartograph uses Bun's built-in `bun:sqlite` database engine and `bun:ffi`.

## Build & development tools

| Tool | Author / Org | License | Used for |
|---|---|---|---|
| [TypeScript](https://github.com/microsoft/TypeScript) | Microsoft | Apache-2.0 | Type system and production build compiler. |
| [@typescript/native-preview (tsgo)](https://github.com/microsoft/typescript-go) | Microsoft | Apache-2.0 | Fast typechecking in the inner dev loop. |
| [Biome](https://github.com/biomejs/biome) | Biome contributors | MIT / Apache-2.0 | Linting and formatting (CI gate). |
| [tree-sitter-cli](https://github.com/tree-sitter/tree-sitter) | tree-sitter project | MIT | Compiling the bundled grammar `.wasm` files. |

## Optional viewer

The optional graph viewer (`src/features/viewer/static/index.html`) bundles the following pinned browser libraries into the self-hosted `viewer.vendor.app`; their full MIT notices ship beside it in `viewer.vendor.LICENSES.txt`:

- [Cytoscape.js](https://github.com/cytoscape/cytoscape.js), [cytoscape-fcose](https://github.com/iVis-at-Bilkent/cytoscape.js-fcose), [cose-base](https://github.com/iVis-at-Bilkent/cose-base), [layout-base](https://github.com/iVis-at-Bilkent/layout-base) — Max Franz / i-Vis Lab, MIT — graph rendering and layout.
- [Prism.js](https://github.com/PrismJS/prism) — Lea Verou & contributors, MIT — source-code syntax highlighting.

---

This list is maintained on a best-effort basis. If your work is used by Cartograph and is missing, miscredited, or mislicensed here, please open an issue or pull request — we want to credit you correctly.
