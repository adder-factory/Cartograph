import type { LanguageDef } from './types.js';
import { luaExtractor } from './lua.js';
import { extractAnubis } from './bg3/anubis.js';
import { extractBg3Resource } from './bg3/resource.js';
import { extractBg3Stats } from './bg3/stats.js';
import { extractOsiris } from './bg3/osiris.js';

export const BG3_ANUBIS_DEF: LanguageDef = {
  name: 'bg3_anubis',
  displayName: 'BG3 Anubis',
  extensions: ['.ann', '.anc'],
  includeGlobs: ['**/Scripts/anubis/node/*.ann', '**/Scripts/anubis/config/*.anc', '**/*.ann', '**/*.anc'],
  customExtractor: extractAnubis,
};

export const BG3_RESOURCE_DEF: LanguageDef = {
  name: 'bg3_resource',
  displayName: 'BG3 Resource Data',
  extensions: ['.lsx', '.lsf', '.lsfx', '.lsefx', '.tbl', '.stats', '.mei', '.lsj'],
  includeGlobs: [
    '**/*.lsx',
    '**/*.lsf',
    '**/*.lsfx',
    '**/*.lsefx',
    '**/*.tbl',
    '**/*.stats',
    '**/*.mei',
    '**/*.lsj',
    '**/Localization/**/*.xml',
  ],
  customExtractor: extractBg3Resource,
};

export const BG3_STATS_DEF: LanguageDef = {
  name: 'bg3_stats',
  displayName: 'BG3 Stats DSL',
  extensions: [],
  includeGlobs: ['**/Stats/Generated/**/*.txt', '**/Stats/Generated/*.txt'],
  customExtractor: extractBg3Stats,
};

export const KHN_DEF: LanguageDef = {
  name: 'khn',
  displayName: 'BG3 KHN / Thoth Lua',
  extensions: ['.khn'],
  includeGlobs: ['**/*.khn'],
  grammar: { wasmFile: 'lua.wasm', extractor: luaExtractor },
};

export const OSIRIS_DEF: LanguageDef = {
  name: 'osiris',
  displayName: 'Osiris Story',
  extensions: ['.div'],
  includeGlobs: ['**/*.div', '**/Story/RawFiles/Goals/*.txt'],
  customExtractor: extractOsiris,
};
