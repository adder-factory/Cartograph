import type { Node, NodeKind } from '../../types.js';
import {
  ContextRouteSchema,
  type CodingTaskKind,
  type ContextRoute,
  type ContextRouteBucket,
  type ContextRouteCandidate,
  type ContextRouteConfidence,
} from './contract.js';

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
]);

const CONFIG_FILE_PATTERN = /(?:^|\/)(?:config|configs|configuration)(?:\/|\.|$)|\.(?:json|jsonc|ya?ml|toml|ini|env)$/i;
const TEST_FILE_PATTERN = /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|\.)|\.(?:test|spec)\.[^/]+$/i;
const SOURCE_PATH_PATTERN =
  /(?:^|[\s('"`])((?:\.{0,2}\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]+)(?=$|[\s)'"`,;:])/g;
const IDENTIFIER_PATTERN =
  /\b(?:[A-Za-z_$][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*|[A-Z][A-Za-z0-9_$]{2,}|[A-Za-z_$][A-Za-z0-9_$]*_[A-Za-z0-9_$]+|[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+)\b/g;
const ROUTE_TOKEN_PATTERN = /[\p{L}\p{N}_]+/gu;

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
  const candidates = args.nodes
    .map((candidate) =>
      routeCandidate({
        node: candidate,
        analysis,
        taskTokens,
        intentEvidence: args.intentEvidenceByNodeId?.get(candidate.id) ?? [],
      }),
    )
    .sort(compareRouteCandidates)
    .slice(0, 12);

  const hasActionableCandidate = candidates.some((candidate) => isActionableCandidate(candidate, analysis.taskKind));
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
  const clauses = task
    .split(/\s*(?:;|\n+|\band\s+then\b|\balso\b)\s*/i)
    .map((clause) => clause.replace(/^(?:and|then)\s+/i, '').trim())
    .filter((clause) => clause.length > 0);
  return clauses.length > 0 ? clauses : [task || 'unspecified coding task'];
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
  for (const match of task.matchAll(IDENTIFIER_PATTERN)) {
    const value = match[0];
    if (pathSuffixes.has(value) || /\.(?:[cm]?[jt]sx?|jsonc?|ya?ml|toml|md)$/i.test(value)) continue;
    if (IDENTIFIER_STOP_WORDS.has(value.toLowerCase())) continue;
    identifiers.add(value);
  }
  for (const match of task.matchAll(/[`'"]([A-Za-z_$][A-Za-z0-9_$]*(?:[._][A-Za-z0-9_$]+)*)[`'"]/g)) {
    const value = match[1];
    if (value && !pathSuffixes.has(value)) identifiers.add(value);
  }
  return [...identifiers];
}

function meaningfulTokens(value: string): Set<string> {
  const tokens = value.toLowerCase().match(ROUTE_TOKEN_PATTERN) ?? [];
  return new Set(tokens.filter((token) => token.length >= 3 && !ROUTE_STOP_WORDS.has(token)));
}

interface RouteCandidateArgs {
  node: Node;
  analysis: CodingTaskAnalysis;
  taskTokens: ReadonlySet<string>;
  intentEvidence: readonly string[];
}

function routeCandidate(args: RouteCandidateArgs): ContextRouteCandidate {
  const bucket = classifyBucket(args.node);
  const evidence: string[] = [];
  let score = bucket === 'edit-site' ? 2 : bucket === 'supporting' ? 1 : 0;

  const matchedIdentifiers = args.analysis.anchors.identifiers.filter((anchor) =>
    nodeMatchesIdentifier(args.node, anchor),
  );
  if (matchedIdentifiers.length > 0) {
    score += 4;
    evidence.push(`explicit identifier ${matchedIdentifiers.map((anchor) => `\`${anchor}\``).join(', ')} matched`);
  }

  const matchedPaths = args.analysis.anchors.paths.filter((path) => pathMatchesNode(path, args.node.filePath));
  if (matchedPaths.length > 0) {
    score += 4;
    evidence.push(`explicit path \`${matchedPaths[0]}\` matched`);
  }

  if (args.intentEvidence.length > 0) {
    score += 4;
    evidence.push(...args.intentEvidence);
  }

  const overlap = countTokenOverlap(args.node, args.taskTokens);
  if (overlap > 0) {
    score += Math.min(overlap, 3);
    evidence.push(`${overlap} task term${overlap === 1 ? '' : 's'} matched symbol context`);
  }

  if (GENERIC_NODE_NAMES.has(args.node.name.toLowerCase())) {
    score -= 5;
    evidence.push('generic symbol name lowers routing precision');
  }

  if (bucket === 'test') evidence.push('test-path evidence');
  if (bucket === 'configuration') evidence.push('configuration-path evidence');
  if (evidence.length === 0) evidence.push('retrieved by lexical or graph proximity only');

  return {
    nodeId: args.node.id,
    name: args.node.name,
    kind: args.node.kind,
    filePath: args.node.filePath,
    line: args.node.startLine,
    bucket,
    confidence: confidenceForScore(score),
    evidence: dedupe(evidence),
  };
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

function countTokenOverlap(node: Node, taskTokens: ReadonlySet<string>): number {
  const nodeTokens = meaningfulTokens(`${node.name} ${node.qualifiedName} ${node.filePath} ${node.docstring ?? ''}`);
  let count = 0;
  for (const token of nodeTokens) {
    if (taskTokens.has(token)) count++;
  }
  return count;
}

function confidenceForScore(score: number): ContextRouteConfidence {
  if (score >= 5) return 'high';
  if (score >= 3) return 'medium';
  return 'low';
}

function isActionableCandidate(candidate: ContextRouteCandidate, taskKind: CodingTaskKind): boolean {
  if (candidate.confidence === 'low') return false;
  if (candidate.bucket === 'edit-site') return true;
  return ['locate', 'explain', 'review'].includes(taskKind) && candidate.bucket === 'supporting';
}

function compareRouteCandidates(a: ContextRouteCandidate, b: ContextRouteCandidate): number {
  const bucketDiff = BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket];
  if (bucketDiff !== 0) return bucketDiff;
  const confidenceDiff = CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence];
  if (confidenceDiff !== 0) return confidenceDiff;
  const pathDiff = a.filePath.localeCompare(b.filePath);
  if (pathDiff !== 0) return pathDiff;
  if (a.line !== b.line) return a.line - b.line;
  return a.name.localeCompare(b.name);
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}
