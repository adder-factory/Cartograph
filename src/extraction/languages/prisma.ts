/**
 * Prisma — custom extractor over the tree-sitter-prisma grammar.
 *
 * A `schema.prisma` file is a declarative schema (`model` / `type` /
 * `enum` blocks), with no functions or classes, so `PrismaExtractor`
 * handles it directly rather than via the universal extractor — the
 * same shape as SQL / HCL.
 */
import { PrismaExtractor } from '../prisma-extractor.js';
import type { LanguageDef } from './types.js';

export const PRISMA_DEF: LanguageDef = {
  name: 'prisma',
  displayName: 'Prisma',
  extensions: ['.prisma'],
  includeGlobs: ['**/*.prisma'],
  // The `grammar` entry only registers the wasm so the parser is
  // available to `PrismaExtractor`; the empty `extractor` satisfies the
  // type — `customExtractor` takes the dispatch (same as SQL).
  grammar: {
    wasmFile: 'prisma.wasm',
    extractor: {
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
  customExtractor: (filePath, source) => new PrismaExtractor(filePath, source).extract(),
};
