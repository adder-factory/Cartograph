/**
 * Name Matcher
 *
 * Handles symbol name matching for reference resolution.
 */

import type { Node } from '../types.js';
import type { UnresolvedRef, ResolvedRef, ResolutionContext, ImportMapping } from './types.js';
import { escapeRegExp, splitIdentifierTokens } from '../utils.js';

/**
 * Common builtin/global method names in TS/JS that frequently collide
 * with user-defined methods. When a reference resolves to one of these
 * with low path-proximity (i.e. a different module from the call site
 * with no import edge), the match is almost always wrong — `regex.exec()`
 * shouldn't resolve to `DatabaseAdapter.exec()`. We reject those low-
 * confidence matches outright so the call stays unresolved instead.
 *
 * Conservative list — only names where the builtin meaning dominates
 * over plausible user-defined homonyms in real codebases.
 */
const TS_JS_BUILTIN_METHODS = new Set([
  // RegExp / String — names where the builtin meaning dominates and
  // user-defined homonyms are vanishingly rare in real code.
  'exec',
  'test',
  'match',
  'matchAll',
  'replaceAll',
  'search',
  'trim',
  'trimStart',
  'trimEnd',
  'startsWith',
  'endsWith',
  'padStart',
  'padEnd',
  'repeat',
  'normalize',
  'localeCompare',
  // Array — same criterion: domain code rarely defines a method named
  // `splice` or `flatMap`. Excluded: `concat`, `slice`, `includes`,
  // `every`, `some`, `find` — those collide with domain method names
  // (e.g. `userRepo.find()`).
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'lastIndexOf',
  'reverse',
  'flat',
  'flatMap',
  'reduceRight',
  // Object
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  // Promise
  'then',
  'catch',
  'finally',
  // INTENTIONALLY EXCLUDED: `has`, `get`, `set`, `add`, `delete`,
  // `clear`, `toString`, `valueOf`, `replace`, `split`, `indexOf`,
  // `reduce`, `concat`, `slice`, `includes`, `every`, `some`, `find`,
  // `map`, `filter`, `forEach`. These are common domain method names
  // (`repo.get`, `cache.set`, `service.find`, …) — the proximity
  // guard alone is too lenient to protect them across `src/api/...`
  // -> `src/db/...` calls in normal-shaped projects.
]);

/** Min path-proximity score below which a builtin-name match is rejected. */
const BUILTIN_PROXIMITY_THRESHOLD = 50;

/**
 * F2 — well-known builtin PROTOTYPE method names on the core JS/TS
 * data structures (Array / Map / Set / Object / String / Promise /
 * iterators). A call extracted as one of these bare names —
 * `map.set(x)`, `set.add(y)`, `arr.map(f)`, `.has(k)`, `.delete(k)`,
 * `.size` — must NOT spawn a phantom `calls` edge to an unrelated
 * user symbol that merely happens to share the name (e.g. the
 * `QueryBuilder` LRU's `set`/`get`/`has`, a fixture's `add`,
 * hnsw-index's `size`).
 *
 * This is BROADER than {@link TS_JS_BUILTIN_METHODS} on purpose — that
 * set protects the multi-candidate exact-match path via a proximity
 * gate and so can afford to stay narrow. This set is consulted only
 * in the *suppression* path ({@link isUnbackedBuiltinMethodCall}),
 * which fires solely when there is NO concrete import/qualified
 * backing for the call. The names below are the ones the friction
 * report (F2) flagged as the dominant phantom-edge source — including
 * the `has`/`get`/`set`/`add`/`delete`/`clear`/`map`/`filter`/`reduce`/
 * `forEach` group that `TS_JS_BUILTIN_METHODS` deliberately excludes
 * because the proximity gate alone is too lenient for them.
 */
const TS_JS_BUILTIN_PROTOTYPE_METHODS: ReadonlySet<string> = new Set([
  // Map / Set
  'set',
  'get',
  'has',
  'delete',
  'add',
  'clear',
  // Array iteration / mutation
  'map',
  'filter',
  'reduce',
  'reduceRight',
  'forEach',
  'find',
  'findIndex',
  'some',
  'every',
  'push',
  'pop',
  'shift',
  'unshift',
  'slice',
  'splice',
  'concat',
  'join',
  'flat',
  'flatMap',
  'fill',
  'sort',
  'reverse',
  'indexOf',
  'lastIndexOf',
  'includes',
  // Iterator / collection views
  'keys',
  'values',
  'entries',
  'next',
  // String
  'split',
  'replace',
  'replaceAll',
  'trim',
  'startsWith',
  'endsWith',
  'padStart',
  'padEnd',
  'repeat',
  'substring',
  'substr',
  'charAt',
  'charCodeAt',
  'codePointAt',
  'toLowerCase',
  'toUpperCase',
  // Promise
  'then',
  'catch',
  'finally',
  // Object / universal
  'toString',
  'valueOf',
  'hasOwnProperty',
  // Property-like members (read as field_access, but chained calls and
  // some grammars surface them as bare-name `calls` too).
  'size',
  'length',
]);

/** Languages whose builtin-method names should be filtered against
 *  unrelated project methods of the same name. Only TS/JS-family
 *  languages share `regex.exec` / `array.find` / etc. */
const TS_JS_FAMILY_LANGS: ReadonlySet<string> = new Set(['typescript', 'javascript', 'tsx', 'jsx']);

/** JVM languages that can cross-resolve at the source level — a
 *  Kotlin file `import com.example.JavaService;` legitimately
 *  resolves into Java sources, and vice versa. Used to relax the
 *  same-language candidate filter for Java↔Kotlin only (#314
 *  follow-up); JS/TS-family etc. keep strict same-language matching. */
const JVM_LANGS: ReadonlySet<string> = new Set(['java', 'kotlin']);

function isJvmLang(language: string): boolean {
  return JVM_LANGS.has(language);
}

function isTsJsFamilyLang(language: string): boolean {
  return TS_JS_FAMILY_LANGS.has(language);
}

/**
 * Whether a candidate node's language is compatible with the ref's
 * language for method/class lookup. JVM languages cross-resolve; all
 * other language families require exact match.
 */
function isCompatibleLanguage(refLanguage: string, candidateLanguage: string): boolean {
  if (refLanguage === candidateLanguage) return true;
  return isJvmLang(refLanguage) && isJvmLang(candidateLanguage);
}

/**
 * Build a localName → FQN map from a file's `kind:'import'` graph
 * nodes. Java/Kotlin import nodes carry the FQN as `name` (per the
 * tree-sitter extractor); Kotlin `import com.example.Foo as Bar`
 * surfaces the alias via `extra.alias`. The localName is the alias
 * when present, else the last dot-segment of the FQN. Wildcard
 * imports (`import com.example.*`) are skipped — no single local
 * name to bind.
 *
 * Cost: one graph-by-file lookup + a small linear pass over the
 * file's import nodes (typically <30). No regex over source content,
 * no caching needed at this scale.
 */
/** Kotlin `import com.example.Foo as Bar` — extract the local alias
 *  from an already-tree-sitter-captured import statement. The match
 *  runs against the single import line's `signature` text, NOT against
 *  full source content. Java has no `as` form so this is always
 *  undefined for Java imports. */
const KOTLIN_IMPORT_ALIAS_RE = /\bas\s+(\w+)\s*;?\s*$/;

function extractKotlinAlias(signature: string | undefined): string | undefined {
  if (!signature) return undefined;
  const m = KOTLIN_IMPORT_ALIAS_RE.exec(signature);
  return m?.[1];
}

/** When an import FQN is found via the localName map, use the FQN's
 *  last dot-segment as the class-lookup name — not the localName. This
 *  matters for Kotlin aliases (`Foo as Bar`): `getNodesByName("Bar")`
 *  finds nothing, but `getNodesByName("Foo")` reaches the actual class
 *  node. For unaliased imports the localName equals the last segment so
 *  the substitution is a no-op. */
function jvmClassLookupName(localName: string, importFqn: string | undefined): string {
  if (!importFqn) return localName;
  return importFqn.substring(importFqn.lastIndexOf('.') + 1) || localName;
}

function normalizeJvmReceiverType(raw: string): string | null {
  let base = raw.trim();
  while (base.endsWith('?')) base = base.slice(0, -1).trimEnd();
  if (!base) return null;
  const head = firstTokenBeforeAny(base, '<[ \t\r\n');
  if (!head) return null;
  const segments = head.split('.');
  return segments.at(-1) ?? null;
}

function parseKotlinFieldSignature(signature: string, receiverName: string): string | null {
  const trimmed = signature.trimStart();
  let afterKeyword: string | null = null;
  if (trimmed.startsWith('val ')) afterKeyword = trimmed.slice(4);
  if (trimmed.startsWith('var ')) afterKeyword = trimmed.slice(4);
  if (!afterKeyword) return null;
  const afterLeadingSpace = afterKeyword.trimStart();
  if (!startsWithIdentifier(afterLeadingSpace, receiverName)) return null;
  const afterName = afterLeadingSpace.slice(receiverName.length).trimStart();
  if (!afterName.startsWith(':')) return null;
  const typeExpr = firstTokenBeforeAny(afterName.slice(1).trimStart(), '= \t\r\n');
  return typeExpr ? normalizeJvmReceiverType(typeExpr) : null;
}

function parseJavaFieldSignature(signature: string, receiverName: string): string | null {
  // Signature shape: `<type-expr> <fieldName>` — strip the trailing
  // field-name word, then strip generic args + array dims from the
  // remaining type expression. The head identifier is the class.
  const beforeAssignment = signature.split('=', 1)[0]!.trimEnd();
  if (!beforeAssignment.endsWith(receiverName)) return null;
  const typeExpr = beforeAssignment.slice(0, -receiverName.length).trimEnd();
  if (!typeExpr || !hasWhitespaceBeforeSuffix(beforeAssignment, receiverName.length)) return null;
  return normalizeJvmReceiverType(typeExpr);
}

function parseJvmFieldSignature(signature: string, receiverName: string): string | null {
  return parseKotlinFieldSignature(signature, receiverName) ?? parseJavaFieldSignature(signature, receiverName);
}

function firstTokenBeforeAny(value: string, delimiters: string): string {
  let end = value.length;
  for (const delimiter of delimiters) {
    const index = value.indexOf(delimiter);
    if (index >= 0 && index < end) end = index;
  }
  return value.slice(0, end);
}

function hasWhitespaceBeforeSuffix(value: string, suffixLength: number): boolean {
  const index = value.length - suffixLength - 1;
  return index >= 0 && isWhitespace(value[index]!);
}

function startsWithIdentifier(value: string, identifier: string): boolean {
  if (!value.startsWith(identifier)) return false;
  const next = value.charAt(identifier.length);
  return !next || !isIdentifierChar(next);
}

function isIdentifierChar(value: string): boolean {
  return (
    (value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z') || (value >= '0' && value <= '9') || value === '_'
  );
}

function isWhitespace(value: string): boolean {
  return value === ' ' || value === '\t' || value === '\r' || value === '\n';
}

/**
 * F#64a / B11 (2026-05-26) — Infer the declared type of a Java/Kotlin
 * field-receiver call by walking the enclosing class's field
 * declarations. Closes the resolution gap where `fooConverter` doesn't
 * capitalize cleanly to its declared type (e.g.
 * `@Resource(name="userBO") UserBO userbo; userbo.toLogin2()` — `userbo`
 * capitalized is `Userbo`, NOT `UserBO`, so Strategy 2's capitalize
 * heuristic misses).
 *
 * Algorithm:
 *   1. Walk this file's nodes — find the class node whose [startLine,
 *      endLine] contains `ref.line` (the call site).
 *   2. Within that class's `field` children, find one named exactly
 *      `receiverName`.
 *   3. Parse the field's `signature` — Java extractor stores it as
 *      `<type-expression> <fieldName>` (e.g. `FooConverter fooConverter`,
 *      `Map<String, Foo> map`). Strip the trailing field name + any
 *      generic args; the head identifier is the declared class name.
 *   4. Return that class-name string, or null when any step fails.
 *
 * Cost: linear walks of file nodes + class fields (typically small).
 * Runs once per JVM-language method-call ref where Strategies 1+2
 * already missed — bounded.
 */
function inferJavaFieldReceiverType(
  receiverName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): string | null {
  if (!isJvmLang(ref.language)) return null;
  const fileNodes = context.getNodesInFile(ref.filePath);
  // Find the smallest enclosing class for ref.line — handles nested
  // classes by preferring the inner-most match.
  let enclosing: Node | null = null;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const n of fileNodes) {
    if (n.kind !== 'class' && n.kind !== 'interface') continue;
    if (ref.line < n.startLine || ref.line > n.endLine) continue;
    const span = n.endLine - n.startLine;
    if (span < bestSpan) {
      enclosing = n;
      bestSpan = span;
    }
  }
  if (!enclosing) return null;
  // Find a field with the matching name inside this class. The
  // tree-sitter Java extractor emits `field` kind nodes for class
  // members; Kotlin uses `property`. Both have signature = "<Type> <name>".
  const field = fileNodes.find(
    (n) =>
      (n.kind === 'field' || n.kind === 'property') &&
      n.name === receiverName &&
      n.startLine >= enclosing.startLine &&
      n.endLine <= enclosing.endLine,
  );
  if (!field?.signature) return null;
  return parseJvmFieldSignature(field.signature, receiverName);
}

/**
 * Infer a TS/JS field receiver from simple class-field declarations.
 * Covers common code like `private cache = new TinyCache()` and
 * `private cache: TinyCache`, where the AST has a `field` node but no
 * persisted signature. This runs only after the literal receiver and
 * capitalized-receiver strategies miss, so it does not weaken concrete
 * qualified-name matches.
 */
function inferTsJsFieldReceiverType(
  receiverName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): string | null {
  if (!isTsJsFamilyLang(ref.language)) return null;
  const field = findEnclosingClassField(receiverName, ref, context);
  if (!field) return null;

  const source = context.readFile(ref.filePath);
  const line = source?.split(/\r?\n/)[field.startLine - 1] ?? '';
  if (!line) return null;

  const nameIndex = indexOfIdentifier(line, receiverName);
  if (nameIndex < 0) return null;
  const tail = line.slice(nameIndex + receiverName.length);
  const annotated = /^\s*:\s*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(tail);
  if (annotated?.[1]) return annotated[1];
  const constructed = /=\s*new\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(tail);
  return constructed?.[1] ?? null;
}

function inferRubyLocalReceiverType(
  receiverName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): string | null {
  if (ref.language !== 'ruby') return null;
  const source = context.readFile(ref.filePath);
  if (!source) return null;

  const owner = context.getNodesInFile(ref.filePath).find((n) => n.id === ref.fromNodeId);
  const startLine = owner ? Math.max(1, owner.startLine) : 1;
  const lines = source.split(/\r?\n/);
  for (let lineIndex = Math.min(ref.line - 2, lines.length - 1); lineIndex >= startLine - 1; lineIndex--) {
    const inferred = parseRubyConstructedLocal(lines[lineIndex] ?? '', receiverName);
    if (inferred) return inferred;
  }
  return null;
}

function parseRubyConstructedLocal(line: string, receiverName: string): string | null {
  const receiver = escapeRegExp(receiverName);
  const match = new RegExp(
    String.raw`^\s*${receiver}\s*(?:\|\|)?=\s*(?:::)?([A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*)\.new\b`,
  ).exec(line);
  const typeName = match?.[1];
  if (!typeName) return null;
  return typeName.split('::').at(-1) ?? null;
}

function indexOfIdentifier(line: string, identifier: string): number {
  let searchFrom = 0;
  while (searchFrom < line.length) {
    const index = line.indexOf(identifier, searchFrom);
    if (index < 0) return -1;
    const before = index > 0 ? line.charAt(index - 1) : '';
    const after = line.charAt(index + identifier.length);
    if ((!before || !isIdentifierChar(before)) && (!after || !isIdentifierChar(after))) return index;
    searchFrom = index + identifier.length;
  }
  return -1;
}

function findEnclosingClassField(receiverName: string, ref: UnresolvedRef, context: ResolutionContext): Node | null {
  const fileNodes = context.getNodesInFile(ref.filePath);
  let enclosing: Node | null = null;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const n of fileNodes) {
    if (n.kind !== 'class' && n.kind !== 'interface') continue;
    if (ref.line < n.startLine || ref.line > n.endLine) continue;
    const span = n.endLine - n.startLine;
    if (span < bestSpan) {
      enclosing = n;
      bestSpan = span;
    }
  }
  if (!enclosing) return null;
  return (
    fileNodes.find(
      (n) =>
        (n.kind === 'field' || n.kind === 'property') &&
        n.name === receiverName &&
        n.startLine >= enclosing.startLine &&
        n.endLine <= enclosing.endLine,
    ) ?? null
  );
}

function buildJvmImportFqnMap(filePath: string, context: ResolutionContext): Map<string, string> {
  const map = new Map<string, string>();
  for (const node of context.getNodesInFile(filePath)) {
    if (node.kind !== 'import') continue;
    if (!isJvmLang(node.language)) continue;
    const fqn = node.name;
    if (!fqn || fqn.endsWith('.*') || isWildcardJvmImportSignature(node.signature)) continue;
    // Kotlin alias parsed from the single captured `signature` line —
    // tree-sitter already tokenized the import statement; this regex
    // operates on that one-line substring, not on source content.
    const alias = node.language === 'kotlin' ? extractKotlinAlias(node.signature) : undefined;
    const localName = alias ?? fqn.substring(fqn.lastIndexOf('.') + 1);
    if (localName) map.set(localName, fqn);
  }
  return map;
}

function isWildcardJvmImportSignature(signature: string | undefined): boolean {
  let trimmed = signature?.trim();
  if (!trimmed) return false;
  if (trimmed.endsWith(';')) trimmed = trimmed.slice(0, -1).trimEnd();
  return trimmed.endsWith('.*');
}

/**
 * Whether a class file's path matches an imported FQN's expected
 * location (`com.example.Foo` → `com/example/Foo.{java,kt}`). The
 * actual file may live under any source root (`src/main/java/`,
 * `src/`, a Maven submodule path), so we suffix-match. Path
 * separators are normalised so a Windows path doesn't false-miss.
 */
function fqnMatchesFilePath(filePath: string, fqn: string): boolean {
  const dotsToSlashes = fqn.replaceAll('.', '/');
  const fp = filePath.replaceAll('\\', '/');
  // Require either a path-segment boundary before the FQN suffix
  // (`/com/example/Foo.java`) or the file IS exactly the FQN path
  // (root-level layout). A bare `endsWith(dotsToSlashes + ext)` would
  // false-match `abcom/example/Foo.java` for `com.example.Foo`.
  return (
    fp === `${dotsToSlashes}.java` ||
    fp === `${dotsToSlashes}.kt` ||
    fp.endsWith(`/${dotsToSlashes}.java`) ||
    fp.endsWith(`/${dotsToSlashes}.kt`)
  );
}

function fqnMatchesJvmPackage(classNode: Node, fqn: string, context: ResolutionContext): boolean {
  if (!isJvmLang(classNode.language)) return false;
  const className = fqn.substring(fqn.lastIndexOf('.') + 1);
  if (classNode.name !== className) return false;
  const expectedPackage = fqn.slice(0, Math.max(0, fqn.length - className.length - 1));
  if (!expectedPackage) return false;
  const source = context.readFile(classNode.filePath);
  if (!source) return false;
  return readJvmPackageName(source) === expectedPackage;
}

function readJvmPackageName(source: string): string | null {
  for (const rawLine of source.split('\n')) {
    const line = rawLine.trimStart();
    if (!line.startsWith('package ')) continue;
    const packageName = firstTokenBeforeAny(line.slice('package '.length).trimStart(), '; \t\r\n');
    return packageName || null;
  }
  return null;
}

function classNodeMatchesJvmFqn(classNode: Node, fqn: string, context: ResolutionContext): boolean {
  return fqnMatchesFilePath(classNode.filePath, fqn) || fqnMatchesJvmPackage(classNode, fqn, context);
}

// matchByExactName confidence values. Single-match resolution gets the
// highest confidence; cross-language single-match drops because cross-
// language same-name matches are usually coincidental. For multi-match,
// a high path-proximity match is "probably right"; a low-proximity one
// is "least-bad guess".
const EXACT_MATCH_SAME_LANG_CONFIDENCE = 0.9;
const EXACT_MATCH_CROSS_LANG_CONFIDENCE = 0.5;
const EXACT_MATCH_HIGH_PROXIMITY_CONFIDENCE = 0.7;
const EXACT_MATCH_LOW_PROXIMITY_CONFIDENCE = 0.4;
/** Path-proximity threshold separating "probably right" from "least-bad guess". */
const HIGH_PROXIMITY_THRESHOLD = 30;

// findBestMatch scoring weights — relative magnitudes encode priority.
// Same-file is the dominant signal (100 dwarfs every other bonus).
// Cross-language carries a strong negative (-80) so a same-language
// candidate without other bonuses still wins over a cross-language one.
const SAME_FILE_BONUS = 100;
const SAME_LANGUAGE_BONUS = 50;
const CROSS_LANGUAGE_PENALTY = 80;
const CALL_REF_FUNCTION_KIND_BONUS = 25;
/**
 * Same magnitude as CALL_REF_FUNCTION_KIND_BONUS but named separately so
 * future tuning of the field-access affinity is independent. The shared
 * starting value is intentional — both are "kind affinity" bonuses; if
 * field_access turns out noisier in practice, lower this without
 * touching the call→function mapping.
 */
const FIELD_ACCESS_KIND_BONUS = 25;
const EXPORTED_SYMBOL_BONUS = 10;
/** Maximum bonus for line-proximity matches in the same file (decays with distance). */
const SAME_FILE_LINE_PROXIMITY_MAX = 20;
/** Lines per unit of line-proximity decay — every 10 lines erodes 1 point. */
const SAME_FILE_LINE_DECAY_PER = 10;

/** Confidence for a path-ref where qualified-name / file-path match exactly. */
const FILE_PATH_EXACT_CONFIDENCE = 0.95;

/** Confidence for a path-ref where the indexed path ends with the reference. */
const FILE_PATH_SUFFIX_CONFIDENCE = 0.85;

/**
 * Confidence for a path-ref that shares only the filename with the
 * sole indexed candidate. Lower because the path prefix didn't agree.
 */
const FILE_PATH_FILENAME_ONLY_CONFIDENCE = 0.7;

/** Build a file-path ResolvedRef with the given confidence tier. */
function filePathResolvedRef(ref: UnresolvedRef, nodeId: string, confidence: number): ResolvedRef {
  return { original: ref, targetNodeId: nodeId, confidence, resolvedBy: 'file-path' };
}

/**
 * Try to resolve a path-like reference (e.g., "snippets/drawer-menu.liquid")
 * by matching the filename against file nodes.
 */
function matchByFilePath(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (!ref.referenceName.includes('/')) return null;

  const fileName = ref.referenceName.split('/').pop();
  if (!fileName) return null;

  const fileNodes = context.getNodesByName(fileName).filter((n) => n.kind === 'file');
  if (fileNodes.length === 0) return null;

  // Prefer exact path match on qualified_name
  const exactMatch = fileNodes.find((n) => n.qualifiedName === ref.referenceName || n.filePath === ref.referenceName);
  if (exactMatch) return filePathResolvedRef(ref, exactMatch.id, FILE_PATH_EXACT_CONFIDENCE);

  // Fall back to suffix match (e.g., ref="snippets/foo.liquid" matches "src/snippets/foo.liquid")
  const suffixMatch = fileNodes.find(
    (n) => n.qualifiedName.endsWith(ref.referenceName) || n.filePath.endsWith(ref.referenceName),
  );
  if (suffixMatch) return filePathResolvedRef(ref, suffixMatch.id, FILE_PATH_SUFFIX_CONFIDENCE);

  // Single file node with this name — lower confidence (path prefix didn't agree)
  if (fileNodes.length === 1) return filePathResolvedRef(ref, fileNodes[0]!.id, FILE_PATH_FILENAME_ONLY_CONFIDENCE);

  return null;
}

/** Map a path-proximity score to one of the two exact-match
 *  confidence tiers. Module-scoped so its inline ternary doesn't
 *  count toward `matchByExactName`'s conditional-operand budget. */
function confidenceFromProximity(p: number): number {
  if (p >= HIGH_PROXIMITY_THRESHOLD) return EXACT_MATCH_HIGH_PROXIMITY_CONFIDENCE;
  return EXACT_MATCH_LOW_PROXIMITY_CONFIDENCE;
}

/**
 * Try to resolve a reference by exact name match
 */
/**
 * True when `ref` is a TS/JS-builtin method name (e.g. `regex.exec`)
 * and the bestMatch sits far from the call site — likely a false
 * positive where some unrelated method happens to share the name.
 */
function isFalseBuiltinTsJsMatch(ref: UnresolvedRef, proximity: number): boolean {
  if (!TS_JS_FAMILY_LANGS.has(ref.language)) return false;
  if (!TS_JS_BUILTIN_METHODS.has(ref.referenceName)) return false;
  return proximity < BUILTIN_PROXIMITY_THRESHOLD;
}

/**
 * F2 — true when `localName` is imported into `ref`'s file under that
 * local binding (`import { map } from './util.js'`). A genuine same-
 * name import is concrete EXTRACTED-confidence backing, so the builtin-
 * method suppression must NOT fire — `map(...)` then really does call
 * the imported `map`, and `someMap.set(...)` where `someMap` is an
 * imported value is a real cross-module receiver. Namespace imports
 * (`import * as x`) DO count for the receiver case: `x.set()` legitimately
 * targets the namespace's `set` export.
 *
 * Pass the bare callee name for unqualified calls, or the receiver
 * identifier for `receiver.method` calls.
 */
function hasConcreteImportBacking(ref: UnresolvedRef, context: ResolutionContext, localName: string): boolean {
  let imports: ImportMapping[];
  try {
    imports = context.getImportMappings(ref.filePath, ref.language);
  } catch {
    // Conservative: an import-lookup failure must not cause suppression
    // of a possibly-real edge. Treat as "backing unknown → assume backed".
    return true;
  }
  return imports.some((imp) => imp.localName === localName);
}

/**
 * F2 — true when a `calls` reference is a BARE, unqualified builtin
 * prototype-method name (`map.set(x)` → `set`, chained `.map().filter()`
 * → `map`/`filter`) with no concrete import backing. Such a ref must
 * NOT pure-name-match a same-named user symbol — that is the phantom
 * `calls`-edge bug (F2): `findPartialClones`'s `Map.set`/`Set.add`/
 * `.has`/`.size` calls resolving onto `QueryBuilder.set`, etc.
 *
 * Deliberately conservative — it only suppresses when EVERY condition
 * holds:
 *   - the language is TS/JS-family (other languages have different
 *     builtin sets, handled in `resolution/index.ts`);
 *   - the reference is a `calls` edge (a `field_access` / `references`
 *     ref to a same-named member is a different, legitimate concern);
 *   - the name is genuinely BARE — no `.` / `::` qualifier and no `/`
 *     path segment. A qualified `obj.set` is handled by
 *     `matchMethodCall`, where strategies 1/2 already require the
 *     receiver to be a known user class ("receiver is demonstrably a
 *     user type" — never suppressed);
 *   - the bare name is a known builtin prototype method;
 *   - there is no same-name import binding the call to a real symbol.
 *
 * When all hold, the only thing a bare-name exact-match could land on
 * is a coincidental homonym, so the resolver returns "unresolved"
 * rather than emitting a misleading EXTRACTED edge.
 */
function isUnbackedBuiltinMethodCall(ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (ref.referenceKind !== 'calls') return false;
  if (!TS_JS_FAMILY_LANGS.has(ref.language)) return false;
  const name = ref.referenceName;
  if (name.includes('.') || name.includes('::') || name.includes('/')) return false;
  if (!TS_JS_BUILTIN_PROTOTYPE_METHODS.has(name)) return false;
  return !hasConcreteImportBacking(ref, context, name);
}

/**
 * B8 — compute the categorical-confidence gap between bestMatch and
 * a different-target runner-up. Same-id runner-ups (FTS dups, repeat
 * exports) reinforce rather than contest; returns undefined for them.
 * Clamped at 0 so the documented "non-negative gap" invariant on
 * ResolvedRef.tieMargin holds even when scoring heuristics flip the
 * raw delta negative (the classifier still flags it AMBIGUOUS).
 */
function computeTieMargin(args: {
  ref: UnresolvedRef;
  bestConfidence: number;
  runnerUp: { id: string; filePath: string } | null;
  bestMatchId: string;
}): number | undefined {
  const { ref, bestConfidence, runnerUp, bestMatchId } = args;
  if (!runnerUp || runnerUp.id === bestMatchId) return undefined;
  const runnerProximity = computePathProximity(ref.filePath, runnerUp.filePath);
  return Math.max(0, bestConfidence - confidenceFromProximity(runnerProximity));
}

function matchByExactName(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  let candidates = context.getNodesByName(ref.referenceName);
  if (candidates.length === 0) return null;

  // F2 — a bare builtin prototype-method name (`set`, `add`, `map`,
  // `has`, `delete`, `size`, …) with no concrete import backing must
  // not pure-name-match a same-named user symbol in ANOTHER file — that
  // is the phantom `calls`-edge bug (`someMap.set()` cross-resolving
  // onto `QueryBuilder.set`). But a same-FILE definition of that name
  // is in lexical scope at the call site, so a free call `add()` to a
  // same-file `function add()` is a genuine edge. Restrict the candidate
  // set to same-file matches; if none survive, the call really is a
  // builtin method and stays unresolved.
  if (isUnbackedBuiltinMethodCall(ref, context)) {
    candidates = candidates.filter((c) => c.filePath === ref.filePath);
    if (candidates.length === 0) return null;
  }

  // If only one match, use it — but penalize cross-language matches
  if (candidates.length === 1) {
    const isCrossLanguage = candidates[0]!.language !== ref.language;
    return {
      original: ref,
      targetNodeId: candidates[0]!.id,
      confidence: isCrossLanguage ? EXACT_MATCH_CROSS_LANG_CONFIDENCE : EXACT_MATCH_SAME_LANG_CONFIDENCE,
      resolvedBy: 'exact-match',
    };
  }

  // Multiple matches - try to narrow down
  const { best: bestMatch, runnerUp } = findBestMatch(ref, candidates, context);
  if (!bestMatch) return null;

  const proximity = computePathProximity(ref.filePath, bestMatch.filePath);
  const confidence = confidenceFromProximity(proximity);
  // Reject the match outright when the name is a TS/JS builtin AND
  // the proximity is weak. `regex.exec()` should NOT resolve to
  // `DatabaseAdapter.exec()` just because some method named `exec`
  // happens to exist in the project. Only TS/JS-family languages
  // get this filter — other languages have different builtin sets.
  if (isFalseBuiltinTsJsMatch(ref, proximity)) return null;

  const tieMargin = computeTieMargin({
    ref,
    bestConfidence: confidence,
    runnerUp,
    bestMatchId: bestMatch.id,
  });
  return {
    original: ref,
    targetNodeId: bestMatch.id,
    confidence,
    resolvedBy: 'exact-match',
    ...(tieMargin === undefined ? {} : { tieMargin }),
  };
}

/**
 * Try to resolve by qualified name
 */
function matchByQualifiedName(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  // Check if the reference name looks qualified (contains :: or .)
  if (!ref.referenceName.includes('::') && !ref.referenceName.includes('.')) {
    return null;
  }

  const candidates = context.getNodesByQualifiedName(ref.referenceName);

  if (candidates.length === 1) {
    return {
      original: ref,
      targetNodeId: candidates[0]!.id,
      confidence: 0.95,
      resolvedBy: 'qualified-name',
    };
  }

  // Try partial qualified name match
  const parts = ref.referenceName.split(/[:.]/);
  const lastName = parts.at(-1);
  if (lastName) {
    const partialCandidates = context.getNodesByName(lastName);
    for (const candidate of partialCandidates) {
      if (candidate.qualifiedName.endsWith(ref.referenceName)) {
        return {
          original: ref,
          targetNodeId: candidate.id,
          confidence: 0.85,
          resolvedBy: 'qualified-name',
        };
      }
    }
  }

  return null;
}

// matchMethodCall confidence tiers, ordered by how directly the receiver
// names a class. A direct `Foo.bar()` qualified call is the strongest
// signal; a capitalized-instance / field-inferred receiver is one step
// less certain (the receiver→class mapping is heuristic, not literal).
/** Direct `Foo.bar()` qualified-name receiver resolves to a class — the
 *  strongest, most-literal receiver signal. */
const QUALIFIED_RECEIVER_CONFIDENCE = 0.85;
/** Instance-variable / field-inferred receiver mapped to a class
 *  heuristically — one step less certain than a qualified-name receiver. */
const INSTANCE_RECEIVER_CONFIDENCE = 0.8;

/**
 * Try to resolve by method name on a class/object
 */
function matchMethodCall(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const chained = matchReturnedReceiverMethodCall(ref, context);
  if (chained) return chained;

  const parsed = parseSimpleMethodCall(ref.referenceName);
  if (!parsed) return null;

  const args = buildMethodCallMatchArgs(ref, context, parsed);
  return (
    matchDirectReceiverMethod(args) ??
    matchReceiverFallbackMethod(args) ??
    (shouldSuppressUnbackedBuiltinMethod(args) ? null : matchMethodByNameOverlap(args))
  );
}

interface SimpleMethodCall {
  objectOrClass: string;
  methodName: string;
}

interface MethodCallMatchArgs extends SimpleMethodCall {
  ref: UnresolvedRef;
  context: ResolutionContext;
  capitalizedReceiver: string;
  jvmImportFqnMap: Map<string, string> | undefined;
}

function parseSimpleMethodCall(refName: string): SimpleMethodCall | null {
  const match = /^(\w+)\.(\w+)$/.exec(refName) ?? /^(\w+)::(\w+)$/.exec(refName);
  if (!match?.[1] || !match[2]) return null;
  return { objectOrClass: match[1], methodName: match[2] };
}

function buildMethodCallMatchArgs(
  ref: UnresolvedRef,
  context: ResolutionContext,
  parsed: SimpleMethodCall,
): MethodCallMatchArgs {
  return {
    ...parsed,
    ref,
    context,
    capitalizedReceiver: parsed.objectOrClass.charAt(0).toUpperCase() + parsed.objectOrClass.slice(1),
    jvmImportFqnMap: isJvmLang(ref.language) ? buildJvmImportFqnMap(ref.filePath, context) : undefined,
  };
}

function matchDirectReceiverMethod(args: MethodCallMatchArgs): ResolvedRef | null {
  const { objectOrClass, methodName, ref, context, jvmImportFqnMap } = args;
  return findReceiverMethod({
    receiverName: objectOrClass,
    methodName,
    ref,
    context,
    jvmImportFqnMap,
    confidence: QUALIFIED_RECEIVER_CONFIDENCE,
    resolvedBy: 'qualified-name',
  });
}

function matchReceiverFallbackMethod(args: MethodCallMatchArgs): ResolvedRef | null {
  return (
    findCapitalizedReceiverMethod(args) ??
    findInferredFieldReceiverMethod({ ...args, inferType: inferJavaFieldReceiverType }) ??
    findInferredFieldReceiverMethod({ ...args, inferType: inferTsJsFieldReceiverType }) ??
    findInferredFieldReceiverMethod({ ...args, inferType: inferRubyLocalReceiverType })
  );
}

function shouldSuppressUnbackedBuiltinMethod(args: MethodCallMatchArgs): boolean {
  const { objectOrClass, methodName, ref, context } = args;
  return (
    TS_JS_FAMILY_LANGS.has(ref.language) &&
    ref.referenceKind === 'calls' &&
    TS_JS_BUILTIN_PROTOTYPE_METHODS.has(methodName) &&
    !hasConcreteImportBacking(ref, context, objectOrClass)
  );
}

interface ReturnedReceiverCall {
  objectOrClass: string;
  factoryMethod: string;
  methodName: string;
}

function parseReturnedReceiverCall(refName: string): ReturnedReceiverCall | null {
  const match = /^(\w+)\.(\w+)\(\)\.(\w+)$/.exec(refName);
  if (!match) return null;
  const [, objectOrClass, factoryMethod, methodName] = match;
  if (!objectOrClass || !factoryMethod || !methodName) return null;
  return { objectOrClass, factoryMethod, methodName };
}

function matchReturnedReceiverMethodCall(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const parsed = parseReturnedReceiverCall(ref.referenceName);
  if (!parsed) return null;

  const inner = matchMethodCall(
    {
      ...ref,
      referenceName: `${parsed.objectOrClass}.${parsed.factoryMethod}`,
    },
    context,
  );
  if (!inner) return null;

  const factoryNode = context.getNodesByName(parsed.factoryMethod).find((n) => n.id === inner.targetNodeId);
  const returnType = inferCallableReturnType(factoryNode);
  if (!returnType) return null;

  return findReceiverMethod({
    receiverName: returnType,
    methodName: parsed.methodName,
    ref,
    context,
    jvmImportFqnMap: isJvmLang(ref.language) ? buildJvmImportFqnMap(ref.filePath, context) : undefined,
    confidence: INSTANCE_RECEIVER_CONFIDENCE,
    resolvedBy: 'instance-method',
  });
}

function inferCallableReturnType(node: Node | undefined): string | null {
  if (!node?.signature) return null;
  const colonReturn = /:\s*([A-Za-z_$][A-Za-z0-9_$:.]*)/.exec(node.signature);
  if (colonReturn?.[1]) return normalizeReturnTypeName(colonReturn[1]);
  const arrowReturn = /->\s*([A-Za-z_$][A-Za-z0-9_$:.]*)/.exec(node.signature);
  if (arrowReturn?.[1]) return normalizeReturnTypeName(arrowReturn[1]);

  const leadingReturn = /^\s*(?:const\s+)?([A-Za-z_$][A-Za-z0-9_$:.]*)[\s*&]*\(/.exec(node.signature);
  if (leadingReturn?.[1]) return normalizeReturnTypeName(leadingReturn[1]);
  return null;
}

function normalizeReturnTypeName(raw: string): string | null {
  const cleaned = trimReturnTypeDecorators(raw);
  if (!cleaned || cleaned === 'void') return null;
  const segments = cleaned.split(/[:.]/);
  return segments.at(-1) ?? null;
}

function trimReturnTypeDecorators(raw: string): string {
  let start = 0;
  let end = raw.length;
  while (start < end && isReturnTypeTrimChar(raw[start]!)) start++;
  while (end > start && isReturnTypeTrimChar(raw[end - 1]!)) end--;
  return raw.slice(start, end);
}

function isReturnTypeTrimChar(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '&' || ch === '*';
}

interface FindReceiverMethodArgs {
  receiverName: string;
  methodName: string;
  ref: UnresolvedRef;
  context: ResolutionContext;
  jvmImportFqnMap: Map<string, string> | undefined;
  confidence: number;
  resolvedBy: 'qualified-name' | 'instance-method';
}

function findReceiverMethod(args: FindReceiverMethodArgs): ResolvedRef | null {
  const { receiverName, methodName, ref, context, jvmImportFqnMap, confidence, resolvedBy } = args;
  const preferredFqn = jvmImportFqnMap?.get(receiverName);
  return findMethodOnClassByName({
    className: jvmClassLookupName(receiverName, preferredFqn),
    methodName,
    ref,
    context,
    confidence,
    resolvedBy,
    preferredFqn,
  });
}

/** Class-kind enum the resolver considers method receivers. */
const METHOD_RECEIVER_KINDS = new Set(['class', 'struct', 'interface']);

/**
 * Look up classes by `className` and return the first method named
 * `methodName` declared in any same-language class file. Method match
 * requires the qualifiedName to contain the class's name (handles
 * inherited / nested method declarations grouped under the same file).
 */
interface FindMethodOnClassByNameArgs {
  className: string;
  methodName: string;
  ref: UnresolvedRef;
  context: ResolutionContext;
  confidence: number;
  resolvedBy: 'qualified-name' | 'instance-method';
  /**
   * Java/Kotlin only — the FQN of `className` as named by the caller
   * file's import statement (#314 / F#57). When multiple classes
   * share the simple name, the FQN-matching candidate is tried first
   * and resolved at `fqn-disambiguated` confidence; non-FQN-matching
   * candidates remain as fallback. Pre-F#57 the picker iterated
   * `getNodesByName` order — alphabetical/insertion — and resolved
   * to whichever class showed up first, which is wrong any time the
   * caller's import points at a different one.
   */
  // `string | undefined` (not just `?: string`) so call sites can
  // pass `Map.get()` results directly under `exactOptionalPropertyTypes`.
  preferredFqn?: string | undefined;
}

function findMethodOnClassByName(args: FindMethodOnClassByNameArgs): ResolvedRef | null {
  const { className, methodName, ref, context, confidence, resolvedBy, preferredFqn } = args;

  // Collect compatible class candidates. Pre-F#57 this was a strict
  // same-language filter; for JVM refs (java / kotlin) we accept
  // either since mixed-language Spring Boot projects routinely have
  // a Kotlin file import a Java class and call methods on it.
  const candidates: Node[] = [];
  for (const classNode of context.getNodesByName(className)) {
    if (!METHOD_RECEIVER_KINDS.has(classNode.kind)) continue;
    if (!isCompatibleLanguage(ref.language, classNode.language)) continue;
    candidates.push(classNode);
  }
  if (candidates.length === 0) return null;

  // Order: FQN-matching candidates first, then iteration order. The
  // loop still walks every candidate so a missing method in the
  // FQN'd file falls through to the next match (parity with the
  // pre-F#57 behaviour where we tried each class in turn).
  const fqnAvailable = preferredFqn !== undefined;
  const anyFqnMatch = fqnAvailable && candidates.some((c) => classNodeMatchesJvmFqn(c, preferredFqn, context));
  const ordered = fqnAvailable
    ? [...candidates.filter((c) => classNodeMatchesJvmFqn(c, preferredFqn, context))].concat(
        candidates.filter((c) => !classNodeMatchesJvmFqn(c, preferredFqn, context)),
      )
    : candidates;

  for (const classNode of ordered) {
    const methodNode = context
      .getNodesInFile(classNode.filePath)
      .find((n) => n.kind === 'method' && n.name === methodName && n.qualifiedName.includes(classNode.name));
    if (!methodNode) continue;

    return resolveMethodCandidate({
      ref,
      methodNode,
      classNode,
      context,
      confidence,
      resolvedBy,
      preferredFqn,
      fqnAvailable,
      anyFqnMatch,
      candidateCount: candidates.length,
    });
  }
  return null;
}

interface ReceiverFallbackArgs {
  objectOrClass: string;
  capitalizedReceiver: string;
  methodName: string;
  ref: UnresolvedRef;
  context: ResolutionContext;
  jvmImportFqnMap: Map<string, string> | undefined;
}

interface InferredFieldReceiverArgs extends ReceiverFallbackArgs {
  inferType: (receiverName: string, ref: UnresolvedRef, context: ResolutionContext) => string | null;
}

function findCapitalizedReceiverMethod(args: ReceiverFallbackArgs): ResolvedRef | null {
  const { objectOrClass, capitalizedReceiver, methodName, ref, context, jvmImportFqnMap } = args;
  if (capitalizedReceiver === objectOrClass) return null;
  return findReceiverMethod({
    receiverName: capitalizedReceiver,
    methodName,
    ref,
    context,
    jvmImportFqnMap,
    confidence: INSTANCE_RECEIVER_CONFIDENCE,
    resolvedBy: 'instance-method',
  });
}

function findInferredFieldReceiverMethod(args: InferredFieldReceiverArgs): ResolvedRef | null {
  const { objectOrClass, capitalizedReceiver, methodName, ref, context, jvmImportFqnMap, inferType } = args;
  const inferredType = inferType(objectOrClass, ref, context);
  if (!inferredType || inferredType === objectOrClass || inferredType === capitalizedReceiver) return null;
  return findReceiverMethod({
    receiverName: inferredType,
    methodName,
    ref,
    context,
    jvmImportFqnMap,
    confidence: INSTANCE_RECEIVER_CONFIDENCE,
    resolvedBy: 'instance-method',
  });
}

function resolveMethodCandidate(args: {
  ref: UnresolvedRef;
  methodNode: Node;
  classNode: Node;
  context: ResolutionContext;
  confidence: number;
  resolvedBy: 'qualified-name' | 'instance-method';
  preferredFqn: string | undefined;
  fqnAvailable: boolean;
  anyFqnMatch: boolean;
  candidateCount: number;
}): ResolvedRef {
  const {
    ref,
    methodNode,
    classNode,
    confidence,
    resolvedBy,
    preferredFqn,
    fqnAvailable,
    anyFqnMatch,
    candidateCount,
  } = args;
  if (fqnAvailable && classNodeMatchesJvmFqn(classNode, preferredFqn!, args.context)) {
    return { original: ref, targetNodeId: methodNode.id, confidence: 0.9, resolvedBy: 'fqn-disambiguated' };
  }
  if (fqnAvailable && !anyFqnMatch && candidateCount > 1) {
    return { original: ref, targetNodeId: methodNode.id, confidence: 0.6, resolvedBy };
  }
  return { original: ref, targetNodeId: methodNode.id, confidence, resolvedBy };
}

/**
 * Strategy 3: enumerate every method named `methodName` and pick the
 * one whose qualifiedName shares the most identifier words with the
 * receiver. Single same-language match short-circuits to a high-
 * confidence resolve; multi-match falls back to a word-overlap score
 * gate (≥2 shared words) to avoid wild guesses.
 */
interface MatchMethodByNameOverlapArgs {
  objectOrClass: string;
  methodName: string;
  ref: UnresolvedRef;
  context: ResolutionContext;
}

function matchMethodByNameOverlap(args: MatchMethodByNameOverlapArgs): ResolvedRef | null {
  const { objectOrClass, methodName, ref, context } = args;
  const methods = context.getNodesByName(methodName).filter((n) => n.kind === 'method' && n.name === methodName);
  if (methods.length === 0) return null;

  // Prefer same-language candidates; fall back to all when none match.
  const sameLanguage = methods.filter((m) => m.language === ref.language);
  const targets = sameLanguage.length > 0 ? sameLanguage : methods;

  if (targets.length === 1 && targets[0]!.language === ref.language) {
    return {
      original: ref,
      targetNodeId: targets[0]!.id,
      confidence: 0.7,
      resolvedBy: 'instance-method',
    };
  }

  if (targets.length > 1) {
    const best = pickBestByWordOverlap(targets, objectOrClass, ref.language);
    if (best && best.score >= 2) {
      return {
        original: ref,
        targetNodeId: best.method.id,
        confidence: 0.65,
        resolvedBy: 'instance-method',
      };
    }
  }
  return null;
}

/**
 * Score each candidate method by identifier-word overlap between the
 * receiver name and the method's qualifiedName, plus a +1 bonus when
 * the language matches the ref's. Returns the highest-scoring method
 * (and its score) for the caller to gate on a threshold.
 */
function pickBestByWordOverlap<T extends { id: string; qualifiedName: string; language: string }>(
  methods: T[],
  receiverName: string,
  refLanguage: string,
): { method: T; score: number } | null {
  // Word-overlap scoring: drop single-char tokens — a lone `x` or `i`
  // sharing across two names is noise, not a meaningful name match.
  // `splitIdentifierTokens` already lowercases, so the words compare
  // directly. (The general splitter keeps single-char tokens because
  // FTS subword indexing wants them; that's a per-caller choice.)
  const overlapWords = (s: string): string[] => splitIdentifierTokens(s).filter((w) => w.length > 1);
  const receiverWords = overlapWords(receiverName);
  let best: T | undefined;
  let bestScore = 0;
  for (const method of methods) {
    const classWords = overlapWords(method.qualifiedName);
    let score = receiverWords.filter((w) => classWords.includes(w)).length;
    if (method.language === refLanguage) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = method;
    }
  }
  return best ? { method: best, score: bestScore } : null;
}

/**
 * Compute directory proximity between two file paths.
 * Returns a score based on the number of shared directory segments.
 * Higher score = closer in directory tree.
 */
function computePathProximity(filePath1: string, filePath2: string): number {
  const dir1 = filePath1.split('/').slice(0, -1);
  const dir2 = filePath2.split('/').slice(0, -1);

  let shared = 0;
  for (let i = 0; i < Math.min(dir1.length, dir2.length); i++) {
    if (dir1[i] === dir2[i]) {
      shared++;
    } else {
      break;
    }
  }

  // Each shared directory segment contributes 15 points, capped at 80
  return Math.min(shared * 15, 80);
}

interface BestMatchResult {
  /** Highest-scoring candidate, or null when no candidate scored. */
  best: Node | null;
  /**
   * Second-highest-scoring candidate (B8). Used by `matchByExactName`
   * to compute a `tieMargin` so the upstream picker can flag near-
   * ties as AMBIGUOUS — without this, two `same-name` candidates in
   * different files at similar proximity would silently resolve to
   * one, hiding the ambiguity from `cartograph_callers` consumers.
   */
  runnerUp: Node | null;
}

/**
 * Find the best matching node when there are multiple candidates.
 * Also returns the second-best so the caller can detect score ties
 * and stamp `tieMargin` for the AMBIGUOUS classifier.
 */
function findBestMatch(ref: UnresolvedRef, candidates: Node[], _context: ResolutionContext): BestMatchResult {
  // Prioritization rules:
  // 1. Same file > different file
  // 2. Directory proximity (same module/package > different module)
  // 3. Same language > different language
  // 4. Functions/methods > classes/types (for call references)
  // 5. Exported > non-exported

  let bestScore = -1;
  let bestNode: Node | null = null;
  let runnerUpScore = -1;
  let runnerUp: Node | null = null;

  for (const candidate of candidates) {
    const score = scoreCandidate(ref, candidate);

    if (score > bestScore) {
      // Demote the prior best to runner-up before promoting the new one.
      runnerUp = bestNode;
      runnerUpScore = bestScore;
      bestScore = score;
      bestNode = candidate;
    } else if (score > runnerUpScore) {
      // Strict `>` — when 3+ candidates share the same runner-up
      // score, the FIRST encountered wins the slot (FTS row order).
      // Acceptable: the AMBIGUOUS classifier only needs ONE runner-
      // up to compute a tieMargin; the full multi-candidate fan-out
      // would require a different ResolvedRef shape (and isn't worth
      // the cost while same-name targets are rare).
      runnerUp = candidate;
      runnerUpScore = score;
    }
  }

  return { best: bestNode, runnerUp };
}

/**
 * Score a single candidate against the unresolved ref. Sums file proximity,
 * language match, kind affinity for calls, export bonus, and intra-file
 * line-distance falloff. Pulled out so {@link findBestMatch} stays a small
 * winner/runner-up loop.
 */
function scoreCandidate(ref: UnresolvedRef, candidate: Node): number {
  let score = 0;

  if (candidate.filePath === ref.filePath) score += SAME_FILE_BONUS;
  score += computePathProximity(ref.filePath, candidate.filePath);

  if (candidate.language === ref.language) score += SAME_LANGUAGE_BONUS;
  else score -= CROSS_LANGUAGE_PENALTY;

  if (ref.referenceKind === 'calls' && (candidate.kind === 'function' || candidate.kind === 'method')) {
    score += CALL_REF_FUNCTION_KIND_BONUS;
  }
  // field_access refs prefer class-member targets. `method` is included
  // because the TS extractor stores class data fields as kind='method'
  // (typescript.ts methodTypes covers both method_definition and
  // public_field_definition); without the bonus, field_access for
  // `obj.total` could lose to a same-named top-level constant in
  // another file.
  if (
    ref.referenceKind === 'field_access' &&
    (candidate.kind === 'field' || candidate.kind === 'property' || candidate.kind === 'method')
  ) {
    score += FIELD_ACCESS_KIND_BONUS;
  }
  if (candidate.isExported) score += EXPORTED_SYMBOL_BONUS;

  if (candidate.filePath === ref.filePath && candidate.startLine) {
    const distance = Math.abs(candidate.startLine - ref.line);
    score += Math.max(0, SAME_FILE_LINE_PROXIMITY_MAX - distance / SAME_FILE_LINE_DECAY_PER);
  }
  return score;
}

/**
 * Fuzzy match - last resort with lower confidence
 */
function matchFuzzy(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  // F2 — the fuzzy path is also a pure-name match. A bare builtin
  // prototype-method call (`set`, `add`, `map`, …) with no import
  // backing must not fall through to a case-insensitive homonym
  // resolve either — that just re-creates the phantom edge at `fuzzy`
  // (INFERRED) confidence instead of `exact-match`.
  if (isUnbackedBuiltinMethodCall(ref, context)) return null;

  const lowerName = ref.referenceName.toLowerCase();

  // Use pre-built lowercase index for O(1) lookup instead of scanning all nodes
  const candidates = context.getNodesByLowerName(lowerName);

  // Filter to callable kinds only (function, method, class)
  const callableKinds = new Set(['function', 'method', 'class']);
  const callableCandidates = candidates.filter((n) => callableKinds.has(n.kind));

  // Prefer same-language matches
  const sameLanguageCandidates = callableCandidates.filter((n) => n.language === ref.language);
  const finalCandidates = sameLanguageCandidates.length > 0 ? sameLanguageCandidates : callableCandidates;

  if (finalCandidates.length === 1) {
    const isCrossLanguage = finalCandidates[0]!.language !== ref.language;
    return {
      original: ref,
      targetNodeId: finalCandidates[0]!.id,
      confidence: isCrossLanguage ? 0.3 : 0.5,
      resolvedBy: 'fuzzy',
    };
  }

  return null;
}

/**
 * Match all strategies in order of confidence
 */
export function matchReference(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  // Try strategies in order of confidence
  let result: ResolvedRef | null;

  // 0. File path match (e.g., "snippets/drawer-menu.liquid" → file node)
  result = matchByFilePath(ref, context);
  if (result) return result;

  // 1. Qualified name match (highest confidence)
  result = matchByQualifiedName(ref, context);
  if (result) return result;

  // 2. Method call pattern
  result = matchMethodCall(ref, context);
  if (result) return result;

  // 3. Exact name match
  result = matchByExactName(ref, context);
  if (result) return result;

  // 4. Fuzzy match (lowest confidence)
  result = matchFuzzy(ref, context);
  if (result) return result;

  return null;
}
