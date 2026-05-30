/**
 * Cross-file biomarker rule: `duplicate_code` — code-clone detection.
 *
 * Three tiers, all reported under the one `duplicate_code` biomarker:
 *
 *  - **Tier 1 — exact (Type-1) clones.** Symbols with a byte-identical
 *    `body_hash` (`sha256(signature + body)`, migration 048).
 *    Severity `warning`; `detail.cloneType = 'exact'`.
 *  - **Tier 2 — near (Type-2) clones.** Symbols whose *normalised*
 *    token stream is identical — same structure, differing only in
 *    identifiers, literals, comments and whitespace. The body is
 *    parsed, its AST leaves are walked, identifiers fold to `I`,
 *    string/number literals fold to `L`, comments are dropped, and
 *    the resulting token sequence is hashed. Severity `info`
 *    (lower-confidence than exact); `detail.cloneType = 'near'`.
 *  - **Tier 3 — partial (Type-3) near-miss clones.** Symbols whose
 *    leaf-token *multisets* overlap (SourcererCC-style) — catches
 *    added / removed / reordered statements the Tier-2 hash misses.
 *    Two bands: the very-high-overlap band (≥ {@link
 *    DUP_PARTIAL_DEFAULT_OVERLAP}) runs on every pass — an overlap that
 *    high is near-certain to be a real clone; the wider {@link
 *    DUP_PARTIAL_MIN_OVERLAP} band is opt-in (`duplicateCodePartialClones`),
 *    trading precision for recall. Advisory `info`;
 *    `detail.cloneType = 'partial'`.
 *  - **Tier 4 — semantic (Type-4) clones.** Symbols joined by a
 *    high-cosine `similar_to` embedding edge but not caught by a
 *    syntactic tier. Advisory `info`; `detail.cloneType = 'semantic'`.
 *    Silent when the embeddings feature is off.
 *
 * Clones are grouped into a CLASS by normalised hash — exact clones
 * fall inside their near-clone class (an exact match is also a
 * normalised match), so a class is `exact` only when every member
 * shares one `body_hash` and `near` once it spans more than one.
 * Every member of a class gets ONE finding whose `detail.members`
 * names the siblings — never N² pairs.
 *
 * Three false-positive guards (the clone-detection research's clear
 * lesson — a noisy duplication rule gets ignored wholesale, so
 * precision is the adoption gate, not recall):
 *  1. Minimum-size floors — symbols below {@link DUP_MIN_LOC} lines
 *     are skipped entirely (a 3-line forwarder is "duplicated"
 *     everywhere). Near clones face a stricter {@link DUP_NEAR_MIN_LOC}
 *     bar — a small structural match with renamed identifiers is
 *     usually coincidence, not real duplication.
 *  2. Production-only — non-production symbols (test / fixture /
 *     script / benchmark, via `pathCategory`) are dropped before
 *     clone classes form; test boilerplate duplicates legitimately.
 *  3. Config allowlist — `duplicateCodeAllowlist` path globs let a
 *     project silence deliberate duplication (generated delegators).
 */

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import type { QueryBuilder } from '../db/queries.js';
import type { Finding } from './types.js';
import type { Language } from '../types.js';
import type { Node as TsNode } from 'web-tree-sitter';
import { pathCategory } from '../path-class.js';
import { globToSafeRegex, validatePathWithinRootReal } from '../utils.js';
import { loadConfig } from '../config.js';
import { sliceSymbolBody } from '../extraction/symbol-body-hash.js';
import { parseSource } from './engine.js';
import { logDebug } from '../errors.js';

/** Minimum symbol line-span to be eligible at all. Below this,
 *  "duplication" is ubiquitous and meaningless (getters, one-line
 *  forwarders). 6 lines ≈ the smallest block worth de-duplicating. */
const DUP_MIN_LOC = 6;

/** Higher floor for *near* (Type-2) clones. A 6-line structural match
 *  with different names is often coincidence — two small functions of
 *  a common shape — not real duplication; an exact byte match at 6
 *  lines is not. Empirically (run on this repo) a near-floor of 12
 *  cuts the small-shape coincidences while keeping the substantial
 *  near-clones. Exact clones keep the {@link DUP_MIN_LOC} floor. */
const DUP_NEAR_MIN_LOC = 12;

/** Minimum `similar_to` embedding cosine (0.95) for a Tier-4 semantic
 *  clone. High on purpose — Type-4 (behaviourally-similar,
 *  syntactically different) is coincidence-prone, so the rule stays
 *  advisory. */
const DUP_SEMANTIC_MIN_SCORE = 0.95;

/** A body more than this fraction (0.6) string/number literal *by
 *  character span* is excluded from Tier-2 *near* AND Tier-3 *partial* grouping.
 *  Its normalised token stream collapses each literal to a single `L`,
 *  so a literal-dominated body (a SQL / HTML / prompt string builder —
 *  `(clause) => \`…${x}…\``) reduces to a near-empty stream that
 *  collides with every other such builder regardless of the literal's
 *  content. Type-1 (exact `body_hash`) grouping still applies — a
 *  byte-identical match is real at any literal density; only the
 *  structural near / partial match is dropped. */
const DUP_NEAR_MAX_LITERAL_RATIO = 0.6;

/** Cap (10) on sibling members listed in a finding's `detail` — a clone
 *  class of 40 shouldn't write a 40-entry payload onto each member. */
const MAX_LISTED_SIBLINGS = 10;

/** What kind of clone a class represents. `exact`/`near`/`partial`
 *  are syntactic (Tier 1/2/3); `semantic` is embedding-derived
 *  (Tier 4). */
type CloneType = 'exact' | 'near' | 'partial' | 'semantic';

/** Token-multiset overlap at or above which two bodies are a `partial`
 *  (Type-3) clone. SourcererCC reports 0.70 as its precision/recall
 *  optimum; 0.80 here is deliberately stricter — Tier 3 is the opt-in,
 *  FP-prone tier, so it leans on precision over recall. Empirically
 *  0.80 surfaced ~140 partial clones on this repo; 0.70 was far
 *  noisier. Tier 3 only; opt-in. */
const DUP_PARTIAL_MIN_OVERLAP = 0.8;

/** Overlap threshold (0.95) for the ALWAYS-ON partial-clone band. A token-
 *  multiset overlap this high is near-certain to be a real clone — a
 *  genuine near-miss the Tier-2 exact-near hash missed only on a
 *  trivial statement-level difference (an extracted intermediate var,
 *  a reordered line). High enough to run on every pass without the FP
 *  cost of the {@link DUP_PARTIAL_MIN_OVERLAP} opt-in band. */
const DUP_PARTIAL_DEFAULT_OVERLAP = 0.95;

/** Minimal union-find over string ids — clusters clone pairs into
 *  connected components. Iterative `find` (no recursion-depth risk). */
class UnionFind {
  private readonly parent = new Map<string, string>();

  private root(x: string): string {
    let r = x;
    while (this.parent.get(r) !== undefined && this.parent.get(r) !== r) {
      r = this.parent.get(r)!;
    }
    // Path-compress.
    let cur = x;
    while (cur !== r) {
      const next = this.parent.get(cur) ?? cur;
      this.parent.set(cur, r);
      cur = next;
    }
    return r;
  }

  union(a: string, b: string): void {
    if (!this.parent.has(a)) this.parent.set(a, a);
    if (!this.parent.has(b)) this.parent.set(b, b);
    const ra = this.root(a);
    const rb = this.root(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }

  /** Connected components — only ids that were `union`'d appear. */
  components(): string[][] {
    const out = new Map<string, string[]>();
    for (const x of this.parent.keys()) {
      const r = this.root(x);
      const g = out.get(r);
      if (g) g.push(x);
      else out.set(r, [x]);
    }
    return [...out.values()];
  }
}

interface CandidateRow {
  nodeId: string;
  bodyHash: string;
  name: string;
  language: string;
  filePath: string;
  startLine: number;
  endLine: number;
}

/**
 * Pull function / method symbols that clear the size floor and carry
 * a real `body_hash` (the column defaults to '' for body-less nodes,
 * so `!= ''` excludes declaration-only symbols).
 */
function selectCandidates(queries: QueryBuilder): CandidateRow[] {
  const sql = `
    SELECT id         AS nodeId,
           body_hash  AS bodyHash,
           name       AS name,
           language   AS language,
           file_path  AS filePath,
           start_line AS startLine,
           end_line   AS endLine
    FROM nodes
    WHERE body_hash != ''
      AND kind IN ('function', 'method')
      AND (end_line - start_line + 1) >= ?
  `;
  return queries.db.prepare(sql).all(DUP_MIN_LOC) as CandidateRow[];
}

/** Build the allowlist predicate from `duplicateCodeAllowlist` globs.
 *  Returns a function — `true` = exempt. Invalid globs are skipped. */
function buildAllowlistPredicate(globs: string[]): (filePath: string) => boolean {
  if (globs.length === 0) return () => false;
  const regexes: RegExp[] = [];
  for (const g of globs) {
    const src = globToSafeRegex(g);
    // Fully anchor — an unanchored `b.ts` glob would otherwise also
    // exempt `ab.ts`. `**` still spans subdirectories via `.*`.
    if (src) regexes.push(new RegExp(`^${src}$`));
  }
  if (regexes.length === 0) return () => false;
  return (filePath) => regexes.some((re) => re.test(filePath));
}

/**
 * Classify one AST leaf into a token:
 *  - identifier → `i:<text>` — the name is KEPT. Tier 3's overlap
 *    needs it (two unrelated functions made of `I`-shaped statements
 *    overlap ~100%; keeping names makes overlap a real signal). The
 *    Tier-2 hash folds `i:*` → `I` itself, in {@link hashTokens}, for
 *    rename-insensitivity.
 *  - string / number literal → `L` — values fold away (both tiers
 *    tolerate literal differences).
 *  - comment → dropped (`null`).
 *  - anything else (keywords, operators, punctuation) → the node type
 *    verbatim; for anonymous tree-sitter nodes that IS the literal
 *    text, so structure is preserved.
 * Deliberately approximate — consistency (identical bodies → identical
 * tokens) matters, not perfect per-language categorisation.
 */
function leafToken(node: TsNode): string | null {
  const type = node.type;
  if (/comment/i.test(type)) return null;
  if (/identifier/i.test(type)) return `i:${node.text}`;
  if (/string|number|integer|float|char|rune|numeric/i.test(type)) return 'L';
  return type;
}

/** Walk every AST leaf in source order, returning the token stream
 *  plus the total character span of literal (`L`) leaves — the latter
 *  feeds the {@link DUP_NEAR_MAX_LITERAL_RATIO} guard.
 *  Iterative to stay clear of deep-recursion limits on large bodies. */
function collectLeafTokens(root: TsNode): { tokens: string[]; literalChars: number } {
  const tokens: string[] = [];
  let literalChars = 0;
  const stack: TsNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    // B16 (2026-05-23) — bulk `children` over indexed `child(i)`
    // (the namedChild Schlemiel fix shape from B14). Reverse-iterate
    // the JS array so popped items come out in source order.
    const kids = node.children;
    if (kids.length === 0) {
      const tok = leafToken(node);
      if (tok !== null) {
        tokens.push(tok);
        // B16 (2026-05-23) — avoid the WASM string-copy of `node.text`
        // just to read its length. `endIndex - startIndex` is the
        // byte span (a different metric than UTF-16 code units, but
        // strictly more meaningful for the literal-density ratio —
        // multi-byte literals don't unfairly inflate the count) AND
        // it's a single in-WASM property read with no string alloc.
        // The ratio threshold tolerates the metric shift; tests pin
        // the contract.
        if (tok === 'L') literalChars += node.endIndex - node.startIndex;
      }
      continue;
    }
    // Push children in reverse so they pop in source order.
    for (let i = kids.length - 1; i >= 0; i--) {
      const child = kids[i];
      if (child) stack.push(child);
    }
  }
  return { tokens, literalChars };
}

/** Parsed view of one symbol body — the leaf-token stream plus the
 *  fraction of the body's characters that sit inside string/number
 *  literals (see {@link DUP_NEAR_MAX_LITERAL_RATIO}). */
interface BodyTokenization {
  tokens: string[];
  literalRatio: number;
}

/**
 * Parse `body` and return its leaf-token stream (source order) plus its
 * literal-character ratio. Returns `null` when the language has no
 * loaded parser or the body yields no tokens — the caller then falls
 * back to exact-only grouping. The stream backs both the Tier-2 hash
 * ({@link hashTokens}, which folds identifier names) and the Tier-3
 * multiset (which keeps them).
 */
function leafTokensFor(body: string, language: string): BodyTokenization | null {
  let tree: ReturnType<typeof parseSource> | undefined;
  try {
    tree = parseSource(body, language as Language);
  } catch (err) {
    logDebug('duplicate_code: parse failed', { language, err: String(err) });
    return null;
  }
  if (!tree) return null;
  const { tokens, literalChars } = collectLeafTokens(tree.rootNode);
  if (tokens.length === 0) return null;
  return { tokens, literalRatio: body.length > 0 ? literalChars / body.length : 0 };
}

/**
 * Hash a leaf-token stream into the Tier-2 grouping key. Folds
 * identifier tokens (`i:<name>`) to a single `I` so renamed clones
 * collide; order-sensitive, so a statement reorder changes the hash
 * (Tier 3's multiset overlap is what catches reordered clones).
 */
function hashTokens(tokens: string[]): string {
  const folded = tokens.map((t) => (t.startsWith('i:') ? 'I' : t));
  return crypto.createHash('sha256').update(folded.join(' ')).digest('hex').slice(0, 32);
}

/** Token multiset (token → occurrence count) for Tier-3 overlap. */
function tokenMultiset(tokens: string[]): Map<string, number> {
  const ms = new Map<string, number>();
  for (const t of tokens) ms.set(t, (ms.get(t) ?? 0) + 1);
  return ms;
}

/**
 * Size of the multiset intersection `|A ∩ B|` — the sum of
 * `min(count_A, count_B)` over every shared token. Iterates the
 * smaller map (the intersection is symmetric) and lets a missing
 * lookup contribute zero, so the loop body stays branch-free.
 */
function multisetIntersectionSize(a: Map<string, number>, b: Map<string, number>): number {
  const small = a.size <= b.size ? a : b;
  const large = a.size <= b.size ? b : a;
  let inter = 0;
  for (const [tok, count] of small) {
    inter += Math.min(count, large.get(tok) ?? 0);
  }
  return inter;
}

/** A token multiset paired with its precomputed element count. */
interface SizedMultiset {
  multiset: Map<string, number>;
  total: number;
}

/**
 * SourcererCC-style overlap similarity of two token multisets:
 * `|A ∩ B| / max(|A|, |B|)`. 1.0 = identical multiset; 0 = disjoint.
 */
function overlapRatio(a: SizedMultiset, b: SizedMultiset): number {
  return multisetIntersectionSize(a.multiset, b.multiset) / Math.max(a.total, b.total);
}

/**
 * Read each candidate's body text. Files are read once and shared
 * across all candidates that live in them. Returns a map keyed by
 * nodeId; a candidate whose file can't be read is simply absent.
 */
function readBodies(projectRoot: string, candidates: CandidateRow[]): Map<string, string> {
  const bodies = new Map<string, string>();
  const byFile = new Map<string, CandidateRow[]>();
  for (const c of candidates) {
    const group = byFile.get(c.filePath);
    if (group) group.push(c);
    else byFile.set(c.filePath, [c]);
  }
  for (const [relPath, rows] of byFile) {
    const abs = validatePathWithinRootReal(projectRoot, relPath);
    if (!abs) continue;
    let lines: string[];
    try {
      lines = fs.readFileSync(abs, 'utf8').split('\n');
    } catch (err) {
      logDebug('duplicate_code: read failed', { filePath: relPath, err: String(err) });
      continue;
    }
    for (const r of rows) {
      bodies.set(r.nodeId, sliceSymbolBody(lines, r.startLine, r.endLine));
    }
  }
  return bodies;
}

/** Render the per-member `detail` payload for a clone-class finding. */
function buildDetail(member: CandidateRow, members: CandidateRow[], cloneType: CloneType): unknown {
  return {
    name: member.name,
    cloneType,
    cloneClassSize: members.length,
    loc: member.endLine - member.startLine + 1,
    members: members
      .filter((m) => m.nodeId !== member.nodeId)
      .slice(0, MAX_LISTED_SIBLINGS)
      .map((s) => ({ name: s.name, location: `${s.filePath}:${s.startLine}` })),
  };
}

/**
 * Tier 3 — partial (Type-3) near-miss clones, at a caller-supplied
 * `minOverlap`. `findDuplicateCode` runs it twice: the very-high-overlap
 * band ({@link DUP_PARTIAL_DEFAULT_OVERLAP}) on every pass, the wider
 * FP-prone band ({@link DUP_PARTIAL_MIN_OVERLAP}) only when
 * `duplicateCodePartialClones` is set.
 *
 * For each in-scope candidate the leaf-token stream is reduced to a
 * multiset (identifier names KEPT — see {@link leafToken}); two
 * candidates whose multiset overlap (see {@link overlapRatio}) is ≥
 * `minOverlap` are a partial-clone pair. Because overlap is
 * order-insensitive this also catches statement reorders the Tier-2
 * hash misses.
 *
 * A finding is emitted per node that has ≥1 *direct* partial-clone
 * neighbour; `detail.members` lists those neighbours. Deliberately
 * NOT transitive — the Type-3 relation isn't an equivalence (A~B,
 * B~C does not imply A~C), so union-find components would sprawl a
 * chain into one misleading "class".
 *
 * Two cost / precision controls:
 *  - Only candidates ≥ {@link DUP_NEAR_MIN_LOC} lines and NOT already
 *    flagged by a syntactic tier are considered.
 *  - Comparisons are windowed: candidates are bucketed by language and
 *    sorted by token count; since overlap ≥ t forces the size ratio
 *    ≥ t, each candidate is only compared against the few whose token
 *    count is within `1 / t` of its own.
 */
interface PartialItem extends SizedMultiset {
  candidate: CandidateRow;
}

/** Inputs to one partial-clone pass. */
interface FindPartialClonesArgs {
  candidates: CandidateRow[];
  tokensById: Map<string, string[]>;
  /** nodeIds already claimed by an earlier tier — skipped as candidates. */
  flagged: Set<string>;
  /** Token-multiset overlap at or above which two bodies link as clones. */
  minOverlap: number;
}

function findPartialClones(args: FindPartialClonesArgs): Finding[] {
  const { candidates, tokensById, flagged, minOverlap } = args;
  // Bucket eligible candidates by language.
  const byLang = new Map<string, PartialItem[]>();
  for (const c of candidates) {
    if (flagged.has(c.nodeId)) continue;
    if (c.endLine - c.startLine + 1 < DUP_NEAR_MIN_LOC) continue;
    const tokens = tokensById.get(c.nodeId);
    if (!tokens) continue;
    const item: PartialItem = { candidate: c, multiset: tokenMultiset(tokens), total: tokens.length };
    const g = byLang.get(c.language);
    if (g) g.push(item);
    else byLang.set(c.language, [item]);
  }

  // Direct-neighbour adjacency — nodeId → set of partial-clone peers.
  const neighbours = new Map<string, Set<string>>();
  const byId = new Map<string, CandidateRow>();
  const link = (x: string, y: string): void => {
    const set = neighbours.get(x);
    if (set) set.add(y);
    else neighbours.set(x, new Set([y]));
  };
  for (const items of byLang.values()) {
    items.sort((x, y) => x.total - y.total);
    for (let i = 0; i < items.length; i++) {
      const a = items[i]!;
      byId.set(a.candidate.nodeId, a.candidate);
      for (let j = i + 1; j < items.length; j++) {
        const b = items[j]!;
        // Sorted ascending: once b is too large for the size ratio to
        // permit a ≥-threshold overlap, no later j can either.
        if (b.total > a.total / minOverlap) break;
        if (overlapRatio(a, b) >= minOverlap) {
          link(a.candidate.nodeId, b.candidate.nodeId);
          link(b.candidate.nodeId, a.candidate.nodeId);
        }
      }
    }
  }

  const findings: Finding[] = [];
  for (const [nodeId, peers] of neighbours) {
    const member = byId.get(nodeId)!;
    // The "class" for this finding is the node plus its direct peers.
    const classMembers = [member, ...[...peers].map((id) => byId.get(id)!)];
    findings.push({
      nodeId,
      biomarker: 'duplicate_code' as const,
      severity: 'info' as const,
      metric: member.endLine - member.startLine + 1,
      detail: buildDetail(member, classMembers, 'partial'),
    });
  }
  return findings;
}

/**
 * Tier 4 — semantic (Type-4) clones. Consumes the opt-in `similar_to`
 * embedding-cosine edges: candidates joined by a `similar_to` edge
 * scoring ≥ {@link DUP_SEMANTIC_MIN_SCORE} are clustered into a
 * semantic clone class. Advisory only (`info`) — high embedding
 * similarity is suggestive, not proof. Silent when no `similar_to`
 * edges exist (the embeddings feature is off). Pairs where either
 * end was already flagged by a syntactic tier are skipped — Tier 4
 * only fills the gaps the hash-based tiers cannot see.
 */
function findSemanticClones(queries: QueryBuilder, byId: Map<string, CandidateRow>, flagged: Set<string>): Finding[] {
  const rows = queries.db
    .prepare(
      `SELECT e.source AS src, e.target AS tgt,
              CAST(json_extract(e.metadata, '$.score') AS REAL) AS score
       FROM edges e
       WHERE e.kind = 'similar_to'`,
    )
    .all() as Array<{ src: string; tgt: string; score: number | null }>;

  const uf = new UnionFind();
  for (const r of rows) {
    // `similar_to` edge `score` is a cosine similarity in [-1, 1]
    // (see embeddings/similar-edges.ts). Skip out-of-range scores —
    // a stale index written by a pre-fix `build-similarity-edges`
    // pass persisted the raw HNSW 'ip' dot product (~50..230), which
    // would otherwise sail past the `DUP_SEMANTIC_MIN_SCORE` (0.95)
    // gate and flag nearly every semantic-edge pair as a clone.
    if (r.score === null || r.score < DUP_SEMANTIC_MIN_SCORE || r.score > 1) continue;
    if (r.src === r.tgt) continue;
    // Both ends must be in-scope candidates (production, ≥ floor) and
    // not already covered by a syntactic finding.
    if (!byId.has(r.src) || !byId.has(r.tgt)) continue;
    if (flagged.has(r.src) || flagged.has(r.tgt)) continue;
    uf.union(r.src, r.tgt);
  }

  const findings: Finding[] = [];
  for (const ids of uf.components()) {
    if (ids.length < 2) continue;
    const members = ids.map((id) => byId.get(id)!);
    for (const member of members) {
      findings.push({
        nodeId: member.nodeId,
        biomarker: 'duplicate_code' as const,
        severity: 'info' as const,
        metric: member.endLine - member.startLine + 1,
        detail: buildDetail(member, members, 'semantic'),
      });
    }
  }
  return findings;
}

/** Production, non-allowlisted function / method symbols above the size
 *  floor — the candidate set every clone tier draws from. */
function eligibleCandidates(queries: QueryBuilder, config: ReturnType<typeof loadConfig>): CandidateRow[] {
  const isAllowlisted = buildAllowlistPredicate(config.duplicateCodeAllowlist ?? []);
  return selectCandidates(queries).filter(
    (c) => pathCategory(c.filePath) === 'production' && !isAllowlisted(c.filePath),
  );
}

/** The normalised leaf-token stream per candidate, plus the set of
 *  candidates whose body is literal-dominated (see
 *  DUP_NEAR_MAX_LITERAL_RATIO) and so must stay out of near grouping. */
interface TokenizedCandidates {
  tokensById: Map<string, string[]>;
  literalHeavy: Set<string>;
}

/** Parse every candidate body once — the token stream feeds both the
 *  Tier-2 hash and the Tier-3 multiset; the literal-heavy set feeds the
 *  density guard. Candidates with no parser / unreadable file are
 *  simply absent from the map. */
function tokenizeCandidates(projectRoot: string, candidates: CandidateRow[]): TokenizedCandidates {
  const bodies = readBodies(projectRoot, candidates);
  const tokensById = new Map<string, string[]>();
  const literalHeavy = new Set<string>();
  for (const c of candidates) {
    const body = bodies.get(c.nodeId);
    if (body === undefined) continue;
    const parsed = leafTokensFor(body, c.language);
    if (!parsed) continue;
    tokensById.set(c.nodeId, parsed.tokens);
    if (parsed.literalRatio > DUP_NEAR_MAX_LITERAL_RATIO) literalHeavy.add(c.nodeId);
  }
  return { tokensById, literalHeavy };
}

/**
 * Bucket candidates into Tier-1/2 clone classes. The key is the
 * normalised-token hash (`n:`) when a usable, non-literal-heavy token
 * stream exists; otherwise an exact-`body_hash` fallback (`x:`) so the
 * symbol can still join a Tier-1 class but never a near one.
 */
function bucketSyntacticClasses(
  candidates: CandidateRow[],
  { tokensById, literalHeavy }: TokenizedCandidates,
): Map<string, CandidateRow[]> {
  const byClass = new Map<string, CandidateRow[]>();
  for (const c of candidates) {
    const tokens = tokensById.get(c.nodeId);
    const key = tokens && !literalHeavy.has(c.nodeId) ? `n:${hashTokens(tokens)}` : `x:${c.bodyHash}`;
    const group = byClass.get(key);
    if (group) group.push(c);
    else byClass.set(key, [c]);
  }
  return byClass;
}

/** True once a member set spans more than one `body_hash` — i.e. at
 *  least one pair differs only after normalisation (a near clone). */
function spansMultipleHashes(members: CandidateRow[]): boolean {
  return new Set(members.map((m) => m.bodyHash)).size > 1;
}

/**
 * Apply the size floor to one bucketed class and emit a finding per
 * surviving member. Near classes (spanning >1 body_hash) face the
 * stricter DUP_NEAR_MIN_LOC bar; exact classes keep DUP_MIN_LOC. The
 * clone type is re-derived after the floor filter — dropping sub-floor
 * members can collapse a near class back to one body_hash. A class
 * that falls below two members after filtering yields nothing.
 */
/**
 * Apply the size floor + finding-emission step to one bucket.
 *
 * A bucket from {@link bucketSyntacticClasses} groups members that
 * share a normalised-token hash (`n:`), which intentionally folds
 * identifier names to catch renamed clones. That has a side effect:
 * a renamed-clone bucket can ALSO contain a byte-identical (exact)
 * sub-group — e.g. two literal copies of `fileExists` may share a
 * bucket with `dirExists` because all three normalise to the same
 * structural fingerprint.
 *
 * Pre-fix the bucket was treated as a single class — the exact
 * sub-group got diluted, the bucket spanned multiple body_hashes,
 * and the stricter `DUP_NEAR_MIN_LOC` floor filtered every member
 * out, silently dropping the exact clones. The fix is to peel off
 * exact clones (members sharing a `body_hash`) first under the
 * `DUP_MIN_LOC` floor, then run the remainder through the near
 * pass.
 */
function emitClassFindings(members: CandidateRow[]): Finding[] {
  if (members.length < 2) return [];

  const findings: Finding[] = [];
  const exactClaimed = new Set<string>();

  // Pass 1 — peel off exact clones (byte-identical body_hash) under
  // the lower DUP_MIN_LOC floor. A bucket can contain multiple
  // exact sub-groups (e.g. two distinct sets of byte-identical
  // bodies that all normalise to the same token stream); each
  // sub-group ≥ 2 members produces its own findings.
  const byBodyHash = new Map<string, CandidateRow[]>();
  for (const m of members) {
    const g = byBodyHash.get(m.bodyHash);
    if (g) g.push(m);
    else byBodyHash.set(m.bodyHash, [m]);
  }
  for (const exactGroup of byBodyHash.values()) {
    if (exactGroup.length < 2) continue;
    const kept = exactGroup.filter((m) => m.endLine - m.startLine + 1 >= DUP_MIN_LOC);
    if (kept.length < 2) continue;
    for (const m of kept) {
      exactClaimed.add(m.nodeId);
      findings.push({
        nodeId: m.nodeId,
        biomarker: 'duplicate_code' as const,
        severity: 'warning' as const,
        metric: m.endLine - m.startLine + 1,
        detail: buildDetail(m, kept, 'exact'),
      });
    }
  }

  // Pass 2 — near clones across the remainder. Members already
  // claimed by an exact sub-group above are dropped first; the
  // residue is treated as a normal near class if it still has ≥ 2
  // members AND spans multiple body_hashes (i.e. is genuinely a
  // "renamed" clone class rather than the leftover of an exact
  // group). The DUP_NEAR_MIN_LOC floor still applies.
  const residue = members.filter((m) => !exactClaimed.has(m.nodeId));
  if (residue.length < 2) return findings;
  if (!spansMultipleHashes(residue)) return findings;
  const nearKept = residue.filter((m) => m.endLine - m.startLine + 1 >= DUP_NEAR_MIN_LOC);
  if (nearKept.length < 2) return findings;
  for (const m of nearKept) {
    findings.push({
      nodeId: m.nodeId,
      biomarker: 'duplicate_code' as const,
      severity: 'info' as const,
      metric: m.endLine - m.startLine + 1,
      detail: buildDetail(m, nearKept, 'near'),
    });
  }
  return findings;
}

/**
 * Tier 3 — partial-clone passes over symbols no Tier-1/2 class caught.
 * The very-high-overlap band (DUP_PARTIAL_DEFAULT_OVERLAP) runs on
 * every pass — an overlap that high is near-certain to be a real
 * clone. The wider, FP-prone DUP_PARTIAL_MIN_OVERLAP band is opt-in
 * (`duplicateCodePartialClones`) and runs with the default band's hits
 * already excluded, so it only adds the lower-confidence [0.80, 0.95)
 * tier. Literal-dominated bodies are excluded from both bands — the
 * partial tier reads the same `L`-folded multiset the
 * DUP_NEAR_MAX_LITERAL_RATIO guard protects the near tier from.
 */
/** Inputs to the Tier-3 partial-clone collection step. */
interface CollectPartialFindingsArgs {
  candidates: CandidateRow[];
  tokenized: TokenizedCandidates;
  /** Findings from Tiers 1–2; their nodeIds are excluded as candidates. */
  syntacticFindings: Finding[];
  /** When true, also run the wider, FP-prone opt-in overlap band. */
  partialClonesEnabled: boolean;
}

function collectPartialFindings(args: CollectPartialFindingsArgs): Finding[] {
  const { candidates, tokenized, syntacticFindings, partialClonesEnabled } = args;
  const { tokensById, literalHeavy } = tokenized;
  const out: Finding[] = [];
  const flaggedSyntactic = new Set([...syntacticFindings.map((f) => f.nodeId), ...literalHeavy]);
  out.push(
    ...findPartialClones({
      candidates,
      tokensById,
      flagged: flaggedSyntactic,
      minOverlap: DUP_PARTIAL_DEFAULT_OVERLAP,
    }),
  );
  if (partialClonesEnabled) {
    const flaggedSoFar = new Set([
      ...syntacticFindings.map((f) => f.nodeId),
      ...out.map((f) => f.nodeId),
      ...literalHeavy,
    ]);
    out.push(
      ...findPartialClones({
        candidates,
        tokensById,
        flagged: flaggedSoFar,
        minOverlap: DUP_PARTIAL_MIN_OVERLAP,
      }),
    );
  }
  return out;
}

/** Public entry point used by the cross-file biomarker registry.
 *  Composes the four clone tiers; each phase lives in its own helper. */
export function findDuplicateCode(queries: QueryBuilder, projectRoot: string): Finding[] {
  const config = loadConfig(projectRoot);
  const candidates = eligibleCandidates(queries, config);
  const tokenized = tokenizeCandidates(projectRoot, candidates);

  // Tier 1 + 2 — exact and near classes from the normalised hash.
  const findings: Finding[] = [];
  for (const members of bucketSyntacticClasses(candidates, tokenized).values()) {
    findings.push(...emitClassFindings(members));
  }

  // Tier 3 — partial (near-miss) clones for symbols no class caught.
  findings.push(
    ...collectPartialFindings({
      candidates,
      tokenized,
      syntacticFindings: findings,
      partialClonesEnabled: !!config.duplicateCodePartialClones,
    }),
  );

  // Tier 4 — semantic clones for symbols no earlier tier flagged.
  const flagged = new Set(findings.map((f) => f.nodeId));
  const byId = new Map(candidates.map((c) => [c.nodeId, c]));
  findings.push(...findSemanticClones(queries, byId, flagged));
  return findings;
}
