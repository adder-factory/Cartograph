export type FindAxis = 'name' | 'content' | 'env' | 'sql';
export type FindNameMode = 'exact' | 'fuzzy' | 'semantic' | 'intent';

export interface FindOptions {
  projectPath?: string;
  by?: string;
  query?: string;
  limit?: string;
  kind?: string;
  mode?: string;
  symbol?: string;
  sameLanguage?: boolean;
  differentLanguage?: boolean;
  languageFilter?: string;
  caseSensitive?: boolean;
  pathFilter?: string;
  language?: string;
  key?: string;
  op?: string;
  includeTests?: boolean;
  since?: string;
  allowStale?: boolean;
  compact?: boolean;
  fields?: string;
  lowTokens?: boolean;
}

export type FindArgsResult = { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

const FIND_NAME_LIMIT_DEFAULT = '10';
const FIND_CONTENT_LIMIT_DEFAULT = '50';
const FIND_REF_LIMIT_DEFAULT = '30';

export function parseFieldsOption(fields: string | undefined): string[] | undefined {
  return fields
    ?.split(',')
    .map((f) => f.trim())
    .filter(Boolean);
}

export function isValidFindAxis(by: string): by is FindAxis {
  return by === 'name' || by === 'content' || by === 'env' || by === 'sql';
}

export function buildFindMcpArgs(queryArg: string | undefined, options: FindOptions): FindArgsResult {
  const query = queryArg === undefined && typeof options.query === 'string' ? options.query : queryArg;
  const by = options.by ?? 'name';
  if (!isValidFindAxis(by)) {
    return { ok: false, error: `--by: must be 'name' | 'content' | 'env' | 'sql'; got '${by}'.` };
  }
  if (by === 'content') return buildFindContentArgs(query, options);
  if (by === 'env' || by === 'sql') return buildFindEnvOrSqlArgs(by, options);
  return buildFindByNameArgs(query, options);
}

function buildFindContentArgs(query: string | undefined, options: FindOptions): FindArgsResult {
  if (!query) return { ok: false, error: '--by content: [query] is required (regex pattern).' };
  const args: Record<string, unknown> = { by: 'content', query };
  const limit = parsePositiveInt(options.limit ?? FIND_CONTENT_LIMIT_DEFAULT, '--limit');
  if (!limit.ok) return limit;
  args['limit'] = limit.value;
  if (options.caseSensitive) args['caseSensitive'] = true;
  if (options.pathFilter) args['pathFilter'] = options.pathFilter;
  if (options.language) args['language'] = options.language;
  if (options.since) args['since'] = options.since;
  if (options.allowStale) args['allowStale'] = true;
  if (options.lowTokens) args['lowTokens'] = true;
  return { ok: true, args };
}

function buildFindEnvOrSqlArgs(by: 'env' | 'sql', options: FindOptions): FindArgsResult {
  const args: Record<string, unknown> = { by };
  const limit = parsePositiveInt(options.limit ?? FIND_REF_LIMIT_DEFAULT, '--limit');
  if (!limit.ok) return limit;
  args['limit'] = limit.value;
  if (options.key) args['key'] = options.key;
  if (options.op) args['op'] = options.op;
  if ('includeTests' in options) args['includeTests'] = options.includeTests;
  if (options.allowStale) args['allowStale'] = true;
  if (options.lowTokens) args['lowTokens'] = true;
  return { ok: true, args };
}

function buildFindByNameArgs(query: string | undefined, options: FindOptions): FindArgsResult {
  const mode = options.mode ?? 'exact';
  if (mode === 'fuzzy' || mode === 'semantic' || mode === 'intent') {
    return buildFindDelegatedNameArgs(mode, query, options);
  }
  if (mode !== 'exact') {
    return { ok: false, error: `Unknown --mode: ${mode}. Valid: exact | fuzzy | semantic | intent.` };
  }
  return buildFindExactNameArgs(query, options);
}

function buildFindDelegatedNameArgs(
  mode: FindNameMode,
  query: string | undefined,
  options: FindOptions,
): FindArgsResult {
  const valid = validateDelegatedNameMode(mode, query, options);
  if (!valid.ok) return valid;
  const args: Record<string, unknown> = { by: 'name', mode };
  const limit = parsePositiveInt(options.limit ?? FIND_NAME_LIMIT_DEFAULT, '--limit');
  if (!limit.ok) return limit;
  args['limit'] = limit.value;
  if (query) args['query'] = query;
  if (options.symbol) args['symbol'] = options.symbol;
  if (options.kind) args['kind'] = options.kind;
  if (options.sameLanguage) args['sameLanguage'] = true;
  if (options.differentLanguage) args['differentLanguage'] = true;
  if (options.languageFilter) args['languageFilter'] = options.languageFilter;
  if (options.pathFilter) args['pathFilter'] = options.pathFilter;
  if (options.allowStale) args['allowStale'] = true;
  if (options.lowTokens) args['lowTokens'] = true;
  return { ok: true, args };
}

export function validateDelegatedNameMode(
  mode: FindNameMode,
  query: string | undefined,
  options: FindOptions,
): { ok: true } | { ok: false; error: string } {
  if (mode === 'semantic') return validateSemanticFind(query, options);
  if (!query) return { ok: false, error: `--by name --mode ${mode}: [query] is required` };
  return { ok: true };
}

export function validateSemanticFind(
  query: string | undefined,
  options: FindOptions,
): { ok: true } | { ok: false; error: string } {
  if (!options.symbol && !query) {
    return { ok: false, error: '--by name --mode semantic: pass either [query] (concept text) or --symbol <name>' };
  }
  if (options.symbol && query) {
    return { ok: false, error: '--by name --mode semantic: [query] and --symbol are mutually exclusive — pick one' };
  }
  if (options.sameLanguage && options.differentLanguage) {
    return {
      ok: false,
      error: '--by name --mode semantic: --same-language and --different-language are mutually exclusive — pick one',
    };
  }
  return { ok: true };
}

function buildFindExactNameArgs(query: string | undefined, options: FindOptions): FindArgsResult {
  if (!query) return { ok: false, error: '[query] is required for --by name --mode exact' };
  const exactArgs: Record<string, unknown> = { by: 'name', mode: 'exact', query };
  const limit = parsePositiveInt(options.limit ?? FIND_NAME_LIMIT_DEFAULT, '--limit');
  if (!limit.ok) return limit;
  exactArgs['limit'] = limit.value;
  if (options.kind) exactArgs['kind'] = options.kind;
  if (options.compact) exactArgs['compact'] = true;
  const fields = parseFieldsOption(options.fields);
  if (fields) exactArgs['fields'] = fields;
  if (options.since) exactArgs['since'] = options.since;
  if (options.allowStale) exactArgs['allowStale'] = true;
  if (options.lowTokens) exactArgs['lowTokens'] = true;
  return { ok: true, args: exactArgs };
}

function parsePositiveInt(raw: string, optionName: string): { ok: true; value: number } | { ok: false; error: string } {
  const n = Number(raw);
  if (!Number.isInteger(n) || !Number.isFinite(n)) {
    return { ok: false, error: `Invalid value for ${optionName}: "${raw}" is not an integer` };
  }
  if (n < 1) return { ok: false, error: `Invalid value for ${optionName}: must be >= 1` };
  return { ok: true, value: n };
}
