import type { Node } from '../types.js';
import type { ResolutionContext } from './types.js';

/** JVM languages that can cross-resolve at the source level. */
const JVM_LANGS: ReadonlySet<string> = new Set(['java', 'kotlin']);

const JVM_RECEIVER_KINDS = new Set(['class', 'struct', 'interface']);

export interface JvmImportHints {
  explicitFqns: Map<string, string>;
  wildcardPackages: string[];
  packageName?: string;
}

export function isJvmLang(language: string): boolean {
  return JVM_LANGS.has(language);
}

/** When an import FQN is found via the localName map, use the FQN's
 *  last dot-segment as the class-lookup name — not the localName. This
 *  matters for Kotlin aliases (`Foo as Bar`): `getNodesByName("Bar")`
 *  finds nothing, but `getNodesByName("Foo")` reaches the actual class
 *  node. For unaliased imports the localName equals the last segment so
 *  the substitution is a no-op. */
export function jvmClassLookupName(localName: string, importFqn: string | undefined): string {
  if (!importFqn) return localName;
  return importFqn.substring(importFqn.lastIndexOf('.') + 1) || localName;
}

function extractKotlinAlias(signature: string | undefined): string | undefined {
  if (!signature) return undefined;
  let trimmed = signature.trim();
  if (trimmed.endsWith(';')) trimmed = trimmed.slice(0, -1).trimEnd();
  const marker = ' as ';
  const aliasStart = trimmed.lastIndexOf(marker);
  if (aliasStart < 0) return undefined;
  const alias = trimmed.slice(aliasStart + marker.length).trim();
  return isJvmIdentifier(alias) ? alias : undefined;
}

export function buildJvmImportHints(filePath: string, context: ResolutionContext): JvmImportHints {
  const explicitFqns = new Map<string, string>();
  const wildcardPackages: string[] = [];

  for (const node of context.getNodesInFile(filePath)) {
    if (node.kind !== 'import') continue;
    if (!isJvmLang(node.language)) continue;
    const fqn = node.name;
    const wildcardPackage = jvmWildcardImportPackage(fqn, node.signature);
    if (wildcardPackage) {
      wildcardPackages.push(wildcardPackage);
      continue;
    }
    if (!fqn) continue;
    const alias = node.language === 'kotlin' ? extractKotlinAlias(node.signature) : undefined;
    const localName = alias ?? fqn.substring(fqn.lastIndexOf('.') + 1);
    if (localName) explicitFqns.set(localName, fqn);
  }

  const packageName = readJvmPackageName(context.readFile(filePath) ?? '') ?? undefined;
  return { explicitFqns, wildcardPackages, ...(packageName ? { packageName } : {}) };
}

function jvmWildcardImportPackage(fqn: string | undefined, signature: string | undefined): string | null {
  let trimmed = signature?.trim();
  if (!trimmed) return fqn?.endsWith('.*') ? fqn.slice(0, -2) : null;
  if (trimmed.endsWith(';')) trimmed = trimmed.slice(0, -1).trimEnd();
  if (trimmed.startsWith('import static ')) return null;
  if (!trimmed.endsWith('.*')) return fqn?.endsWith('.*') ? fqn.slice(0, -2) : null;
  return fqn?.endsWith('.*') ? fqn.slice(0, -2) : (fqn ?? null);
}

export function preferredJvmFqnForReceiver(
  receiverName: string,
  context: ResolutionContext,
  hints: JvmImportHints | undefined,
): string | undefined {
  const explicit = hints?.explicitFqns.get(receiverName);
  if (explicit) return explicit;

  const className = jvmClassLookupName(receiverName, undefined);
  const samePackage = packagePreferredJvmFqn(className, hints?.packageName, context);
  if (samePackage) return samePackage;

  for (const packageName of hints?.wildcardPackages ?? []) {
    const wildcard = packagePreferredJvmFqn(className, packageName, context);
    if (wildcard) return wildcard;
  }
  return undefined;
}

function packagePreferredJvmFqn(
  className: string,
  packageName: string | undefined,
  context: ResolutionContext,
): string | undefined {
  if (!packageName) return undefined;
  const fqn = `${packageName}.${className}`;
  for (const candidate of context.getNodesByName(className)) {
    if (!JVM_RECEIVER_KINDS.has(candidate.kind)) continue;
    if (classNodeMatchesJvmFqn(candidate, fqn, context)) return fqn;
  }
  return undefined;
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
    const rest = line.slice('package '.length).trim();
    return readLeadingJvmPackage(rest);
  }
  return null;
}

function readLeadingJvmPackage(value: string): string | null {
  let index = 0;
  let sawSegment = false;
  let expectSegmentStart = true;
  while (index < value.length) {
    const ch = value[index]!;
    if (expectSegmentStart) {
      if (!isJvmIdentifierStart(ch)) break;
      sawSegment = true;
      expectSegmentStart = false;
      index++;
      continue;
    }
    if (isJvmIdentifierPart(ch)) {
      index++;
      continue;
    }
    if (ch === '.') {
      expectSegmentStart = true;
      index++;
      continue;
    }
    break;
  }
  if (!sawSegment || expectSegmentStart) return null;
  return value.slice(0, index);
}

function isJvmIdentifier(value: string): boolean {
  if (!value || !isJvmIdentifierStart(value[0]!)) return false;
  for (let index = 1; index < value.length; index++) {
    if (!isJvmIdentifierPart(value[index]!)) return false;
  }
  return true;
}

function isJvmIdentifierStart(ch: string): boolean {
  return ch === '_' || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z');
}

function isJvmIdentifierPart(ch: string): boolean {
  return isJvmIdentifierStart(ch) || (ch >= '0' && ch <= '9');
}

export function classNodeMatchesJvmFqn(classNode: Node, fqn: string, context: ResolutionContext): boolean {
  return fqnMatchesFilePath(classNode.filePath, fqn) || fqnMatchesJvmPackage(classNode, fqn, context);
}
