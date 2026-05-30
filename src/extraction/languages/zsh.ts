import { bashExtractor } from './bash.js';
import type { LanguageDef } from './types.js';

/**
 * Zsh extraction.
 *
 * Zsh is a near-superset of bash; tree-sitter-bash parses the constructs we
 * extract (function definitions, sourcing, `set`/`export`/`readonly`-style
 * variable assignments, command calls) without modification. Zsh-specific
 * forms — `(( ))` arithmetic with extended operators, glob qualifiers,
 * `=>` array operator — fall through as ERROR subtrees and are silently
 * skipped, matching tree-sitter's normal degraded-parse behaviour.
 *
 * Re-using `bashExtractor` keeps the two surfaces identical: any bash
 * extractor improvement applies to zsh files automatically. If the two
 * languages ever need to diverge (e.g. zsh-specific autoload extraction),
 * we can fork a `zshExtractor` here without rewiring the registry.
 */
export const ZSH_DEF: LanguageDef = {
  name: 'zsh',
  displayName: 'Zsh',
  // `detectLanguage` maps a path to a language by `lastIndexOf('.')` slice, so
  // dot-prefixed config files (`.zshrc`, `.zshenv`, …) ARE valid "extensions"
  // here — `'.zshrc'.lastIndexOf('.') === 0`, so the extension is `.zshrc`.
  // Listing them lets the file scanner pick them up and the grammar resolve.
  extensions: ['.zsh', '.zshrc', '.zshenv', '.zprofile', '.zlogin'],
  includeGlobs: ['**/*.zsh', '**/.zshrc', '**/.zshenv', '**/.zprofile', '**/.zlogin'],
  // Same grammar as BASH_DEF — bash.wasm loaded by web-tree-sitter from src/extraction/wasm/, reusing bashExtractor.
  grammar: { wasmFile: 'bash.wasm', extractor: bashExtractor },
};
