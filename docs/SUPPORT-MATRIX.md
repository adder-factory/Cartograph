# Support Matrix

Cartograph supports 48 language modes. The registry is the source of truth:
language definitions live in `src/extraction/languages/registry.ts`, and
framework resolvers live in `src/resolution/frameworks/index.ts`.

Use this page to decide whether Cartograph can extract useful graph structure
from a project before you install it. A supported language means files are
recognized and indexed. Framework-aware signals add routes, entry points,
dynamic references, or cross-language bridge edges when Cartograph detects a
known framework shape.

`Tree-sitter parser-only` means Cartograph recognizes the file, parses it with
the vendored grammar, emits the file node, and surfaces syntax diagnostics, but
does not yet extract language-specific symbols from that grammar.

## Languages

| Language mode | Extensions / scope | Extractor path |
|---|---|---|
| Bash | `.sh`, `.bash` | Tree-sitter |
| C | `.c`, `.h` | Tree-sitter |
| C++ | `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hxx` | Tree-sitter |
| C# | `.cs` | Tree-sitter |
| CSS | `.css` | Tree-sitter parser-only |
| Dart | `.dart` | Tree-sitter |
| Elixir | `.ex`, `.exs` | Tree-sitter |
| ERB / EJS | `.erb`, `.ejs`, `.eta`, `.etlua` | Tree-sitter parser-only |
| Fish | `.fish` | Tree-sitter |
| Go | `.go` | Tree-sitter |
| GraphQL | `.graphql`, `.gql` | Tree-sitter |
| Haskell | `.hs` | Tree-sitter tags query |
| HCL / Terraform | `.tf`, `.tfvars`, `.hcl` | Tree-sitter |
| HTML | `.html`, `.htm` | Tree-sitter parser-only |
| Java | `.java` | Tree-sitter |
| JavaScript | `.js`, `.mjs`, `.cjs` | Tree-sitter |
| JSDoc | `.jsdoc` | Tree-sitter parser-only |
| JSON | `.json` | Tree-sitter parser-only |
| JSX | `.jsx` | Tree-sitter |
| Julia | `.jl` | Tree-sitter tags query |
| Kotlin | `.kt`, `.kts` | Tree-sitter |
| Liquid | `.liquid` | Custom extractor |
| Lua | `.lua` | Tree-sitter |
| Luau | `.luau` | Tree-sitter |
| Objective-C | `.m`, `.mm` | Tree-sitter |
| OCaml | `.ml` | Tree-sitter tags query |
| OCaml Interface | `.mli` | Tree-sitter tags query |
| Pascal / Delphi | `.pas`, `.dpr`, `.dpk`, `.lpr`, `.dfm`, `.fmx` | Tree-sitter plus form-file extractor |
| PHP | `.php`, `.module`, `.install`, `.theme`, `.inc` | Tree-sitter |
| Prisma | `.prisma` | Tree-sitter |
| Java Properties | `.properties` | Custom extractor |
| Python | `.py`, `.pyw` | Tree-sitter |
| R | `.r` | Tree-sitter |
| Regex | `.regex`, `.regexp` | Tree-sitter parser-only |
| ReScript | `.res`, `.resi` | Tree-sitter |
| Ruby | `.rb`, `.rake` | Tree-sitter |
| Rust | `.rs` | Tree-sitter |
| Scala | `.scala`, `.sc` | Tree-sitter |
| SQL | `.sql`, `.ddl`, `.dml` | Tree-sitter |
| Svelte | `.svelte` | Custom extractor |
| Swift | `.swift` | Tree-sitter |
| TSX | `.tsx` | Tree-sitter |
| TypeScript | `.ts`, `.mts`, `.cts` | Tree-sitter |
| Verilog / SystemVerilog | `.v`, `.vh`, `.sv`, `.svh` | Tree-sitter tags query |
| Vue | `.vue` | Custom extractor |
| XML (MyBatis) | `.xml` | Custom extractor |
| YAML | `.yml`, `.yaml` | Tree-sitter |
| Zsh | `.zsh`, `.zshrc`, `.zshenv`, `.zprofile`, `.zlogin` | Tree-sitter |

Special cases:

- Play Framework route files at `conf/routes` and `conf/*.routes` are treated
  as YAML so route declarations can be extracted.
- Objective-C header files are detected by content so `.h` can resolve to C,
  C++, or Objective-C.
- Liquid can also be detected from YAML front matter in `.html` / `.md` files
  under Jekyll convention directories such as `_layouts`, `_includes`,
  `_posts`, and `_drafts`.
- C# primary constructors are extracted as constructor-shaped method nodes, and
  C# generic/qualified type references are mined from type positions.
- Go receiver methods are associated with same-package structs even when the
  struct and methods live in different files, so implementation and owner edges
  are available after the post-index hooks run.
- PHP `include`, `include_once`, `require`, and `require_once` statements emit
  file import edges when they use string-literal paths.
- Python `from pkg import module` calls can resolve through the imported module
  to top-level members in `pkg/module.py`.
- Chained member calls can resolve through an intermediate method return type
  when Cartograph has a signature such as `build(): Committer` or
  `Committer build()`.

## Framework-Aware Signals

| Ecosystem | Signals |
|---|---|
| JavaScript / TypeScript | Express routes, Bun.serve routes, React components, Vue/Nuxt aliases/routes, SvelteKit routes, Commander/Yargs/CAC CLI commands |
| Python | Django, Flask, and FastAPI route/controller patterns |
| PHP | Laravel facades/routes and Drupal routes, services, hooks, plugins, and service tags |
| Ruby | Rails routes and controller conventions |
| JVM | Spring route/config references, Play routes, MyBatis Java/XML bindings, Kotlin/Scala source extraction |
| Go | Gin, Echo, Chi, net/http, Cobra commands, interface implementation edges |
| Rust | Framework and route patterns recognized by the Rust resolver |
| C# | ASP.NET route/controller patterns |
| Swift / Apple | SwiftUI, UIKit, Vapor, Swift/Objective-C bridge edges |
| React Native / Expo | Legacy bridge, TurboModules, Expo Modules, Fabric/Paper view components and native implementation edges |

Framework resolvers run only when the project looks like it uses that
framework, so generic codebases do not pay the full resolver cost.

## Embedded DSLs And Derived Signals

| Signal | What gets added |
|---|---|
| Zod / Pydantic | Schema nodes, fields, and enum-like members |
| GraphQL SDL | Types, fields, enums, interfaces, and references |
| Prisma / SQL | Models, tables, views, functions, triggers, schemas, and table references |
| Env/config refs | Env-var, config-key, feature-flag, and build-context reference edges |
| Dynamic imports | String import and dynamic import edges |
| Re-exports | Barrel-file and re-export edges |
| Tests | Import-based test edges and test-name signals |
| Coverage | LCOV joins to file and symbol records |
| History | Churn, issue attribution, co-change, and hotspot signals |
| Code Health | Biomarker findings such as complexity, long methods, duplicate code, risky security patterns, and incomplete markers |

## Extending Support

To add a language, start with [Adding A Language](ADDING-A-LANGUAGE.md).

## Tree-sitter Catalog Notes

Tree-sitter's homepage lists a smaller upstream parser set, while its wiki
tracks a much larger community parser catalog. Cartograph vendors grammars
deliberately rather than downloading every community parser at runtime, so the
support matrix above is the authoritative shipped set.

Agda remains the known upstream-parser gap for the current `web-tree-sitter`
runtime: `tree-sitter build --wasm` fails because the package's external
scanner symbols are not available to Wasm parsers. Support should wait for a
WASM-compatible upstream artifact or a compatible scanner implementation.
