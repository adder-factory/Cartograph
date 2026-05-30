/**
 * Liquid — custom regex-based extractor for Shopify Liquid templates.
 * Tree-sitter has no production-quality Liquid grammar; the
 * `LiquidExtractor` does targeted pattern matching for snippet
 * includes and Drop variable references.
 *
 * Extension coverage:
 *  - `.liquid` — Shopify/standard Liquid templates (always Liquid).
 *  - `.html` / `.md` — Jekyll embeds Liquid in `.html` layouts/includes
 *               and `.md` posts. These are scanned ONLY inside Jekyll's
 *               `_`-prefixed convention directories (`_layouts`,
 *               `_includes`, `_posts`, `_drafts`) — a non-Jekyll project
 *               has none of those dirs, so it scans zero extra files and
 *               pays no I/O cost. Within those dirs a file is treated as
 *               Liquid only when it opens with a YAML front-matter block
 *               (`---`); plain HTML/Markdown stays `unknown`.
 *
 * The front-matter gate lives in `grammars.ts` `detectLanguage()` so the
 * detection logic is in one place and applies whether files are scanned
 * by the orchestrator or passed directly to `extractFromSource`.
 */
import { LiquidExtractor } from '../liquid-extractor.js';
import type { LanguageDef } from './types.js';

export const LIQUID_DEF: LanguageDef = {
  name: 'liquid',
  displayName: 'Liquid',
  extensions: ['.liquid'],
  includeGlobs: [
    '**/*.liquid',
    // Jekyll-convention directories only — keeps a non-Jekyll repo from
    // reading every `.html`/`.md` file just to discard it as `unknown`.
    '**/_layouts/**/*.html',
    '**/_layouts/**/*.md',
    '**/_includes/**/*.html',
    '**/_includes/**/*.md',
    '**/_posts/**/*.html',
    '**/_posts/**/*.md',
    '**/_drafts/**/*.html',
    '**/_drafts/**/*.md',
  ],
  customExtractor: (filePath, source) => new LiquidExtractor(filePath, source).extract(),
};
