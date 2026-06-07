import { extractSalesforceMarkup, visualforceComponentName } from '../salesforce-markup-extractor.js';
import type { LanguageDef } from './types.js';

function routeNameForPath(filePath: string): string | undefined {
  if (!filePath.endsWith('.page')) return undefined;
  return `/apex/${visualforceComponentName(filePath)}`;
}

export const VISUALFORCE_DEF: LanguageDef = {
  name: 'visualforce',
  displayName: 'Visualforce',
  extensions: ['.page', '.component'],
  includeGlobs: [
    '**/pages/*.page',
    '**/pages/**/*.page',
    '**/components/*.component',
    '**/components/**/*.component',
    '**/visualforce/*.page',
    '**/visualforce/**/*.page',
    '**/visualforce/*.component',
    '**/visualforce/**/*.component',
  ],
  customExtractor: (filePath, source) =>
    extractSalesforceMarkup(filePath, source, {
      language: 'visualforce',
      componentKind: 'component',
      componentName: visualforceComponentName(filePath),
      ...(routeNameForPath(filePath) ? { routeName: routeNameForPath(filePath)! } : {}),
    }),
};
