/**
 * Java `.properties` — line-oriented custom extractor (B11/F#64c, 2026-05-26).
 *
 * Spring + JVM apps store configuration keys in `application.properties`
 * (and per-env variants like `application-dev.properties`) which are
 * referenced from source via `@Value("${app.cache.ttl}")`. The
 * `spring-value-binding` index hook walks that linkage; for it to find
 * a target node, each key in the .properties file has to be in the
 * graph as a `constant` node whose `qualifiedName` is the dotted key
 * string. This extractor is the producer side of that contract.
 *
 * Line shape (subset of the Java Properties spec, sufficient for v1):
 *   - `key=value`     `=` separator
 *   - `key:value`     `:` separator (Java accepts both interchangeably)
 *   - `#` or `!` at line start (after leading whitespace) is a comment
 *   - blank / whitespace-only lines are skipped
 *   - leading whitespace on the key is stripped
 *   - within the key, `\=` / `\:` / `\\` / `\ ` (escaped delimiter or
 *     space) keep the literal char in the key; any other `\X` keeps the
 *     backslash AND the next char (lossless v1 — full unescape can land
 *     when a consumer needs the post-escape value)
 *   - whitespace between key and separator is stripped
 *   - values are parsed only far enough to find key boundaries; they
 *     are deliberately not stored in graph nodes because properties
 *     files commonly carry credentials and connection strings
 *
 * Deferred to v2 (documented; uncomment + extend when a real corpus
 * surfaces the need):
 *   - Multi-line continuation values (trailing `\` joins next line).
 *     For v1 the continuation lines look like junk key=value pairs but
 *     are harmless — `spring-value-binding` looks up by exact key text,
 *     so a malformed key just won't match anything.
 *   - `\uXXXX` unicode escapes in keys/values.
 *   - Encoding detection (ISO-8859-1 default for legacy .properties;
 *     we read as UTF-8 like every other extractor).
 *
 * Emits one `kind:'constant'` node per parsed key, with a `contains`
 * edge from the file node. Same-key duplicates within one file get
 * per-key ordinals (rare in production but legal — last-write-wins for
 * Spring's own loader).
 */

import type { ExtractionResult } from '../types.js';
import type { Edge, Node } from '../../types.js';
import type { LanguageDef } from './types.js';
import { generateNodeId } from '../tree-sitter-helpers.js';

interface ParsedLine {
  key: string;
  lineNumber: number;
  keyStartColumn: number;
}

function isPropertiesWhitespace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\f';
}

function isPropertiesSeparator(ch: string | undefined): boolean {
  return ch === '=' || ch === ':';
}

const ESCAPED_KEY_CHARS = new Set(['=', ':', '\\', ' ', '\t']);

function isEscapedKeyChar(ch: string | undefined): boolean {
  return ch !== undefined && ESCAPED_KEY_CHARS.has(ch);
}

function firstSignificantColumn(rawLine: string): number {
  let startCol = 0;
  while (startCol < rawLine.length && isPropertiesWhitespace(rawLine[startCol])) startCol++;
  return startCol;
}

function parseKeyEscape(line: string, i: number): { text: string; nextIdx: number } {
  const ch = line[i] ?? '';
  const next = line[i + 1] ?? '';
  const text = isEscapedKeyChar(next) ? next : ch + next;
  return { text, nextIdx: i + 2 };
}

/**
 * Walk the key portion of a line, returning the parsed key + the
 * index at which the separator (=, :, or first unescaped whitespace
 * after a key char) was found. Returns null when the line has no
 * usable key/separator.
 */
function parseKey(line: string, startCol: number): { key: string; separatorIdx: number } | null {
  let key = '';
  let i = startCol;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      // Unknown escape — keep both chars verbatim (lossless v1).
      const parsed = parseKeyEscape(line, i);
      key += parsed.text;
      i = parsed.nextIdx;
      continue;
    }
    if (isPropertiesSeparator(ch)) {
      if (key.length === 0) return null;
      return { key, separatorIdx: i };
    }
    if (isPropertiesWhitespace(ch)) {
      if (key.length === 0) {
        // Should not happen — caller already trimmed leading whitespace.
        i++;
        continue;
      }
      return { key, separatorIdx: i };
    }
    key += ch;
    i++;
  }
  return null;
}

/**
 * Parse one `.properties` source line into a key-bearing entry.
 * Returns null when the line is a comment, empty, or otherwise
 * unparseable as a key/value entry.
 */
function parseLine(rawLine: string, lineNumber: number): ParsedLine | null {
  // Leading whitespace stripped to find the first significant char.
  const startCol = firstSignificantColumn(rawLine);
  if (startCol >= rawLine.length) return null;
  const first = rawLine[startCol];
  if (first === '#' || first === '!') return null;

  const parsed = parseKey(rawLine, startCol);
  if (!parsed) return null;
  return { key: parsed.key, lineNumber, keyStartColumn: startCol };
}

function propertiesExtract(filePath: string, source: string): ExtractionResult {
  const startTime = Date.now();
  const lines = source.split('\n');
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const now = Date.now();

  const fileId = generateNodeId({ filePath, kind: 'file', name: filePath, ordinal: 0 });
  const fileName = filePath.split('/').pop() || filePath;
  nodes.push({
    id: fileId,
    kind: 'file',
    name: fileName,
    qualifiedName: filePath,
    filePath,
    language: 'properties',
    startLine: 1,
    endLine: Math.max(1, lines.length),
    startColumn: 0,
    endColumn: lines.at(-1)?.length ?? 0,
    updatedAt: now,
  });

  // Per-key occurrence count for ordinal allocation. Same key
  // appearing twice in one file gets ordinals 0, 1, ... so the node
  // ids stay unique.
  const ordinalByKey = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? '';
    const parsed = parseLine(rawLine, i + 1);
    if (!parsed) continue;
    const ordinal = ordinalByKey.get(parsed.key) ?? 0;
    ordinalByKey.set(parsed.key, ordinal + 1);
    const id = generateNodeId({ filePath, kind: 'constant', name: parsed.key, ordinal });
    nodes.push({
      id,
      kind: 'constant',
      name: parsed.key,
      qualifiedName: parsed.key,
      filePath,
      language: 'properties',
      startLine: parsed.lineNumber,
      endLine: parsed.lineNumber,
      startColumn: parsed.keyStartColumn,
      endColumn: rawLine.length,
      updatedAt: now,
    });
    edges.push({ source: fileId, target: id, kind: 'contains' });
  }

  return {
    nodes,
    edges,
    unresolvedReferences: [],
    errors: [],
    durationMs: Date.now() - startTime,
  };
}

export const PROPERTIES_DEF: LanguageDef = {
  name: 'properties',
  displayName: 'Java Properties',
  extensions: ['.properties'],
  includeGlobs: ['**/*.properties'],
  customExtractor: propertiesExtract,
};
