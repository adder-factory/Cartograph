/**
 * Coarse TS-vs-JS classification by file extension, for framework
 * resolvers that only need to pick a parser dialect.
 *
 * Deliberately NOT named `detectLanguage` — that name belongs to the
 * polyglot extension→Language map in `src/extraction/grammars.ts`,
 * which classifies all ~30 supported languages. A second function with
 * the same name but a 2-value return type is a trap; the `tsOrJs`
 * suffix keeps the two distinguishable at every call site.
 */
export function detectTsOrJs(filePath: string): 'typescript' | 'javascript' {
  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx') || filePath.endsWith('.mts') || filePath.endsWith('.cts')) {
    return 'typescript';
  }
  return 'javascript';
}
