import type { Language } from '../types.js';

/**
 * Mirrors the `Language` union in src/types.ts. The `satisfies`
 * clause rejects typos (a non-Language string fails to compile), and
 * the `_LanguageCoverageOk` line below forces tsc to flag any
 * Language member that is missing from this array — so adding a new
 * language to the union without appending it here breaks the build
 * instead of silently rejecting valid configs at runtime.
 */
export const VALID_LANGUAGES = [
  'abap',
  'apex',
  'arkts',
  'astro',
  'aura',
  'bg3_anubis',
  'bg3_resource',
  'bg3_stats',
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'python',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'csharp',
  'cuda',
  'css',
  'php',
  'ruby',
  'swift',
  'kotlin',
  'lean',
  'dart',
  'embedded_template',
  'svelte',
  'vue',
  'liquid',
  'haskell',
  'html',
  'jsdoc',
  'json',
  'jupyter',
  'julia',
  'khn',
  'lua',
  'luau',
  'objc',
  'ocaml',
  'ocaml_interface',
  'osiris',
  'pascal',
  'hcl',
  'r',
  'regex',
  'sql',
  'scala',
  'rescript',
  'elixir',
  'bash',
  'zsh',
  'fish',
  'fsharp',
  'clojure',
  'common_lisp',
  'glsl',
  'hlsl',
  'nix',
  'graphql',
  'groovy',
  'prisma',
  'properties',
  'powershell',
  'solidity',
  'vb6',
  'vbnet',
  'verilog',
  'visualforce',
  'xml',
  'yaml',
  'unknown',
] as const satisfies readonly Language[];

// Compile-time guard: if a new Language member is added to the union
// and forgotten here, `Missing` becomes that member's literal type
// (not `never`), and the `true` literal stops being assignable.
type _LanguageCoverageOk<Missing = Exclude<Language, (typeof VALID_LANGUAGES)[number]>> = [Missing] extends [never]
  ? true
  : never;

function assertLanguageCoverage(value: _LanguageCoverageOk): true {
  return value;
}
assertLanguageCoverage(true);
