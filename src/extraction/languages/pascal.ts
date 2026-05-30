import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers.js';
import type { LanguageExtractor } from '../tree-sitter-types.js';

const pascalExtractor: LanguageExtractor = {
  functionTypes: ['declProc'],
  classTypes: ['declClass'],
  methodTypes: ['declProc'],
  interfaceTypes: ['declIntf'],
  structTypes: [],
  enumTypes: ['declEnum'],
  typeAliasTypes: ['declType'],
  importTypes: ['declUses'],
  callTypes: ['exprCall'],
  variableTypes: ['declField', 'declConst'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'args',
  returnField: 'type',
  getSignature: (node, source) => {
    const args = getChildByField(node, 'args');
    const returnType = node.namedChildren.find((c: SyntaxNode) => c.type === 'typeref');
    if (!args && !returnType) return undefined;
    let sig = '';
    if (args) sig = getNodeText(args, source);
    if (returnType) {
      sig += ': ' + getNodeText(returnType, source);
    }
    return sig || undefined;
  },
  getVisibility: (node) => {
    let current = node.parent;
    while (current) {
      if (current.type === 'declSection') {
        for (const child of current.children) {
          if (child?.type === 'kPublic' || child?.type === 'kPublished') return 'public';
          if (child?.type === 'kPrivate') return 'private';
          if (child?.type === 'kProtected') return 'protected';
        }
      }
      current = current.parent;
    }
    return undefined;
  },
  isExported: (_node, _source) => {
    // In Pascal, symbols declared in the interface section are exported
    return false;
  },
  isStatic: (node) => {
    for (const child of node.children) {
      if (child?.type === 'kClass') return true;
    }
    return false;
  },
  isConst: (node) => {
    return node.type === 'declConst';
  },
};

import type { LanguageDef } from './types.js';
import { DfmExtractor } from '../dfm-extractor.js';

const dfmCustomExtractor = (filePath: string, source: string) => new DfmExtractor(filePath, source).extract();

export const PASCAL_DEF: LanguageDef = {
  name: 'pascal',
  displayName: 'Pascal / Delphi',
  extensions: ['.pas', '.dpr', '.dpk', '.lpr', '.dfm', '.fmx'],
  includeGlobs: ['**/*.pas', '**/*.dpr', '**/*.dpk', '**/*.lpr', '**/*.dfm', '**/*.fmx'],
  grammar: { wasmFile: 'pascal.wasm', extractor: pascalExtractor },
  // .dfm/.fmx are Delphi/FireMonkey form files — declarative property
  // definitions, not Pascal source. Route them to the dedicated DfmExtractor.
  extensionOverrides: {
    '.dfm': { customExtractor: dfmCustomExtractor },
    '.fmx': { customExtractor: dfmCustomExtractor },
  },
};
