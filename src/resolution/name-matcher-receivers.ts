import type { Node } from '../types.js';
import type { ResolutionContext, UnresolvedRef } from './types.js';
import { escapeRegExp } from '../utils.js';
import { isJvmLang } from './jvm-import-hints.js';

/** Languages whose builtin-method names should be filtered against
 *  unrelated project methods of the same name. Only TS/JS-family
 *  languages share `regex.exec` / `array.find` / etc. */
const TS_JS_FAMILY_LANGS: ReadonlySet<string> = new Set(['typescript', 'javascript', 'tsx', 'jsx']);

export function isTsJsFamilyLang(language: string): boolean {
  return TS_JS_FAMILY_LANGS.has(language);
}

/**
 * Whether a candidate node's language is compatible with the ref's
 * language for method/class lookup. JVM languages cross-resolve; all
 * other language families require exact match.
 */
export function isCompatibleLanguage(refLanguage: string, candidateLanguage: string): boolean {
  if (refLanguage === candidateLanguage) return true;
  return isJvmLang(refLanguage) && isJvmLang(candidateLanguage);
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
export function inferJavaFieldReceiverType(
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
export function inferTsJsFieldReceiverType(
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

export function inferRubyLocalReceiverType(
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
