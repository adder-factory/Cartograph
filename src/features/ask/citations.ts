import type Cartograph from '../../index.js';
import { displayModelName } from '../../llm/display-model.js';
import type { AskResult } from '../../llm/ask.js';
import { pathCategory } from '../../path-class.js';
import { findSignatureTokenOwner, getNodesByName, searchNodes } from '../../db/queries-search.js';
import type { SearchResult } from '../../types.js';

/**
 * Language literals and reserved keywords that an LLM answer routinely
 * wraps in backticks ("the function returns `null`", "defaults to
 * `undefined`"). They are reserved words / special globals in every
 * language cartograph primarily targets, so they are virtually never a
 * user-defined symbol — verifying them just emits a noise "⚠ Unverified
 * mention" for every `null` the model writes. Filtering them out of
 * citation extraction removes that noise.
 *
 * Trade-off: a token listed here is simply not verified — it gets
 * neither a ✓ nor a ⚠. The one realistic false-negative is a Rust
 * project with a user-defined `None` variant (`enum E { None }` indexes
 * `None` as an `enum_member`): a genuine `None` citation is silently
 * dropped rather than confirmed. That is an acceptable price for
 * killing the literal noise on every other answer.
 *
 * Case-sensitive: `null`/`true`/`false`/`this`/`super`/`void` are JS
 * reserved words and `undefined`/`NaN`/`Infinity` are special globals;
 * `None`/`True`/`False` (Python) and `nil` (Go / Ruby / Lua / Swift)
 * cover the other indexed languages.
 */
const NON_SYMBOL_TOKENS: ReadonlySet<string> = new Set([
  'null',
  'undefined',
  'true',
  'false',
  'this',
  'super',
  'void',
  'NaN',
  'Infinity',
  'None',
  'True',
  'False',
  'nil',
]);

/**
 * Well-known JS/TS stdlib global objects. A backtick-quoted *qualified*
 * cite whose leftmost segment is one of these (`Math.max`, `Object.keys`,
 * `JSON.stringify`, `Array.isArray`, …) is a language builtin, never a
 * user-defined symbol — verifying it just dumps it into the "⚠
 * Unverified" bucket and reads as a hallucination warning. Matched on
 * the qualifier root only, so a project symbol like `Math` (bare) still
 * verifies, and a member like `Mathutils.clamp` is unaffected (root is
 * `Mathutils`, not `Math`).
 */
const STDLIB_GLOBAL_ROOTS: ReadonlySet<string> = new Set([
  'Math',
  'Object',
  'Array',
  'JSON',
  'Number',
  'String',
  'Boolean',
  'Date',
  'RegExp',
  'Promise',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Symbol',
  'Reflect',
  'Error',
  'console',
]);

/**
 * True when `id` is a qualified reference rooted at a stdlib global
 * (`Math.max`, `Object.keys`, `JSON.stringify`). Only fires on a
 * dotted/`::`-qualified name — a bare `Math` is left alone so a genuine
 * user-defined `Math` symbol still verifies.
 */
function isStdlibQualifiedGlobal(id: string): boolean {
  const sepMatch = /[.:]/.exec(id);
  if (!sepMatch) return false;
  return STDLIB_GLOBAL_ROOTS.has(id.slice(0, sepMatch.index));
}

/**
 * Pull every backtick-quoted identifier-shaped token out of an LLM
 * answer text. Used to verify cited symbol names against the index —
 * anything matching this regex is a candidate for "is this a real
 * symbol or a hallucination?".
 *
 * Identifier shape: starts with a letter or underscore; allows
 * letters / digits / underscores; optionally extended by `.` or `::`
 * for qualified names. Excludes things that are clearly NOT
 * identifiers by anchoring strictly between the backticks, plus
 * language literals / keywords via {@link NON_SYMBOL_TOKENS}.
 *
 * Deduped, case-sensitive — `Foo` and `foo` are tracked separately.
 */
function extractCitedIdentifiers(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /`([A-Za-z_]\w*(?:(?:\.|::)[A-Za-z_]\w*)*)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const id = m[1]!;
    // Don't bother verifying single-letter cites — common false
    // matches (`a`, `x`, `T`) and they're rarely informative.
    if (id.length < 2) continue;
    // Language literals / keywords (`null`, `undefined`, `True`, `nil`…)
    // are not symbols — skip so they never reach the unverified bucket.
    if (NON_SYMBOL_TOKENS.has(id)) continue;
    // Qualified stdlib globals (`Math.max`, `Object.keys`, `JSON.stringify`)
    // are language builtins — never a user-defined symbol; skip so they
    // don't land in the "⚠ Unverified / could be hallucinated" bucket.
    if (isStdlibQualifiedGlobal(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * File-path patterns that mark a node as living in a distribution /
 * build artifact rather than primary source. Used by `groundCitations`
 * to down-rank hits before committing to a verified citation.
 *
 * Patterns checked (in order):
 *   - `publish.js` or `publish.min.js` at the project root
 *   - Any path under `dist/`, `build/`, `out/` (matches anywhere so
 *     workspace-nested builds like `packages/foo/dist/` are error_)
 *   - `bin/` ONLY at the project root — nested `src/bin/` is a
 *     canonical source layout for CLI entry points (cartograph itself
 *     keeps `src/bin/cartograph.ts` there); matching it would
 *     misclassify legitimate source as a build artifact.
 *   - Paths whose filename ends in `.min.js` or `.bundle.js`
 */
const DIST_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:^|\/)publish\.js$/,
  /(?:^|\/)dist\//,
  /(?:^|\/)build\//,
  /^bin\//,
  /(?:^|\/)out\//,
  /\.min\.js$/,
  /\.bundle\.js$/,
];

/**
 * Return true when `filePath` looks like a distribution / build
 * artifact rather than primary source code.
 *
 * Exported so the test suite can verify the predicate directly.
 */
export function isDistributionPath(filePath: string): boolean {
  return DIST_PATH_PATTERNS.some((re) => re.test(filePath));
}

/**
 * The kinds that `searchNodes` tends to skip or bury for short,
 * common names. When the primary search misses, a secondary
 * `getNodesByName` pass with no kind filter surfaces these.
 */
const SECONDARY_KINDS: ReadonlySet<string> = new Set(['parameter', 'property', 'field']);

/**
 * Node kinds that the secondary `getNodesByName` pass must NOT report
 * as a verified citation. An `import` node carries the *imported*
 * symbol's name, and a `file` node carries the file's basename — when
 * an LLM answer cites `foo` and the only exact-name hit is the
 * `import { foo }` node (or a `foo.ts` file node), grounding it as a
 * "✓ verified citation — import" mis-attributes the cite to a
 * re-export shell rather than the real definition. Such a hit is
 * skipped; grounding falls through to the signature pass / unverified
 * bucket instead.
 */
const NON_DEFINITION_KINDS: ReadonlySet<string> = new Set(['import', 'file']);

export interface CitedIdentifier {
  name: string;
  /**
   * Resolved node info. When the match came from a SECONDARY_KINDS
   * lookup, `parentSymbol` holds the container's name (e.g. the
   * method whose parameter this is).
   */
  node?: {
    name: string;
    kind: string;
    filePath: string;
    startLine: number;
    /** Present when the match is a field / parameter / property kind. */
    parentSymbol?: string;
  };
  /**
   * True when the best match lives in a distribution/build path — the
   * citation is still recorded but displayed with a `?` label and a
   * warning note.
   */
  distPathMatch?: boolean;
  /**
   * Set when the identifier is NOT an indexed node itself but appears
   * verbatim in another symbol's `signature` — typically a function
   * parameter or destructured local, which cartograph does not index as
   * standalone nodes. Holds the owning symbol for display. Such a
   * citation is real code, NOT a hallucination — distinct from both a
   * verified `node` and a suspect unverified mention.
   */
  signatureOwner?: { name: string; kind: string; filePath: string; startLine: number };
  /**
   * True when the resolved `node` is the only match and it lives in a
   * non-production path (fixture / test / script / benchmark). For a
   * short parameter-shaped cite this is very likely a coincidental
   * name collision, not the symbol the answer meant — the renderer
   * shows it with a `?` hedge instead of a confident `✓`.
   */
  weakNonProdMatch?: boolean;
}

/**
 * Parameter-shaped cite: a short, unqualified, lowercase-initial
 * identifier (`value`, `min`, `max`, `idx`). These are the names most
 * prone to a coincidental exact-name hit in an unrelated fixture/spike
 * file — when the only match for one of these is non-production code,
 * the citation is downgraded from a confident `✓`.
 */
function isParameterShapedName(id: string): boolean {
  return !/[.:]/.test(id) && id.length <= 12 && /^[a-z]/.test(id);
}

/** True when a path is non-production code (fixture / test / script /
 *  benchmark) — the buckets a coincidental short-name hit lands in. */
function isNonProductionPath(filePath: string): boolean {
  return pathCategory(filePath) !== 'production';
}

/**
 * Leaf-kind node kinds — `constant` / `variable`. A short
 * parameter-shaped cite (`min`, `max`, `value`) that resolves by
 * exact name to one of these is almost never the symbol the answer
 * meant: the answer is describing a *parameter of a function*, and a
 * coincidental top-level `const min` (even in a production file) is a
 * false confident match. Such a cite is hedged regardless of the path
 * category — see groundCitations (friction audit-4 #2).
 */
const LEAF_NODE_KINDS = new Set(['constant', 'variable']);

/**
 * Pick the best node from a top-K candidate list for `groundCitations`.
 *
 * Selection order:
 *   1. Non-dist paths win over dist paths.
 *   2. Among non-dist: production-path candidates win over non-production
 *      (fixture / test / script / benchmark) candidates — always, not only
 *      for parameter-shaped names. When a production candidate exists,
 *      returning a non-production one (e.g. a private mock file) with a
 *      confident ✓ is misleading even for PascalCase public-API names.
 *   3. Among the winning tier: prefer higher centrality (fall back to first).
 *   4. If every candidate is dist-path: return the first with a
 *      `distPathMatch` flag so the renderer can use a softer label.
 *   5. If `productionOnly` is set and no production candidate exists,
 *      return null (caller will try a fallback path).
 */
function pickBestCandidate(
  hits: ReadonlyArray<SearchResult>,
  name: string,
  opts?: { productionOnly?: boolean },
): CitedIdentifier | null {
  // Only keep hits whose node.name is exactly the cited name, and
  // exclude `import` / `file` nodes — those carry a name they don't
  // define, so grounding a cite to one mis-attributes it (a cited
  // `foo` resolving to `import { foo }` should not read as a verified
  // definition). See NON_DEFINITION_KINDS.
  const exact = hits.filter((h) => h.node.name === name && !NON_DEFINITION_KINDS.has(h.node.kind));
  if (exact.length === 0) return null;

  let nonDist = exact.filter((h) => !isDistributionPath(h.node.filePath));

  // Always prefer production-path candidates over non-production ones
  // (fixture / test / script / benchmark). This covers ALL names — not only
  // parameter-shaped ones — because a symbol like `JoinHandle` resolving to
  // a private mock file with a confident ✓ is wrong regardless of name shape.
  // `productionOnly` is the "must-have-production or return null" strict mode
  // used by the parameter-shaped recovery path; the default mode here falls
  // back to non-production only when NO production candidate exists.
  const prodCandidates = nonDist.filter((h) => !isNonProductionPath(h.node.filePath));
  if (opts?.productionOnly) {
    if (prodCandidates.length === 0) return null;
    nonDist = prodCandidates;
  } else if (prodCandidates.length > 0) {
    // Soft preference: production wins but non-production is the fallback.
    nonDist = prodCandidates;
  }

  const pool = nonDist.length > 0 ? nonDist : exact;
  const isDist = nonDist.length === 0;

  // Prefer higher centrality among pool members; fall back to first.
  let best = pool[0]!;
  for (const candidate of pool) {
    const bc = best.node.centrality ?? Number.NEGATIVE_INFINITY;
    const cc = candidate.node.centrality ?? Number.NEGATIVE_INFINITY;
    if (cc > bc) best = candidate;
  }

  const n = best.node;
  // Extract parent container name from qualifiedName for field/parameter/property
  // hits so the renderer can display "parameter on chat" instead of just "parameter".
  const parentSymbol = extractParentSymbol(n.qualifiedName, n.kind);
  return {
    name,
    node: {
      name: n.name,
      kind: n.kind,
      filePath: n.filePath,
      startLine: n.startLine,
      ...(parentSymbol ? { parentSymbol } : {}),
    },
    ...(isDist ? { distPathMatch: true } : {}),
  };
}

/**
 * Best-effort extraction of the enclosing container name from a
 * `qualifiedName` for secondary-kind hits (parameter / property / field).
 *
 * Shape: `"path::Container.memberName"` → `"Container"`
 * Multi-level: `"path::Outer.Inner.member"` → `"Inner"`
 *
 * Returns `undefined` when the name has no dot separator (top-level symbol).
 */
function extractParentSymbol(qualifiedName: string, kind: string): string | undefined {
  if (!SECONDARY_KINDS.has(kind)) return undefined;
  const lastDot = qualifiedName.lastIndexOf('.');
  if (lastDot < 0) return undefined;
  const lastColon = qualifiedName.lastIndexOf(':');
  // Everything between the last `:` and the last `.` is the parent path.
  // Strip any leading dots to handle `::Foo.member` → `Foo`.
  const parentPath = qualifiedName.slice(lastColon + 1, lastDot);
  // If the parent path itself contains dots, take only the rightmost segment.
  const lastParentDot = parentPath.lastIndexOf('.');
  return lastParentDot >= 0 ? parentPath.slice(lastParentDot + 1) : parentPath || undefined;
}

/**
 * Primary-pass resolution for one cite: the full `searchNodes` pipeline
 * plus the parameter-shaped-cite recovery hedge. Returns the resolved
 * `CitedIdentifier` when the primary pass produced a candidate, or
 * `null` when no primary candidate exists (caller falls through to the
 * secondary/tertiary passes).
 */
function resolvePrimaryCite(cg: Cartograph, name: string): CitedIdentifier | null {
  // Primary pass: top-K via full searchNodes pipeline (which uses
  // FTS5, LIKE, and scoring — it may bury parameter/field kinds).
  const hits = searchNodes(cg.queries, name, { limit: 5 });
  const primary = pickBestCandidate(hits, name);
  if (primary === null) return null;

  // A parameter-shaped cite (`value`, `min`, `max`) whose best
  // match is in a fixture/spike/test path is almost certainly a
  // coincidental name collision — the cite is really a parameter
  // of the answer's subject. `pickBestCandidate` ranks purely by
  // centrality, so a high-centrality test symbol can outrank a real
  // production definition that also matched. Recovery order:
  // (1) re-pick the best PRODUCTION non-dist hit if one exists,
  // (2) else the signature-owner, (3) else keep the match, hedged.
  const primaryNonProd =
    primary.node !== undefined &&
    primary.distPathMatch !== true &&
    isParameterShapedName(name) &&
    isNonProductionPath(primary.node.filePath);
  // A short parameter-shaped cite whose exact-name match is a
  // leaf-kind node (constant / variable) is a false confident hit
  // even on a PRODUCTION path — the answer means a function
  // parameter, not a top-level `const min` (friction audit-4 #2).
  // The non-prod recovery above only fires on non-production paths;
  // this widens the hedge to the production-path leaf-kind case.
  const primaryWeakLeaf =
    primary.node !== undefined &&
    primary.distPathMatch !== true &&
    isParameterShapedName(name) &&
    LEAF_NODE_KINDS.has(primary.node.kind);
  if (primaryNonProd || primaryWeakLeaf) {
    const prodAlt = pickBestCandidate(hits, name, { productionOnly: true });
    // A production-path leaf-kind hit IS the prodAlt — accepting it
    // would just re-stamp the same false ✓. Only take prodAlt when
    // it isn't itself a hedge-worthy leaf-kind match.
    if (
      prodAlt &&
      !(prodAlt.node !== undefined && LEAF_NODE_KINDS.has(prodAlt.node.kind) && isParameterShapedName(name))
    ) {
      return prodAlt;
    }
    const sigOwner = findSignatureTokenOwner(cg.queries, name);
    if (sigOwner && !isNonProductionPath(sigOwner.filePath)) {
      return {
        name,
        signatureOwner: {
          name: sigOwner.name,
          kind: sigOwner.kind,
          filePath: sigOwner.filePath,
          startLine: sigOwner.startLine,
        },
      };
    }
    return { ...primary, weakNonProdMatch: true };
  }

  // (C) Any name — including PascalCase public-API names like `JoinHandle` —
  // that resolved to a non-production path (fixture / test / mock / script)
  // should be hedged. `pickBestCandidate` now always prefers production
  // candidates; reaching here with a non-production `primary` means the
  // entire top-K contained only non-production hits. A confident ✓ for a
  // symbol found only in a mock/test file would mislead the reader.
  if (primary.node !== undefined && primary.distPathMatch !== true && isNonProductionPath(primary.node.filePath)) {
    return { ...primary, weakNonProdMatch: true };
  }

  return primary;
}

/**
 * Secondary + tertiary resolution for one cite, used only when the
 * primary pass found nothing. The secondary pass uses `getNodesByName`
 * (no kind filter — catches parameter/property/field nodes), the
 * tertiary pass falls back to a signature-token match. Always returns a
 * `CitedIdentifier`; a bare `{ name }` when every fallback misses so
 * the caller can flag it as suspect.
 */
function resolveFallbackCite(cg: Cartograph, name: string): CitedIdentifier {
  // Secondary pass: getNodesByName has no kind filter, so it finds
  // parameter / property / field nodes that searchNodes may miss.
  // Skip `import` / `file` hits — they carry the name of a symbol
  // they don't define, so grounding a cite to one mis-attributes it
  // (see NON_DEFINITION_KINDS). When every exact-name hit is an
  // import/file node, fall through to the signature pass.
  const byName = getNodesByName(cg.queries, name).filter((n) => !NON_DEFINITION_KINDS.has(n.kind));
  if (byName.length > 0) {
    const best = byName[0]!;
    const parentSymbol = extractParentSymbol(best.qualifiedName, best.kind);
    return {
      name,
      node: {
        name: best.name,
        kind: best.kind,
        filePath: best.filePath,
        startLine: best.startLine,
        ...(parentSymbol ? { parentSymbol } : {}),
      },
    };
  }

  // Tertiary pass: the identifier may be a function parameter or a
  // destructured local — cartograph indexes only top-level symbols as
  // nodes, so those never resolve above. If the token appears verbatim
  // in some symbol's signature it is real code, not a hallucination —
  // record it as a signature match so the renderer keeps it OUT of the
  // "suspect" bucket. `findSignatureTokenOwner` returns null for a
  // qualified name (`Foo.bar`), so those stay suspect — correctly so.
  const owner = findSignatureTokenOwner(cg.queries, name);
  if (owner) {
    return {
      name,
      signatureOwner: {
        name: owner.name,
        kind: owner.kind,
        filePath: owner.filePath,
        startLine: owner.startLine,
      },
    };
  }

  return { name };
}

/** Resolve every backtick-quoted identifier from the answer against
 *  the index. Identifiers that match an indexed node by exact name
 *  carry a `node` field; those that don't stay as just `{ name }` so
 *  the caller can flag them as suspect. */
export function groundCitations(cg: Cartograph, answer: string): CitedIdentifier[] {
  const out: CitedIdentifier[] = [];
  for (const name of extractCitedIdentifiers(answer)) {
    const primary = resolvePrimaryCite(cg, name);
    out.push(primary ?? resolveFallbackCite(cg, name));
  }
  return out;
}

/** Build the kind label, including parent context when the symbol is a method/property. */
function buildKindLabel(n: NonNullable<CitedIdentifier['node']>): string {
  const hasParent = n.parentSymbol !== undefined && n.parentSymbol !== null;
  return hasParent ? `${n.kind} on ${n.parentSymbol}` : n.kind;
}

/**
 * Format a single verified citation row (resolved against the index).
 * Distinguishes dist-path matches (?) from source-tree hits (✓).
 */
function formatVerifiedCitation(c: CitedIdentifier): string {
  const n = c.node!;
  const kindLabel = buildKindLabel(n);
  if (c.distPathMatch === true) {
    return `- ? \`${n.name}\` (${kindLabel}) — ${n.filePath}:${n.startLine} _(might be the wrong symbol — distribution-path match)_`;
  }
  if (c.weakNonProdMatch === true) {
    return `- ? \`${n.name}\` (${kindLabel}) — ${n.filePath}:${n.startLine} _(might be the wrong symbol — only match is in a fixture/test path; likely a parameter of the subject)_`;
  }
  return `- ✓ \`${n.name}\` (${kindLabel}) — ${n.filePath}:${n.startLine}`;
}

function appendVerifiedCitations(out: string[], verified: ReadonlyArray<CitedIdentifier>): void {
  if (verified.length === 0) return;
  out.push('## Verified citations (resolved against the index)', '');
  for (const c of verified) {
    out.push(formatVerifiedCitation(c));
  }
  out.push('');
}

/**
 * Render identifiers that resolved only to a signature occurrence —
 * real code (a function parameter / destructured local) that cartograph
 * doesn't index as a standalone node. Kept distinct from BOTH verified
 * symbols and suspect mentions: these are confirmed real, NOT
 * hallucinations, so they must never sit under the ⚠ warning.
 */
function appendSignatureCitations(out: string[], matches: ReadonlyArray<CitedIdentifier>): void {
  if (matches.length === 0) return;
  out.push(
    '## Identifiers in code (parameter / local — not indexed as standalone symbols)',
    '',
    '_Real code: each appears verbatim in the signature of the listed symbol. cartograph indexes only top-level symbols as nodes, not their parameters / locals — these are NOT hallucinations._',
    '',
  );
  for (const c of matches) {
    const o = c.signatureOwner!;
    out.push(`- ✓ \`${c.name}\` — in the signature of \`${o.name}\` (${o.kind}) — ${o.filePath}:${o.startLine}`);
  }
  out.push('');
}

function appendUnverifiedCitations(out: string[], unverified: ReadonlyArray<CitedIdentifier>): void {
  if (unverified.length === 0) return;
  out.push(
    '## ⚠ Unverified mentions (not found in the index)',
    '',
    "_The model named these symbols but they don't resolve to any indexed node — nor to any symbol's signature. Treat as suspect — could be hallucinated, misspelt, or outside the indexed corpus._",
    '',
  );
  for (const c of unverified) out.push(`- ⚠ \`${c.name}\``);
  out.push('');
}

/**
 * Footer counter that splits "verified" into ✓-confirmed (source-tree
 * hits) and ?-uncertain (distribution-path-only hits, which may be the
 * wrong symbol). The 3-way split mirrors the renderer's visual signals
 * — flat "verified" hid the distPathMatch hedge in the count.
 *
 * Returns `'no symbol citations'` for the all-zero case so the footer
 * doesn't read `0 confirmed, 0 uncertain, 0 unverified citations` when
 * the model produced an answer with no backtick-quoted symbols. The
 * wording disambiguates from retrieval citations (the Retrieval sources
 * section above always shows hits regardless of grounding outcome).
 */
export function formatCitationCounter(confirmed: number, uncertain: number, unverified: number): string {
  const total = confirmed + uncertain + unverified;
  if (total === 0) return 'no symbol citations';
  const noun = total === 1 ? 'citation' : 'citations';
  return `${confirmed} confirmed, ${uncertain} uncertain, ${unverified} unverified ${noun}`;
}

/** Models too small to synthesise a useful ask answer.
 *  Heuristic: trips on `-1b`/`-1B`/`-2b`/`-3b` size tokens. Surfaces
 *  a warning when a small model is bound and the answer is very short. */
const SMALL_MODEL_RE = /-[123]b\b/i;

/**
 * The verified / signature / unverified citation report for an answer.
 * Shared between the MCP `cartograph_ask` renderer and the CLI `ask`
 * streaming path so the citation-verification signal is identical on
 * both surfaces (friction #33).
 */
export interface CitationReport {
  /** Markdown section lines (`## Verified citations …` etc.). May be empty. */
  sections: string[];
  /** Footer counter string from {@link formatCitationCounter}. */
  counter: string;
  /** ✓-confirmed citation count (source-tree hits + signature matches). */
  confirmed: number;
  /** ?-uncertain citation count (distribution-path-only hits). */
  uncertain: number;
  /** ⚠-unverified citation count (did not resolve at all). */
  unverified: number;
}

/**
 * Split grounded citations into the three buckets and render the
 * verified / signature / unverified markdown sections plus the footer
 * counter. The single source of truth for citation rendering — both
 * the MCP `buildAskOutput` and the CLI `ask` command consume this so
 * they cannot diverge.
 */
export function buildCitationReport(cited: ReadonlyArray<CitedIdentifier>): CitationReport {
  const verified = cited.filter((c) => c.node);
  const signatureMatches = cited.filter((c) => !c.node && c.signatureOwner);
  const unverified = cited.filter((c) => !c.node && !c.signatureOwner);

  const sections: string[] = [];
  appendVerifiedCitations(sections, verified);
  appendSignatureCitations(sections, signatureMatches);
  appendUnverifiedCitations(sections, unverified);

  // A distribution-path match OR a weak non-production-path match is
  // an uncertain (`?`) hit — only a clean source-tree match is confirmed.
  const distConfirmed = verified.filter((c) => !c.distPathMatch && !c.weakNonProdMatch).length;
  const uncertain = verified.length - distConfirmed;
  // Signature matches are confirmed-real identifiers (just not indexed
  // as standalone nodes), so they count toward `confirmed`.
  const confirmed = distConfirmed + signatureMatches.length;
  const counter = formatCitationCounter(confirmed, uncertain, unverified.length);
  return { sections, counter, confirmed, uncertain, unverified: unverified.length };
}

/**
 * Render a terse reranker-status segment for the retrieval footer.
 * Returns a leading-space string (empty string when there's nothing to say).
 * Exported for unit testing.
 */
export function formatRerankTag(ro: AskResult['rerankOutcome']): string {
  if (!ro) return '';
  switch (ro.kind) {
    case 'fired': {
      const skippedSuffix = ro.skippedCount > 0 ? ` / ${ro.skippedCount} skipped` : '';
      return ` rerank ${ro.durationMs}ms (${ro.rerankedCount} reranked${skippedSuffix});`;
    }
    case 'skipped-no-config':
      return ' reranker not configured;';
    case 'skipped-no-hits':
    case 'skipped-no-text':
      return ` rerank skipped (${ro.kind === 'skipped-no-hits' ? 'no hits' : 'empty candidates'});`;
    case 'failed':
      return ` rerank failed (${ro.error});`;
  }
}

/** Exported for unit testing. */
export function buildAskOutput(result: AskResult, cited: CitedIdentifier[], askModel: string): string {
  const lines: string[] = ['## Answer', '', result.answer, ''];

  // Warn loudly when the active ask model is too small to synthesise
  // — sub-3B models tend to parrot a token from retrieval rather than
  // produce a real answer. Pair with a near-empty answer body (the
  // common failure mode) so we don't false-positive on a small model
  // that did happen to produce a usable short answer.
  const looksUnderpowered = SMALL_MODEL_RE.test(askModel);
  const answerLooksBroken = result.answer.trim().split(/\s+/).filter(Boolean).length <= 5;
  if (looksUnderpowered && answerLooksBroken) {
    lines.push(
      `> ⚠ The configured ask model \`${displayModelName(askModel)}\` is small (≤3B parameters) and produced a very short answer — sub-3B models often parrot tokens from the retrieval context rather than synthesise. Configure \`config.llm.askLlm\` to a 7B+ model (or Anthropic / OpenAI) for usable answers. The retrieval sources below are correct regardless.`,
      '',
    );
  }

  const report = buildCitationReport(cited);
  lines.push(...report.sections, '## Retrieval sources (top hybrid hits passed to the model)', '');
  for (const c of result.citations) {
    const loc = c.node.startLine ? `:${c.node.startLine}` : '';
    lines.push(`- **${c.node.name}** (${c.node.kind}) — ${c.node.filePath}${loc}`);
    if (c.summary) lines.push(`  ${c.summary}`);
  }
  lines.push('');

  // Warn loudly when the reranker failed — a silent fallback to cosine
  // ordering is friction: the user gets worse results with no indication
  // why. Prepend above the citations section so it's impossible to miss.
  const ro = result.rerankOutcome;
  if (ro?.kind === 'failed') {
    lines.unshift(
      `> ⚠ Reranker unavailable — using cosine ordering. \`cartograph_admin doctor\` verifies the endpoint shape, but real rerank batches can still exceed the backend's batch/token limits. If doctor passes, increase the reranker \`llama-server --batch-size\` / \`--ubatch-size\` or reduce retrieval breadth.`,
      '',
    );
  }

  // Collapse an absolute GGUF path down to its basename so the trailer
  // doesn't leak the operator's home directory (friction #42).
  const modelTag = ` model \`${displayModelName(askModel)}\`;`;
  const rerankTag = formatRerankTag(ro);
  lines.push(
    `_Retrieved ${result.citations.length} symbols in ${result.retrieveMs}ms;${rerankTag} chat ${result.chatMs}ms;${modelTag} ${report.counter}._`,
  );
  return lines.join('\n');
}
