/**
 * SCIP symbol-string construction.
 *
 * A SCIP symbol is a structured, globally-unique string:
 *
 *   <scheme> ' ' <manager> ' ' <package-name> ' ' <version> ' ' (<descriptor>)+
 *
 * (the `local <id>` form is for document-scoped symbols only — cartograph
 * has cross-file `calls`/`references` edges, so every exported symbol
 * must be global). Cartograph mints its own opaque node UIDs; this module
 * maps a node onto a *natural* SCIP symbol built from its file path and
 * qualified name, so the export is readable in Sourcegraph rather than a
 * wall of hashes.
 *
 * Descriptor grammar (each ends with its own suffix punctuation, and
 * descriptors concatenate with no separator):
 *   Namespace      <name> '/'
 *   Type           <name> '#'
 *   Term           <name> '.'
 *   Method         <name> '(' <disambiguator> ').'
 *   Meta           <name> ':'
 *
 * Names that aren't bare identifiers (`[A-Za-z0-9_+$-]+`) are wrapped
 * in backticks with inner backticks doubled.
 */

/** SCIP `Descriptor.Suffix` enum values (numbers match `scip.proto`). */
export enum DescriptorSuffix {
  Namespace = 1,
  Type = 2,
  Term = 3,
  Method = 4,
  TypeParameter = 5,
  Parameter = 6,
  Meta = 7,
  Macro = 9,
}

/** One descriptor in a SCIP symbol string. */
export interface Descriptor {
  name: string;
  suffix: DescriptorSuffix;
  /** Method-overload disambiguator — only meaningful for `Method`. */
  disambiguator?: string;
}

/** The `<manager> <package-name> <version>` triple of a SCIP symbol. */
export interface ScipPackage {
  manager: string;
  name: string;
  version: string;
}

/** A name is a SCIP "simple identifier" if it needs no backtick escaping. */
const SIMPLE_IDENTIFIER = /^[A-Za-z0-9_+$-]+$/;

/**
 * Escape a descriptor name: bare identifiers pass through; anything
 * else (paths, dotted names, operators) is backtick-wrapped with inner
 * backticks doubled, per the SCIP `<escaped-identifier>` rule.
 */
export function escapeDescriptorName(name: string): string {
  if (name.length > 0 && SIMPLE_IDENTIFIER.test(name)) return name;
  return '`' + name.replaceAll('`', '``') + '`';
}

/** Escape a package-triple / scheme part — only spaces are reserved. */
function escapePackagePart(part: string): string {
  const trimmed = part.length > 0 ? part : '.';
  return trimmed.replaceAll(' ', '  ');
}

/** Render one descriptor to its symbol-string fragment. */
function descriptorToString(d: Descriptor): string {
  const name = escapeDescriptorName(d.name);
  switch (d.suffix) {
    case DescriptorSuffix.Namespace:
      return name + '/';
    case DescriptorSuffix.Type:
      return name + '#';
    case DescriptorSuffix.Term:
      return name + '.';
    case DescriptorSuffix.Meta:
      return name + ':';
    case DescriptorSuffix.Macro:
      return name + '!';
    case DescriptorSuffix.Method:
      return name + '(' + (d.disambiguator ?? '') + ').';
    case DescriptorSuffix.TypeParameter:
      return '[' + name + ']';
    case DescriptorSuffix.Parameter:
      return '(' + name + ')';
  }
}

/**
 * Assemble a full SCIP symbol string from its scheme, package triple
 * and descriptor path.
 */
export function buildSymbolString(scheme: string, pkg: ScipPackage, descriptors: readonly Descriptor[]): string {
  const head = [scheme, pkg.manager, pkg.name, pkg.version].map(escapePackagePart).join(' ');
  return head + ' ' + descriptors.map(descriptorToString).join('');
}

// ── parsing (inverse — for SCIP import) ───────────────────────────

/** The space-delimited package prefix of a SCIP symbol has exactly
 *  four fields: `<scheme> <manager> <package-name> <version>`. */
const SCIP_PACKAGE_PREFIX_FIELDS = 4;
/** A literal space inside a package field is escaped as two spaces;
 *  consuming the escape advances the cursor by that many characters. */
const ESCAPED_SPACE_WIDTH = 2;

/** A SCIP symbol string parsed back into its parts. */
export interface ParsedSymbol {
  scheme: string;
  packageManager: string;
  packageName: string;
  packageVersion: string;
  descriptors: Descriptor[];
}

/** Suffix punctuation → enum, for the single-character descriptor kinds. */
const SUFFIX_BY_CHAR: Readonly<Record<string, DescriptorSuffix>> = {
  '/': DescriptorSuffix.Namespace,
  '#': DescriptorSuffix.Type,
  '.': DescriptorSuffix.Term,
  ':': DescriptorSuffix.Meta,
  '!': DescriptorSuffix.Macro,
};

const SIMPLE_ID_CHAR = /[A-Za-z0-9_+$-]/;

/**
 * Read a descriptor name at `start` — a simple identifier or a
 * backtick-escaped one (doubled inner backticks). Returns
 * `[name, indexAfterName]`, or `[_, -1]` when no valid name is there.
 */
function readName(s: string, start: number): [string, number] {
  if (s[start] === '`') {
    let name = '';
    let j = start + 1;
    while (j < s.length) {
      if (s[j] === '`') {
        if (s[j + 1] === '`') {
          name += '`';
          j += 2;
          continue;
        }
        return [name, j + 1];
      }
      name += s[j];
      j += 1;
    }
    return ['', -1]; // unterminated escape
  }
  let j = start;
  while (j < s.length && SIMPLE_ID_CHAR.test(s[j]!)) j += 1;
  return j > start ? [s.slice(start, j), j] : ['', -1];
}

/** Parse the descriptor section of a symbol string. `null` on malformed input. */
function parseDescriptors(s: string): Descriptor[] | null {
  const out: Descriptor[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    // Parameter `(name)` / type-parameter `[name]` — bracket-led forms.
    if (ch === '(' || ch === '[') {
      const close = ch === '(' ? ')' : ']';
      const [name, after] = readName(s, i + 1);
      if (after < 0 || s[after] !== close) return null;
      out.push({
        name,
        suffix: ch === '(' ? DescriptorSuffix.Parameter : DescriptorSuffix.TypeParameter,
      });
      i = after + 1;
      continue;
    }
    const [name, afterName] = readName(s, i);
    if (afterName < 0 || afterName >= s.length) return null;
    const suffixChar = s[afterName]!;
    if (suffixChar === '(') {
      // Method `name(disambiguator).`
      let j = afterName + 1;
      while (j < s.length && s[j] !== ')') j += 1;
      if (j >= s.length || s[j + 1] !== '.') return null;
      const disambiguator = s.slice(afterName + 1, j);
      out.push({
        name,
        suffix: DescriptorSuffix.Method,
        ...(disambiguator ? { disambiguator } : {}),
      });
      i = j + 2;
      continue;
    }
    const suffix = SUFFIX_BY_CHAR[suffixChar];
    if (suffix === undefined) return null;
    out.push({ name, suffix });
    i = afterName + 1;
  }
  return out.length > 0 ? out : null;
}

/**
 * Parse a SCIP symbol string back into its scheme, package triple and
 * descriptors — the inverse of {@link buildSymbolString}. Returns
 * `null` for a document-local symbol (`local <id>`) or malformed input.
 */
export function parseScipSymbol(symbol: string): ParsedSymbol | null {
  if (symbol.startsWith('local ')) return null;
  // The four package-prefix fields are space-delimited; a space WITHIN
  // a field is escaped as a doubled space.
  const fields: string[] = [];
  let cur = '';
  let i = 0;
  while (i < symbol.length && fields.length < SCIP_PACKAGE_PREFIX_FIELDS) {
    if (symbol[i] === ' ') {
      if (symbol[i + 1] === ' ') {
        cur += ' ';
        i += ESCAPED_SPACE_WIDTH;
        continue;
      }
      fields.push(cur);
      cur = '';
      i += 1;
      continue;
    }
    cur += symbol[i];
    i += 1;
  }
  if (fields.length < SCIP_PACKAGE_PREFIX_FIELDS) return null;
  const descriptors = parseDescriptors(symbol.slice(i));
  if (!descriptors) return null;
  return {
    scheme: fields[0]!,
    packageManager: fields[1]!,
    packageName: fields[2]!,
    packageVersion: fields[3]!,
    descriptors,
  };
}

/**
 * Reconstruct a cartograph-style qualified name from a parsed symbol:
 * the descriptor names with leading `Namespace` descriptors (the file /
 * module path) dropped, joined by `::`. Falls back to the leaf name
 * when every descriptor is a namespace (e.g. a file symbol).
 */
export function descriptorsToQualifiedName(descriptors: readonly Descriptor[]): string {
  let start = 0;
  while (start < descriptors.length && descriptors[start]!.suffix === DescriptorSuffix.Namespace) {
    start += 1;
  }
  const tail = descriptors.slice(start);
  if (tail.length > 0) return tail.map((d) => d.name).join('::');
  return descriptors.length > 0 ? descriptors.at(-1)!.name : '';
}
