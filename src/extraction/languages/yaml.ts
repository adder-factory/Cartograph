/**
 * YAML — file-level tracking + grammar-loaded.
 *
 * Added F#62 (2026-05-26) primarily to give the Drupal framework
 * resolver something to dispatch on. Drupal's `*.routing.yml` files
 * carry cross-file references to PHP handler classes/methods
 * (`_controller: '\Drupal\…\Foo::bar'`), so the resolver needs YAML
 * to be a recognised language whose files flow through the framework-
 * extractor pass — AND the resolver needs the tree-sitter-yaml
 * grammar pre-loaded so it can walk the AST instead of re-implementing
 * a YAML parser.
 *
 * No tree-sitter-driven symbol extraction here — YAML has no
 * functions / classes / etc. that match this fork's NodeKind set.
 * The `yamlExtractor` object below is minimal (empty `*Types` lists +
 * empty field-name strings) so the default `TreeSitterExtractor`
 * walks the AST but emits nothing. The Drupal framework resolver
 * re-parses routing.yml via `getParser('yaml')` inside its
 * `extract()` hook to walk the routing-specific shape.
 *
 * The grammar is vendored from the npm package
 * `@tree-sitter-grammars/tree-sitter-yaml@0.7.1` (ships a pre-built
 * 189KB ABI-14 compatible `tree-sitter-yaml.wasm`). No emcc needed.
 */
import type { LanguageDef } from './types.js';
import type { LanguageExtractor } from '../tree-sitter-types.js';

// Empty extractor — the default tree-sitter walk runs but every type
// list is empty, so nothing is created. The Drupal resolver does the
// real walking on its own AST.
const yamlExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  enumMemberTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: [],
  variableTypes: [],
  propertyTypes: [],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
};

export const YAML_DEF: LanguageDef = {
  name: 'yaml',
  displayName: 'YAML',
  extensions: ['.yml', '.yaml'],
  includeGlobs: ['**/*.yml', '**/*.yaml'],
  grammar: { wasmFile: 'yaml.wasm', extractor: yamlExtractor },
};
