/**
 * Language registry — central import + collection of every per-language
 * `LanguageDef`. Adding a new language is:
 *
 *   1. Create `src/extraction/languages/<name>.ts` exporting an
 *      `<NAME>_DEF: LanguageDef` constant.
 *   2. Add **one** import line and **one** array entry to this file.
 *
 * **That is the complete change list.** All consumers
 * (`grammars.ts`, `tree-sitter.ts`'s extractor lookup,
 * `default-config.ts`'s include globs, the legacy `EXTRACTORS`
 * barrel in `./index.ts`) all read from this registry — there is
 * no parallel list to keep in sync.
 *
 * This file is the only place a "central list" of languages lives,
 * so adjacent-line conflicts between PRs adding different languages
 * are limited to whichever alphabetical neighborhood they target.
 *
 * Note: an earlier draft used `fs.readdirSync` auto-discovery which
 * eliminated even this file, but `require()` of extensionless paths
 * doesn't work under a bare ESM loader without explicit extensions. A
 * generated-barrel build step would restore zero-list-edits and is
 * tracked as a follow-up.
 */

import type { LanguageDef } from './types.js';

// =====================================================================
// Imports — one per language, alphabetical by name
// =====================================================================
import { ABAP_DEF } from './abap.js';
import { APEX_DEF } from './apex.js';
import { ARKTS_DEF } from './arkts.js';
import { ASTRO_DEF } from './astro.js';
import { AURA_DEF } from './aura.js';
import { BASH_DEF } from './bash.js';
import { BG3_ANUBIS_DEF, BG3_RESOURCE_DEF, BG3_STATS_DEF, KHN_DEF, OSIRIS_DEF } from './bg3.js';
import { C_DEF, CPP_DEF, CUDA_DEF } from './c-cpp.js';
import { CLOJURE_DEF } from './clojure.js';
import { COMMON_LISP_DEF } from './common-lisp.js';
import { CSHARP_DEF } from './csharp.js';
import { CSS_DEF } from './css.js';
import { DART_DEF } from './dart.js';
import { ELIXIR_DEF } from './elixir.js';
import { EMBEDDED_TEMPLATE_DEF } from './embedded-template.js';
import { FISH_DEF } from './fish.js';
import { GLSL_DEF } from './glsl.js';
import { GO_DEF } from './go.js';
import { GRAPHQL_DEF } from './graphql.js';
import { GROOVY_DEF } from './groovy.js';
import { HASKELL_DEF } from './haskell.js';
import { HCL_DEF } from './hcl.js';
import { HLSL_DEF } from './hlsl.js';
import { HTML_DEF } from './html.js';
import { JAVA_DEF } from './java.js';
import { JAVASCRIPT_DEF } from './javascript.js';
import { JSDOC_DEF } from './jsdoc.js';
import { JSON_DEF } from './json.js';
import { JUPYTER_DEF } from './jupyter.js';
import { JSX_DEF } from './jsx.js';
import { JULIA_DEF } from './julia.js';
import { KOTLIN_DEF } from './kotlin.js';
import { LEAN_DEF } from './lean.js';
import { LIQUID_DEF } from './liquid.js';
import { LUA_DEF } from './lua.js';
import { LUAU_DEF } from './luau.js';
import { NIX_DEF } from './nix.js';
import { OBJC_DEF } from './objc.js';
import { OCAML_DEF } from './ocaml.js';
import { OCAML_INTERFACE_DEF } from './ocaml-interface.js';
import { PASCAL_DEF } from './pascal.js';
import { PHP_DEF } from './php.js';
import { PRISMA_DEF } from './prisma.js';
import { PROPERTIES_DEF } from './properties.js';
import { PYTHON_DEF } from './python.js';
import { R_DEF } from './r.js';
import { REGEX_DEF } from './regex.js';
import { RESCRIPT_DEF } from './rescript.js';
import { RUBY_DEF } from './ruby.js';
import { RUST_DEF } from './rust.js';
import { SCALA_DEF } from './scala.js';
import { SQL_DEF } from './sql.js';
import { SOLIDITY_DEF } from './solidity.js';
import { SVELTE_DEF } from './svelte.js';
import { SWIFT_DEF } from './swift.js';
import { TSX_DEF } from './tsx.js';
import { TYPESCRIPT_DEF } from './typescript.js';
import { VBNET_DEF } from './vbnet.js';
import { VERILOG_DEF } from './verilog.js';
import { VISUALFORCE_DEF } from './visualforce.js';
import { VUE_DEF } from './vue.js';
import { XML_DEF } from './xml.js';
import { YAML_DEF } from './yaml.js';
import { ZSH_DEF } from './zsh.js';

// =====================================================================
// Registry — alphabetical by name
// =====================================================================
const ALL_DEFS: readonly LanguageDef[] = [
  ABAP_DEF,
  APEX_DEF,
  ARKTS_DEF,
  ASTRO_DEF,
  AURA_DEF,
  BASH_DEF,
  BG3_ANUBIS_DEF,
  BG3_RESOURCE_DEF,
  BG3_STATS_DEF,
  C_DEF,
  CLOJURE_DEF,
  COMMON_LISP_DEF,
  CPP_DEF,
  CSHARP_DEF,
  CUDA_DEF,
  CSS_DEF,
  DART_DEF,
  ELIXIR_DEF,
  EMBEDDED_TEMPLATE_DEF,
  FISH_DEF,
  GLSL_DEF,
  GO_DEF,
  GRAPHQL_DEF,
  GROOVY_DEF,
  HASKELL_DEF,
  HCL_DEF,
  HLSL_DEF,
  HTML_DEF,
  JAVA_DEF,
  JAVASCRIPT_DEF,
  JSDOC_DEF,
  JSON_DEF,
  JUPYTER_DEF,
  JSX_DEF,
  JULIA_DEF,
  KHN_DEF,
  KOTLIN_DEF,
  LEAN_DEF,
  LIQUID_DEF,
  LUA_DEF,
  LUAU_DEF,
  NIX_DEF,
  OBJC_DEF,
  OCAML_DEF,
  OCAML_INTERFACE_DEF,
  OSIRIS_DEF,
  PASCAL_DEF,
  PHP_DEF,
  PRISMA_DEF,
  PROPERTIES_DEF,
  PYTHON_DEF,
  R_DEF,
  REGEX_DEF,
  RESCRIPT_DEF,
  RUBY_DEF,
  RUST_DEF,
  SCALA_DEF,
  SQL_DEF,
  SOLIDITY_DEF,
  SVELTE_DEF,
  SWIFT_DEF,
  TSX_DEF,
  TYPESCRIPT_DEF,
  VBNET_DEF,
  VERILOG_DEF,
  VISUALFORCE_DEF,
  VUE_DEF,
  XML_DEF,
  YAML_DEF,
  ZSH_DEF,
];

let byName: Map<string, LanguageDef> | null = null;
let byExtension: Map<string, LanguageDef> | null = null;

function ensureIndexes(): void {
  if (byName && byExtension) return;
  byName = new Map();
  byExtension = new Map();
  for (const def of ALL_DEFS) {
    byName.set(def.name, def);
    for (const ext of def.extensions) {
      byExtension.set(ext.toLowerCase(), def);
    }
  }
}

export function getLanguageDefs(): readonly LanguageDef[] {
  return ALL_DEFS;
}

export function getLanguageDefByName(name: string): LanguageDef | undefined {
  ensureIndexes();
  return byName!.get(name);
}

export function getLanguageDefByExtension(ext: string): LanguageDef | undefined {
  ensureIndexes();
  return byExtension!.get(ext.toLowerCase());
}
