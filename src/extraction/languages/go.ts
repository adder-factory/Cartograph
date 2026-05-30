import { getNodeText, getChildByField } from '../tree-sitter-helpers.js';
import type { LanguageExtractor } from '../tree-sitter-types.js';

const goExtractor: LanguageExtractor = {
  functionTypes: ['function_declaration'],
  classTypes: [], // Go doesn't have classes
  methodTypes: ['method_declaration'],
  interfaceTypes: [], // Handled via type_spec → resolveTypeAliasKind
  structTypes: [], // Handled via type_spec → resolveTypeAliasKind
  enumTypes: [],
  typeAliasTypes: ['type_spec'], // Go type declarations
  importTypes: ['import_declaration'],
  callTypes: ['call_expression'],
  variableTypes: ['var_declaration', 'short_var_declaration', 'const_declaration'],
  // Go struct fields. Emitted via the universal class-like body walk
  // when the enclosing struct is on extractor.nodeStack — see
  // tsExtractField's Go-specific branch (the field_identifier path).
  fieldTypes: ['field_declaration'],
  methodsAreTopLevel: true,
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'result',
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    const result = getChildByField(node, 'result');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    if (result) {
      sig += ' ' + getNodeText(result, source);
    }
    return sig;
  },
  resolveTypeAliasKind: (node, _source) => {
    // Go type_spec: `type Foo struct { ... }` or `type Bar interface { ... }`
    // The inner type is in the 'type' field of the type_spec node
    const typeChild = getChildByField(node, 'type');
    if (!typeChild) return undefined;
    if (typeChild.type === 'struct_type') return 'struct';
    if (typeChild.type === 'interface_type') return 'interface';
    return undefined;
  },
  // Go exportedness is purely naming: identifiers whose first letter is
  // uppercase are package-exported. The Go spec (§"Exported identifiers")
  // makes this exact and unambiguous, with no `export`/`pub` keyword.
  // For methods, the strict spec also requires the receiver type to be
  // exported, but the name-only check matches what gocyclo / golangci-lint /
  // staticcheck use as a first-pass approximation and is a substantial
  // coverage improvement over the prior `?? false` default.
  isExported: (node, source) => {
    const nameChild = getChildByField(node, 'name');
    if (!nameChild) return false;
    const name = getNodeText(nameChild, source);
    return /^[A-Z]/.test(name);
  },
  getReceiverType: (node, source) => {
    // Go method_declaration has a "receiver" field: func (sl *scrapeLoop) run(...)
    // The receiver is a parameter_list containing a parameter_declaration
    // with a type that may be a pointer_type (*scrapeLoop) or plain type (scrapeLoop)
    const receiver = getChildByField(node, 'receiver');
    if (!receiver) return undefined;
    // Find the type identifier inside the receiver
    const text = getNodeText(receiver, source);
    // Extract type name from patterns like "(sl *Type)", "(sl Type)", "(*Type)", "(Type)"
    const match = text.match(/\*?\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/);
    return match?.[1];
  },
};

import type { LanguageDef } from './types.js';
export const GO_DEF: LanguageDef = {
  name: 'go',
  displayName: 'Go',
  extensions: ['.go'],
  includeGlobs: ['**/*.go'],
  grammar: { wasmFile: 'go.wasm', extractor: goExtractor },
};
