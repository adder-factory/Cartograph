import type { z } from 'zod';
import { extractSearchTerms, getStemVariants } from '../../search/query-utils.js';
import type { Node, NodeKind } from '../../types.js';
import {
  type CodingTaskKindSchema,
  type ContextRouteBucketSchema,
  type ContextRouteCandidateSchema,
  type ContextRouteConfidenceSchema,
  ContextRouteSchema,
  type ContextRoute,
} from './contract.js';

type CodingTaskKind = z.infer<typeof CodingTaskKindSchema>;
type ContextRouteBucket = z.infer<typeof ContextRouteBucketSchema>;
type ContextRouteCandidate = z.infer<typeof ContextRouteCandidateSchema>;
type ContextRouteConfidence = z.infer<typeof ContextRouteConfidenceSchema>;

export interface CodingTaskAnalysis {
  taskKind: CodingTaskKind;
  clauses: string[];
  anchors: {
    identifiers: string[];
    paths: string[];
  };
}

export interface BuildContextRouteArgs {
  task: string;
  nodes: readonly Node[];
  intentEvidenceByNodeId?: ReadonlyMap<string, readonly string[]>;
  intentSpecificityByNodeId?: ReadonlyMap<string, number>;
}

const TASK_KIND_PATTERNS: ReadonlyArray<readonly [CodingTaskKind, readonly RegExp[]]> = [
  ['debug', [/\bfix\b/i, /\bbug\b/i, /\berror\b/i, /\bfail(?:s|ed|ing)?\b/i, /\bregression\b/i, /\bbroken\b/i]],
  ['refactor', [/\brefactor\b/i, /\brestructure\b/i, /\bextract\b/i, /\bdecouple\b/i, /\brename\b/i]],
  ['feature', [/\badd\b/i, /\bcreate\b/i, /\bimplement\b/i, /\bbuild\b/i, /\benable\b/i, /\bsupport\b/i]],
  ['test', [/\btests?\b/i, /\bverify\b/i, /\bcoverage\b/i, /\bassert(?:ion)?s?\b/i]],
  ['review', [/\breview\b/i, /\baudit\b/i, /\bquality\b/i, /\bsecurity\b/i]],
  ['explain', [/\bhow\b/i, /\bwhy\b/i, /\bexplain\b/i, /\bunderstand\b/i, /\btrace\b/i]],
  ['locate', [/\bwhere\b/i, /\bfind\b/i, /\blocate\b/i, /\bwhich\b/i]],
];

const GENERIC_NODE_NAMES = new Set([
  'code',
  'config',
  'data',
  'default',
  'files',
  'handler',
  'helpers',
  'index',
  'items',
  'main',
  'options',
  'result',
  'results',
  'sites',
  'state',
  'tests',
  'types',
  'utils',
  'value',
  'values',
]);

const EDIT_SITE_KINDS: ReadonlySet<NodeKind> = new Set([
  'class',
  'struct',
  'function',
  'method',
  'variable',
  'route',
  'component',
  'constant',
]);

const CONFIG_FILE_PATTERN =
  /(?:(?:^|\/)(?:config|configs|configuration)(?:\/|\.|$)|\.(?:json|jsonc|ya?ml|toml|ini|env)$)/i;
const TEST_FILE_PATTERN = /(?:(?:^|\/)(?:__tests__|tests?|specs?)[/.]|\.(?:test|spec)\.[^/]+$)/i;
const SOURCE_PATH_PATTERN =
  /(?:^|[\s('"`])((?:\.{0,2}\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]+)(?=$|[\s)'"`,;:])/g;
const ROUTE_TOKEN_PATTERN = /[\p{L}\p{N}_]+/gu;
const SOURCE_TOKEN_EXTENSIONS = new Set([
  'cjs',
  'cjsx',
  'cts',
  'ctsx',
  'js',
  'json',
  'jsonc',
  'jsx',
  'md',
  'mjs',
  'mjsx',
  'mts',
  'mtsx',
  'toml',
  'ts',
  'tsx',
  'yaml',
  'yml',
]);

const ROUTE_STOP_WORDS = new Set([
  'a',
  'all',
  'also',
  'an',
  'and',
  'as',
  'at',
  'be',
  'before',
  'by',
  'code',
  'does',
  'for',
  'from',
  'how',
  'in',
  'into',
  'is',
  'it',
  'of',
  'on',
  'or',
  'should',
  'that',
  'the',
  'then',
  'this',
  'to',
  'update',
  'use',
  'with',
]);

const IDENTIFIER_STOP_WORDS = new Set([
  'add',
  'audit',
  'build',
  'create',
  'debug',
  'explain',
  'find',
  'fix',
  'implement',
  'locate',
  'refactor',
  'review',
  'test',
  'update',
  'verify',
]);

const BUCKET_ORDER: Readonly<Record<ContextRouteBucket, number>> = {
  'edit-site': 0,
  supporting: 1,
  test: 2,
  configuration: 3,
};

const CONFIDENCE_ORDER: Readonly<Record<ContextRouteConfidence, number>> = {
  high: 0,
  medium: 1,
  low: 2,
};

export function analyzeCodingTask(task: string): CodingTaskAnalysis {
  const normalized = task.replaceAll(/\s+/g, ' ').trim();
  const clauses = splitTaskClauses(normalized);
  const paths = extractPaths(normalized);
  const identifiers = extractIdentifiers(normalized, paths);
  return {
    taskKind: classifyTaskKind(normalized),
    clauses,
    anchors: { identifiers, paths },
  };
}

export function buildContextRoute(args: BuildContextRouteArgs): ContextRoute {
  const analysis = analyzeCodingTask(args.task);
  const taskTokens = meaningfulTokens(args.task);
  const anchorFrequency = buildAnchorFrequency(args.nodes, taskTokens);
  const ranked = args.nodes
    .map((candidate) =>
      routeCandidate({
        node: candidate,
        analysis,
        taskTokens,
        anchorFrequency,
        intentEvidence: args.intentEvidenceByNodeId?.get(candidate.id) ?? [],
        intentSpecificity: args.intentSpecificityByNodeId?.get(candidate.id) ?? 0,
      }),
    )
    .sort(compareRankedRouteCandidates)
    .slice(0, 12);
  const candidates = ranked.map((entry) => entry.candidate);

  const hasActionableCandidate = ranked.some((entry) => isActionableCandidate(entry, analysis.taskKind));
  if (!hasActionableCandidate) {
    return ContextRouteSchema.parse({
      ...analysis,
      candidates,
      status: 'abstained',
      reason:
        candidates.length === 0
          ? 'No candidate symbols matched strongly enough to identify an edit route.'
          : 'Retrieved symbols are generic, diagnostic-only, or lack enough task evidence to name a safe edit site.',
    });
  }

  return ContextRouteSchema.parse({ ...analysis, candidates, status: 'ready' });
}

function classifyTaskKind(task: string): CodingTaskKind {
  for (const [kind, patterns] of TASK_KIND_PATTERNS) {
    if (patterns.some((pattern) => pattern.test(task))) return kind;
  }
  return 'locate';
}

function splitTaskClauses(task: string): string[] {
  let clauses = task.split(';');
  for (const connector of [' and then ', ' also ']) {
    clauses = clauses.flatMap((clause) => splitCaseInsensitive(clause, connector));
  }
  clauses = clauses.map(trimClausePrefix).filter((clause) => clause.length > 0);
  return clauses.length > 0 ? clauses : [task || 'unspecified coding task'];
}

function splitCaseInsensitive(value: string, delimiter: string): string[] {
  const parts: string[] = [];
  const lowerValue = value.toLowerCase();
  let start = 0;
  let match = lowerValue.indexOf(delimiter, start);
  while (match !== -1) {
    parts.push(value.slice(start, match));
    start = match + delimiter.length;
    match = lowerValue.indexOf(delimiter, start);
  }
  parts.push(value.slice(start));
  return parts;
}

function trimClausePrefix(value: string): string {
  const clause = value.trim();
  const lower = clause.toLowerCase();
  if (lower.startsWith('and ')) return clause.slice('and '.length).trim();
  if (lower.startsWith('then ')) return clause.slice('then '.length).trim();
  return clause;
}

function extractPaths(task: string): string[] {
  const paths = new Set<string>();
  for (const match of task.matchAll(SOURCE_PATH_PATTERN)) {
    const value = match[1];
    if (value) paths.add(value);
  }
  return [...paths];
}

function extractIdentifiers(task: string, paths: readonly string[]): string[] {
  const identifiers = new Set<string>();
  const pathSuffixes = new Set(paths.flatMap((path) => path.split('/')));
  for (const candidate of scanIdentifierCandidates(task)) {
    const value = candidate.value;
    if (!candidate.quoted && !looksLikeCodeIdentifier(value)) continue;
    if (pathSuffixes.has(value) || looksLikeSourceToken(value)) continue;
    if (IDENTIFIER_STOP_WORDS.has(value.toLowerCase())) continue;
    identifiers.add(value);
  }
  return [...identifiers];
}

interface IdentifierCandidate {
  value: string;
  quoted: boolean;
}

function scanIdentifierCandidates(value: string): IdentifierCandidate[] {
  const candidates: IdentifierCandidate[] = [];
  let start = -1;
  for (let index = 0; index <= value.length; index++) {
    const char = value[index];
    if (start === -1) {
      if (char && isIdentifierStartChar(char)) start = index;
      continue;
    }
    if (char && isIdentifierBodyChar(char)) continue;
    const candidate = value.slice(start, index);
    candidates.push({ value: candidate, quoted: isQuotedIdentifier(value, start, index) });
    start = -1;
  }
  return candidates;
}

function isIdentifierStartChar(char: string): boolean {
  return isAsciiLetter(char) || char === '_' || char === '$';
}

function isIdentifierBodyChar(char: string): boolean {
  return isIdentifierStartChar(char) || isAsciiDigit(char) || char === '.';
}

function isAsciiLetter(char: string): boolean {
  const code = char.codePointAt(0) ?? -1;
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiDigit(char: string): boolean {
  const code = char.codePointAt(0) ?? -1;
  return code >= 48 && code <= 57;
}

function isQuotedIdentifier(value: string, start: number, end: number): boolean {
  const before = value[start - 1];
  return before === value[end] && (before === '`' || before === "'" || before === '"');
}

function looksLikeCodeIdentifier(value: string): boolean {
  if (value.includes('_')) return true;
  if (isDottedIdentifier(value)) return true;
  if (value.length >= 3 && isUpperAscii(value[0]!)) return true;
  for (let index = 1; index < value.length; index++) {
    if (isLowerAscii(value[index - 1]!) && isUpperAscii(value[index]!)) return true;
  }
  return false;
}

function isDottedIdentifier(value: string): boolean {
  const segments = value.split('.');
  return segments.length > 1 && segments.every(isIdentifierSegment);
}

function isIdentifierSegment(value: string): boolean {
  if (!value || !isIdentifierStartChar(value[0]!)) return false;
  return [...value].every((char) => isIdentifierStartChar(char) || isAsciiDigit(char));
}

function isUpperAscii(char: string): boolean {
  const code = char.codePointAt(0) ?? -1;
  return code >= 65 && code <= 90;
}

function isLowerAscii(char: string): boolean {
  const code = char.codePointAt(0) ?? -1;
  return code >= 97 && code <= 122;
}

function looksLikeSourceToken(value: string): boolean {
  const dot = value.lastIndexOf('.');
  return dot !== -1 && SOURCE_TOKEN_EXTENSIONS.has(value.slice(dot + 1).toLowerCase());
}

function meaningfulTokens(value: string): Set<string> {
  const tokens = value.toLowerCase().match(ROUTE_TOKEN_PATTERN) ?? [];
  const meaningful = new Set(tokens.filter((token) => token.length >= 3 && !ROUTE_STOP_WORDS.has(token)));
  for (const token of extractSearchTerms(value, { stems: false })) {
    if (!ROUTE_STOP_WORDS.has(token)) meaningful.add(token);
  }
  return meaningful;
}

interface RouteCandidateArgs {
  node: Node;
  analysis: CodingTaskAnalysis;
  taskTokens: ReadonlySet<string>;
  anchorFrequency: ReadonlyMap<string, number>;
  intentEvidence: readonly string[];
  intentSpecificity: number;
}

interface RankedRouteCandidate {
  candidate: ContextRouteCandidate;
  reliablyGrounded: boolean;
  score: number;
  anchorSpecificity: number;
  intentSpecificity: number;
}

interface ExplicitRouteEvidence {
  evidence: string[];
  matchedIdentifiers: string[];
  matchedPaths: string[];
  score: number;
}

interface TokenRouteEvidence {
  anchorOverlap: number;
  anchorSpecificity: number;
  evidence: string[];
  score: number;
}

const EDIT_SITE_BASE_SCORE = 2;
const SUPPORTING_BASE_SCORE = 1;
const EXPLICIT_ANCHOR_SCORE = 4;
const INTENT_EVIDENCE_SCORE = 4;
const MAX_TOKEN_OVERLAP_SCORE = 3;
const GENERIC_NODE_NAME_PENALTY = 5;
const LONG_TASK_TOKEN_THRESHOLD = 4;
const LONG_TASK_REQUIRED_ANCHORS = 2;
const SHORT_TASK_REQUIRED_ANCHORS = 1;
const UNGROUNDED_MUTATION_SCORE_CAP = 2;
const MUTATION_TASK_KINDS: ReadonlySet<CodingTaskKind> = new Set(['debug', 'refactor', 'feature', 'test']);

function routeCandidate(args: RouteCandidateArgs): RankedRouteCandidate {
  const bucket = classifyBucket(args.node);
  const explicit = collectExplicitRouteEvidence(args);
  const token = collectTokenRouteEvidence(args);
  const evidence = [...explicit.evidence, ...token.evidence];
  let score = bucketBaseScore(bucket) + explicit.score + token.score;

  if (GENERIC_NODE_NAMES.has(args.node.name.toLowerCase())) {
    score -= GENERIC_NODE_NAME_PENALTY;
    evidence.push('generic symbol name lowers routing precision');
  }

  appendBucketEvidence(bucket, evidence);
  const reliablyGrounded = hasReliableGrounding(args, explicit, token.anchorOverlap);
  if (!reliablyGrounded && MUTATION_TASK_KINDS.has(args.analysis.taskKind)) {
    score = Math.min(score, UNGROUNDED_MUTATION_SCORE_CAP);
    evidence.push('no distinguishing task anchor matched the symbol name or path');
  }
  if (evidence.length === 0) evidence.push('retrieved by lexical or graph proximity only');

  return {
    candidate: {
      nodeId: args.node.id,
      name: args.node.name,
      kind: args.node.kind,
      filePath: args.node.filePath,
      line: args.node.startLine,
      bucket,
      confidence: confidenceForScore(score),
      evidence: dedupe(evidence),
    },
    reliablyGrounded,
    score,
    anchorSpecificity: token.anchorSpecificity,
    intentSpecificity: args.intentSpecificity,
  };
}

function bucketBaseScore(bucket: ContextRouteBucket): number {
  if (bucket === 'edit-site') return EDIT_SITE_BASE_SCORE;
  if (bucket === 'supporting') return SUPPORTING_BASE_SCORE;
  return 0;
}

function collectExplicitRouteEvidence(args: RouteCandidateArgs): ExplicitRouteEvidence {
  const evidence: string[] = [];
  const matchedIdentifiers = args.analysis.anchors.identifiers.filter((anchor) =>
    nodeMatchesIdentifier(args.node, anchor),
  );
  const matchedPaths = args.analysis.anchors.paths.filter((path) => pathMatchesNode(path, args.node.filePath));
  let score = 0;
  if (matchedIdentifiers.length > 0) {
    score += EXPLICIT_ANCHOR_SCORE;
    const quotedIdentifiers = matchedIdentifiers.map(formatCodeSpan).join(', ');
    evidence.push(`explicit identifier ${quotedIdentifiers} matched`);
  }
  if (matchedPaths.length > 0) {
    score += EXPLICIT_ANCHOR_SCORE;
    evidence.push(`explicit path \`${matchedPaths[0]}\` matched`);
  }
  if (args.intentEvidence.length > 0) {
    score += INTENT_EVIDENCE_SCORE;
    evidence.push(...args.intentEvidence);
  }
  return { evidence, matchedIdentifiers, matchedPaths, score };
}

function formatCodeSpan(value: string): string {
  return `\`${value}\``;
}

function collectTokenRouteEvidence(args: RouteCandidateArgs): TokenRouteEvidence {
  const evidence: string[] = [];
  const matchedAnchorTerms = matchingValueTokens(
    `${args.node.name} ${args.node.qualifiedName} ${args.node.filePath}`,
    args.taskTokens,
  );
  const anchorOverlap = matchedAnchorTerms.length;
  const anchorSpecificity = matchedAnchorTerms.reduce(
    (total, term) => total + 1 / (args.anchorFrequency.get(term) ?? 1),
    0,
  );
  const documentationOverlap = matchingValueTokens(args.node.docstring ?? '', args.taskTokens).length;
  if (anchorOverlap > 0) {
    evidence.push(`${anchorOverlap} task term${anchorOverlap === 1 ? '' : 's'} matched symbol name/path`);
  }
  if (documentationOverlap > 0) {
    evidence.push(
      `${documentationOverlap} task term${documentationOverlap === 1 ? '' : 's'} matched symbol documentation`,
    );
  }
  return {
    anchorOverlap,
    anchorSpecificity,
    evidence,
    score: Math.min(anchorOverlap, MAX_TOKEN_OVERLAP_SCORE) + Math.min(documentationOverlap, MAX_TOKEN_OVERLAP_SCORE),
  };
}

function hasReliableGrounding(
  args: RouteCandidateArgs,
  explicit: ExplicitRouteEvidence,
  anchorOverlap: number,
): boolean {
  const requiredAnchorOverlap =
    args.taskTokens.size >= LONG_TASK_TOKEN_THRESHOLD ? LONG_TASK_REQUIRED_ANCHORS : SHORT_TASK_REQUIRED_ANCHORS;
  return (
    explicit.matchedIdentifiers.length > 0 ||
    explicit.matchedPaths.length > 0 ||
    args.intentEvidence.length > 0 ||
    anchorOverlap >= requiredAnchorOverlap
  );
}

function appendBucketEvidence(bucket: ContextRouteBucket, evidence: string[]): void {
  if (bucket === 'test') evidence.push('test-path evidence');
  if (bucket === 'configuration') evidence.push('configuration-path evidence');
}

function classifyBucket(node: Node): ContextRouteBucket {
  if (TEST_FILE_PATTERN.test(node.filePath)) return 'test';
  if (CONFIG_FILE_PATTERN.test(node.filePath)) return 'configuration';
  if (EDIT_SITE_KINDS.has(node.kind)) return 'edit-site';
  return 'supporting';
}

function nodeMatchesIdentifier(node: Node, anchor: string): boolean {
  const normalizedAnchor = anchor.toLowerCase();
  return (
    node.name.toLowerCase() === normalizedAnchor ||
    node.qualifiedName.toLowerCase() === normalizedAnchor ||
    node.qualifiedName.toLowerCase().endsWith(`.${normalizedAnchor}`)
  );
}

function pathMatchesNode(anchor: string, filePath: string): boolean {
  const normalizedAnchor = anchor.replace(/^\.\//, '').toLowerCase();
  const normalizedPath = filePath.replace(/^\.\//, '').toLowerCase();
  return normalizedPath === normalizedAnchor || normalizedPath.endsWith(`/${normalizedAnchor}`);
}

function matchingValueTokens(value: string, taskTokens: ReadonlySet<string>): string[] {
  const nodeTokens = meaningfulTokens(value);
  const nodeVariants = new Set<string>();
  for (const token of nodeTokens) {
    for (const variant of routeTokenVariants(token)) nodeVariants.add(variant);
  }
  return [...taskTokens].filter((token) => routeTokenVariants(token).some((variant) => nodeVariants.has(variant)));
}

function routeTokenVariants(term: string): string[] {
  return [term, ...getStemVariants(term).filter((variant) => term.length - variant.length <= 3)];
}

function buildAnchorFrequency(nodes: readonly Node[], taskTokens: ReadonlySet<string>): Map<string, number> {
  const frequency = new Map<string, number>();
  for (const node of nodes) {
    const matches = matchingValueTokens(`${node.name} ${node.qualifiedName} ${node.filePath}`, taskTokens);
    for (const term of matches) frequency.set(term, (frequency.get(term) ?? 0) + 1);
  }
  return frequency;
}

function confidenceForScore(score: number): ContextRouteConfidence {
  if (score >= 5) return 'high';
  if (score >= 3) return 'medium';
  return 'low';
}

function isActionableCandidate(entry: RankedRouteCandidate, taskKind: CodingTaskKind): boolean {
  if (entry.candidate.confidence === 'low' || !entry.reliablyGrounded) return false;
  if (entry.candidate.bucket === 'edit-site') return true;
  return ['locate', 'explain', 'review'].includes(taskKind) && entry.candidate.bucket === 'supporting';
}

function compareRankedRouteCandidates(a: RankedRouteCandidate, b: RankedRouteCandidate): number {
  const bucketDiff = BUCKET_ORDER[a.candidate.bucket] - BUCKET_ORDER[b.candidate.bucket];
  if (bucketDiff !== 0) return bucketDiff;
  const confidenceDiff = CONFIDENCE_ORDER[a.candidate.confidence] - CONFIDENCE_ORDER[b.candidate.confidence];
  if (confidenceDiff !== 0) return confidenceDiff;
  const intentSpecificityDiff = b.intentSpecificity - a.intentSpecificity;
  if (Math.abs(intentSpecificityDiff) > Number.EPSILON) return intentSpecificityDiff;
  const specificityDiff = b.anchorSpecificity - a.anchorSpecificity;
  if (Math.abs(specificityDiff) > Number.EPSILON) return specificityDiff;
  const scoreDiff = b.score - a.score;
  if (scoreDiff !== 0) return scoreDiff;
  const pathDiff = a.candidate.filePath.localeCompare(b.candidate.filePath);
  if (pathDiff !== 0) return pathDiff;
  if (a.candidate.line !== b.candidate.line) return a.candidate.line - b.candidate.line;
  return a.candidate.name.localeCompare(b.candidate.name);
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}
