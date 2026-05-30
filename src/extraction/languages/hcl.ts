/**
 * HCL / Terraform — custom extractor that runs on top of the
 * tree-sitter-hcl grammar. The block-shape of HCL doesn't fit
 * the universal function/class extractor, so HclExtractor handles it
 * directly.
 */
import { HclExtractor } from '../hcl-extractor.js';
import type { LanguageDef } from './types.js';

export const HCL_DEF: LanguageDef = {
  name: 'hcl',
  displayName: 'HCL / Terraform',
  extensions: ['.tf', '.tfvars', '.hcl'],
  includeGlobs: ['**/*.tf', '**/*.tfvars', '**/*.hcl'],
  // HCL needs both a tree-sitter parser AND a custom extractor — the
  // parse tree is standard but the extraction logic is bespoke.
  grammar: {
    wasmFile: 'hcl.wasm',
    extractor: {
      // Universal extractor is unused (custom path takes over) but
      // the type requires it; supply a no-op skeleton.
      functionTypes: [],
      classTypes: [],
      methodTypes: [],
      interfaceTypes: [],
      structTypes: [],
      enumTypes: [],
      typeAliasTypes: [],
      importTypes: [],
      callTypes: [],
      variableTypes: [],
      nameField: 'name',
      bodyField: 'body',
      paramsField: 'parameters',
    },
  },
  customExtractor: (filePath, source) => new HclExtractor(filePath, source).extract(),
};
