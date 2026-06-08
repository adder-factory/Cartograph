import * as fs from 'node:fs';
import { getAllFiles } from '../db/queries-files.js';
import type { QueryBuilder } from '../db/queries.js';
import { findEnclosingNode, sortScopesBySpan } from '../index-hooks/enclosing.js';
import { isDiagnosticPath } from '../path-class.js';
import { scorePathRelevance } from '../search/query-utils.js';
import type { SearchResult } from '../search/types.js';
import type { Node, NodeKind } from '../types.js';
import { validatePathWithinRootReal } from '../utils.js';

const MAX_SOURCE_TEXT_TERMS = 4;
const MAX_SOURCE_TEXT_TERM_LENGTH = 80;
const MAX_SOURCE_TEXT_FILE_BYTES = 1_000_000;
const SOURCE_TEXT_BASE_SCORE = 85;
const SOURCE_TEXT_MULTI_TERM_BONUS = 18;
const SOURCE_TEXT_MAX_RESULTS = 20;

const STRUCTURED_TERM_PATTERN = /[A-Za-z0-9@][A-Za-z0-9_.:/@+-]{2,}/g;
const QUOTED_TERM_PATTERN = /(["'`])([^"'`\r\n]{2,80})\1/g;
const SOURCE_TEXT_PRIMARY_KINDS: ReadonlySet<NodeKind> = new Set(['function', 'method', 'class', 'route', 'component']);

export interface SourceTextCandidateArgs {
  projectRoot: string;
  queries: QueryBuilder;
  query: string;
  nodeKinds: readonly NodeKind[];
  isTestQuery: boolean;
}

interface SourceTextTermHit {
  node: Node;
  terms: Set<string>;
}

export function extractCodeLikeSourceTerms(query: string): string[] {
  const terms = new Set<string>();
  collectQuotedTerms(query, terms);
  collectStructuredTerms(query, terms);
  return [...terms].slice(0, MAX_SOURCE_TEXT_TERMS);
}

export function findSourceTextContextCandidates(args: SourceTextCandidateArgs): SearchResult[] {
  const terms = extractCodeLikeSourceTerms(args.query);
  if (terms.length === 0) return [];

  const allowedKinds = new Set(args.nodeKinds);
  const hits = new Map<string, SourceTextTermHit>();
  for (const file of getAllFiles(args.queries)) {
    if (!args.isTestQuery && isDiagnosticPath(file.path)) continue;
    if (file.size > MAX_SOURCE_TEXT_FILE_BYTES) continue;
    collectFileSourceTextHits({ ...args, filePath: file.path, terms, allowedKinds, hits });
  }

  return [...hits.values()]
    .map(({ node, terms: matchedTerms }) => ({
      node,
      score:
        SOURCE_TEXT_BASE_SCORE +
        (matchedTerms.size - 1) * SOURCE_TEXT_MULTI_TERM_BONUS +
        scorePathRelevance(node.filePath, args.query),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, SOURCE_TEXT_MAX_RESULTS);
}

function collectQuotedTerms(query: string, terms: Set<string>): void {
  let match: RegExpExecArray | null;
  while ((match = QUOTED_TERM_PATTERN.exec(query)) !== null) {
    const term = cleanSourceTextTerm(match[2] ?? '');
    if (isCodeLikeSourceTerm(term)) terms.add(term);
  }
}

function collectStructuredTerms(query: string, terms: Set<string>): void {
  let match: RegExpExecArray | null;
  while ((match = STRUCTURED_TERM_PATTERN.exec(query)) !== null) {
    const term = cleanSourceTextTerm(match[0]);
    if (isCodeLikeSourceTerm(term)) terms.add(term);
  }
}

function cleanSourceTextTerm(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isSourceTextOpeningPunctuation(value[start]!)) start++;
  while (end > start && isSourceTextClosingPunctuation(value[end - 1]!)) end--;
  return value.slice(start, end).trim();
}

function isSourceTextOpeningPunctuation(char: string): boolean {
  return char === '(' || char === '[' || char === '{';
}

function isSourceTextClosingPunctuation(char: string): boolean {
  return (
    char === ')' ||
    char === ']' ||
    char === '}' ||
    char === ',' ||
    char === ';' ||
    char === '!' ||
    char === '?' ||
    char === '.'
  );
}

function isCodeLikeSourceTerm(value: string): boolean {
  if (value.length < 3 || value.length > MAX_SOURCE_TEXT_TERM_LENGTH) return false;
  if (/\s/.test(value)) return false;
  if (/[-_.:/@]/.test(value)) return true;
  if (/[A-Za-z]\d|\d[A-Za-z]/.test(value)) return true;
  return /^[A-Z\d_]+$/.test(value) && /[A-Z]/.test(value);
}

interface CollectFileSourceTextHitsArgs extends SourceTextCandidateArgs {
  filePath: string;
  terms: readonly string[];
  allowedKinds: ReadonlySet<NodeKind>;
  hits: Map<string, SourceTextTermHit>;
}

function collectFileSourceTextHits(args: CollectFileSourceTextHitsArgs): void {
  const absPath = validatePathWithinRootReal(args.projectRoot, args.filePath);
  if (!absPath) return;
  let source: string;
  try {
    source = fs.readFileSync(absPath, 'utf8');
  } catch {
    return;
  }
  for (const term of args.terms) {
    if (!source.includes(term)) continue;
    const line = firstLineContaining(source, term);
    if (line === null) continue;
    const node = findSourceTextOwner({
      queries: args.queries,
      filePath: args.filePath,
      line,
      allowedKinds: args.allowedKinds,
    });
    if (!node) continue;
    const existing = args.hits.get(node.id);
    if (existing) existing.terms.add(term);
    else args.hits.set(node.id, { node, terms: new Set([term]) });
  }
}

function firstLineContaining(source: string, term: string): number | null {
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index++) {
    if (lines[index]!.includes(term)) return index + 1;
  }
  return null;
}

interface FindSourceTextOwnerArgs {
  queries: QueryBuilder;
  filePath: string;
  line: number;
  allowedKinds: ReadonlySet<NodeKind>;
}

function findSourceTextOwner(args: FindSourceTextOwnerArgs): Node | null {
  const { queries, filePath, line, allowedKinds } = args;
  const nodes = queries.getNodesByFile(filePath).filter((node) => allowedKinds.has(node.kind));
  const primary = findEnclosingNodeId(
    nodes.filter((node) => SOURCE_TEXT_PRIMARY_KINDS.has(node.kind)),
    line,
  );
  const fallback = primary ?? findEnclosingNodeId(nodes, line);
  return fallback ? (queries.getNodeById(fallback) ?? null) : null;
}

function findEnclosingNodeId(nodes: readonly Node[], line: number): string | null {
  const scopes = sortScopesBySpan(nodes.map((node) => ({ id: node.id, start: node.startLine, end: node.endLine })));
  return findEnclosingNode(scopes, line);
}
