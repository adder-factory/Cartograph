import { auraComponentName, extractSalesforceMarkup } from '../salesforce-markup-extractor.js';
import type { LanguageDef } from './types.js';

function auraKindForPath(filePath: string): 'component' | 'resource' {
  return /\.(?:app|cmp)$/i.test(filePath) ? 'component' : 'resource';
}

export const AURA_DEF: LanguageDef = {
  name: 'aura',
  displayName: 'Aura',
  extensions: ['.cmp', '.app', '.evt', '.intf', '.design', '.auradoc'],
  includeGlobs: [
    '**/aura/*.cmp',
    '**/aura/**/*.cmp',
    '**/aura/*.app',
    '**/aura/**/*.app',
    '**/aura/*.evt',
    '**/aura/**/*.evt',
    '**/aura/*.intf',
    '**/aura/**/*.intf',
    '**/aura/*.design',
    '**/aura/**/*.design',
    '**/aura/*.auradoc',
    '**/aura/**/*.auradoc',
  ],
  customExtractor: (filePath, source) =>
    extractSalesforceMarkup(filePath, source, {
      language: 'aura',
      componentKind: auraKindForPath(filePath),
      componentName: auraComponentName(filePath),
    }),
};
