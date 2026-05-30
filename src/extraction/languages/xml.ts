/**
 * XML — MyBatis-aware regex extractor (B11/F#64b, 2026-05-26).
 * v1.1 (2026-05-27): adds `<resultMap>` / `<parameterMap>` extraction
 * and `<include refid="X"/>` cross-statement references.
 * v2 (2026-05-27): adds `resultMap="X"` / `parameterMap="X"` statement-
 * attribute references, linking statements to their declared mapping
 * nodes (which v1.1 already extracts but didn't yet wire references
 * to).
 * v3 (2026-05-27): scans statement bodies for `#{paramName}`
 * placeholders, emits one UnresolvedReference per occurrence. The
 * standard resolver's qualifiedName-match path binds these to the
 * matching JVM `kind:'parameter'` node (emitted by the new
 * `tsEmitAnnotatedParameters` pass in `ts-extract-declarations.ts`)
 * — same hands-off resolution strategy as v1.1's `<include refid>`
 * and v2's `resultMap="X"` attribute paths; no mybatis-binding
 * hook sub-pass is involved.
 * v3.1 (2026-05-27): `tsEmitAnnotatedParameters` extended to
 * Kotlin (state-machine pairs `parameter_modifiers` with the next
 * `parameter`). No xml.ts change — the `#{paramName}` resolution
 * path is identical across Java/Kotlin source.
 * v4 (2026-05-27): adds a second file shape — Spring/MyBatis
 * `mybatis-config.xml` files (root `<configuration>` with a
 * `<mappers>` block). Emits one UnresolvedReference per
 * `<mapper class="com.example.X"/>` declaration (resolves to the
 * Java/Kotlin Mapper interface by simple class name) AND one
 * `kind:'type_alias'` node per `<typeAlias alias="A" type="X"/>`
 * (the FQCN is captured in `signature`; no graph edge to the
 * target type — see `extractMybatisConfigFile` for the rationale).
 *
 * No tree-sitter-xml grammar vendored — the npm package
 * `@tree-sitter-grammars/tree-sitter-xml@0.7.0` ships source-only (no
 * pre-built .wasm), and we don't have `tree-sitter-cli` / emscripten
 * available to build one. The MyBatis subset we actually need is a
 * narrow regex shape; a full XML AST would be over-kill. Same pattern
 * as `liquid` / `hcl` / `sql` extractors — regex-based `customExtractor`.
 *
 * What this extractor emits — Mapper-file shape (`<mapper namespace=…>`):
 *
 *   - File node (kind: 'file').
 *   - One `kind:'method'` node per MyBatis statement
 *     (`<select|insert|update|delete|sql id="X">`), `name` = the `id`
 *     attribute, `qualifiedName` = `<LastNamespaceSegment>::<id>` so
 *     the `mybatis-binding` index-hook can join it against the JVM
 *     (Java/Kotlin) extractor's `<InterfaceName>::<method>`
 *     qualifiedName shape.
 *   - One `kind:'type_alias'` node per `<resultMap id="X" type="Y">`
 *     and `<parameterMap id="X" type="Y">`. `signature` carries the
 *     declared JVM type (or 'resultMap' / 'parameterMap' when the
 *     `type` attribute is absent — legacy `extends`-only chains).
 *   - One `UnresolvedReference` per `<include refid="X"/>` inside a
 *     statement body. `referenceName` is shaped as `<Class>::<id>`
 *     so the standard resolver's qualifiedName-match path picks it
 *     up automatically (emitting a `references` edge with
 *     `resolvedBy: 'qualified-name'`, confidence 0.95). Dotted
 *     refids (`other.Mapper.frag`) are parsed by `refidToQualifiedName`
 *     into their own class/id segments. No mybatis-binding hook
 *     pass is needed for this — the resolver handles it.
 *   - One `UnresolvedReference` per `resultMap="X"` or
 *     `parameterMap="X"` attribute on a statement opening tag (v2
 *     addition). Same `<Class>::<id>` qualifiedName shape + same
 *     standard-resolver qn-match path as the include-refid case.
 *     Cross-mapper attributes like `resultMap="other.Mapper.X"`
 *     resolve via `refidToQualifiedName` identically.
 *   - One `UnresolvedReference` per `#{paramName}` placeholder
 *     inside a statement body (v3 addition). `referenceName` is
 *     shaped as `<Class>::<methodId>::<paramName>` matching the
 *     chained qualifiedName the new JVM parameter nodes carry, so
 *     the standard resolver's qn-match binds the ref automatically.
 *     Property access (`#{user.name}`) collapses to the head
 *     identifier; per-statement de-dup means two reads of the same
 *     head param emit one ref, not two. `${literal}` string-
 *     substitution syntax is deliberately NOT scanned (it's textual
 *     replacement, not parameter binding). Type-hint suffixes
 *     (`#{param,jdbcType=VARCHAR}`) are tolerated without capturing
 *     the hint into the param-name group.
 *
 * What this extractor emits — Config-file shape (v4: `<configuration>`
 * + `<mappers>`):
 *
 *   - File node (kind: 'file') for the `mybatis-config.xml` file.
 *   - One `UnresolvedReference` per `<mapper class="com.example.X"/>`
 *     declaration. `referenceName` is the simple class name (last
 *     dotted segment); the standard resolver's name-match path binds
 *     it to the Java/Kotlin Mapper interface node.
 *   - One `kind:'type_alias'` node per `<typeAlias alias="A"
 *     type="X"/>` declaration. `qualifiedName = '<filePath>::<alias>'`,
 *     `signature` = declared FQCN. NO paired type_of edge to the
 *     target (see `extractMybatisConfigFile`'s JSDoc for rationale).
 *
 * Files matching NEITHER shape (no `<mapper namespace="...">` AND no
 * `<configuration>...<mappers>`) return an empty result quickly —
 * `pom.xml` / `build.xml` / IDE config XMLs don't pollute the graph.
 *
 * Deferred (documented; uncomment + extend when a corpus surfaces
 * the need):
 *   - Spring `mybatis-config.xml` with `<package name="..."/>` scans.
 *   - Generic XML (non-MyBatis) — when consumers ask, this becomes
 *     a second branch with a real tree-sitter-xml grammar vendored.
 *
 * Known limitations (regex-based parsing — accept; not blockers):
 *   - `<![CDATA[ ... ]]>` sections that contain literal `</select>` or
 *     `<include refid="x"/>` text inside CDATA are NOT specially
 *     handled. Real MyBatis files avoid this pattern.
 *   - Self-closing statement tags (`<select id="x" />`) have no body;
 *     the body scan is a no-op. Real MyBatis files don't ship empty
 *     statements.
 *
 * XML comment handling: `<!-- ... -->` blocks ARE stripped (replaced
 * with equivalent-length whitespace so line numbers stay accurate)
 * before regex-scanning, so a comment containing literal
 * `<select id="foo">` or `<include refid="x"/>` text doesn't
 * false-extract. Caught by the language-coverage parity fixture's
 * documentation comment (which describes the regex shape verbatim).
 */

import type { ExtractionResult, Node, Edge, UnresolvedReference } from '../../types.js';
import type { LanguageDef } from './types.js';
import { generateNodeId } from '../tree-sitter-helpers.js';

/** MyBatis statement element names that map to Mapper-interface methods.
 *  `<sql>` is a fragment-include shape — `<include refid="X"/>` from
 *  other statements points back at it; emit a method node so the
 *  include can resolve via the standard method-qualifiedName join. */
const MYBATIS_STATEMENT_TAGS = ['select', 'insert', 'update', 'delete', 'sql'] as const;

/** MyBatis row/parameter mapping element names. Both share the same
 *  `id` + `type` attribute shape and emit as `type_alias` nodes. */
const MYBATIS_MAPPING_TAGS = ['resultMap', 'parameterMap'] as const;

/** Cheap up-front gate: does the file look like a MyBatis mapper? Looks
 *  for the `<mapper namespace="...">` root element (with optional
 *  whitespace after the opening tag name). DOCTYPE + xmlns variations
 *  are deliberately not required — some MyBatis files drop the DTD. */
const MYBATIS_ROOT_RE = /<mapper\b[^>]*\bnamespace\s*=\s*["']([^"']+)["']/;

/** Cheap up-front gate for a MyBatis config file (`mybatis-config.xml`).
 *  Requires BOTH a `<configuration>` root-shaped element AND a
 *  `<mappers>` block — joint presence is highly specific to MyBatis
 *  (Maven `pom.xml` has `<configuration>` but not `<mappers>`; Tomcat
 *  / Logback / etc. configs likewise don't pair the two). Matches the
 *  pattern `<configuration ...>...<mappers ...>`. */
const MYBATIS_CONFIG_ROOT_RE = /<configuration\b[^>]*>[\s\S]*?<mappers\b/;

/** Inside a config file, find every `<mapper class="com.example.X"/>`
 *  declaration. Each emits an UnresolvedReference to the simple class
 *  name; the standard resolver's name-match path binds it to the
 *  Java or Kotlin Mapper interface. The trailing `\/?>` accepts both
 *  self-closing and paired forms. (We don't capture the `resource=`
 *  / `url=` variants — those reference XML files, not JVM classes,
 *  and the mapper-file path is already covered by the standard
 *  file-import resolution.) */
const CONFIG_MAPPER_CLASS_RE = /<mapper\b[^>]*\bclass\s*=\s*["']([^"']+)["'][^>]*\/?>/g;

/** Inside a config file, find every `<typeAlias alias="A" type="X"/>`
 *  declaration. The alias is local to the config file; the type is
 *  a Java/Kotlin class reference. */
const TYPE_ALIAS_TAG_RE = /<typeAlias\b[^>]*\/?>/g;
const ALIAS_ATTR_RE = /\balias\s*=\s*["']([^"']+)["']/;

/** Per-statement regex. Captures the tag name + the `id="..."` attribute
 *  value. Other attributes (`parameterType`, `resultType`, etc.) are
 *  scanned across with `[^>]*` so the order doesn't matter. */
const STATEMENT_RE = new RegExp(
  `<(${MYBATIS_STATEMENT_TAGS.join('|')})\\b[^>]*\\bid\\s*=\\s*["']([^"']+)["'][^>]*>`,
  'gi',
);

/** Per-mapping regex for `<resultMap>` / `<parameterMap>`. Captures
 *  the tag name + the `id` attribute. `type` is captured separately
 *  via TYPE_ATTR_RE applied to the opening tag's full text. */
const MAPPING_RE = new RegExp(`<(${MYBATIS_MAPPING_TAGS.join('|')})\\b[^>]*\\bid\\s*=\\s*["']([^"']+)["'][^>]*>`, 'gi');

/** Pulls the `type="X"` attribute value out of an opening-tag string. */
const TYPE_ATTR_RE = /\btype\s*=\s*["']([^"']+)["']/;

/** Pulls the `resultMap="X"` attribute value out of a statement
 *  opening-tag string. Used to emit a `references` ref from the
 *  statement to the named `<resultMap id="X">` type_alias node. */
const RESULTMAP_ATTR_RE = /\bresultMap\s*=\s*["']([^"']+)["']/;

/** Pulls the `parameterMap="X"` attribute value (legacy MyBatis but
 *  still seen in old codebases). Same shape as resultMap binding. */
const PARAMETERMAP_ATTR_RE = /\bparameterMap\s*=\s*["']([^"']+)["']/;

/** Inside a statement body, find every `<include refid="X"/>` (both
 *  self-closing and paired forms — the trailing `/?` makes the `/`
 *  optional). */
const INCLUDE_REFID_RE = /<include\b[^>]*\brefid\s*=\s*["']([^"']+)["'][^>]*\/?>/gi;

/** Inside a statement body, find every `#{paramName}` placeholder.
 *  The standard resolver's qualifiedName-match path binds these to
 *  the matching JVM (Java/Kotlin) parameter node — no mybatis-binding
 *  hook sub-pass is involved. MyBatis also supports `${literal}`
 *  substitutions, but those are string-replacement (NOT parameter-
 *  binding), so we deliberately skip them here. The `[A-Za-z_][\w.]*`
 *  shape matches valid MyBatis param names (`userId`, `user.name`
 *  for property access) and excludes garbage. The trailing
 *  `(?:,[^}]*)?` accepts MyBatis type-hint syntax
 *  (`#{paramName,jdbcType=VARCHAR}`, `#{paramName,javaType=Long,
 *  jdbcType=NUMERIC}`) without capturing the hint into the
 *  param-name group — the hint is irrelevant to graph linkage. */
const PARAM_BIND_RE = /#\{([A-Za-z_][\w.]*)(?:,[^}]*)?\}/g;

/** Replace every `<!-- ... -->` block with equivalent-length
 *  whitespace so the regex passes that follow don't false-match
 *  element-shaped text inside comments. Newlines inside comments are
 *  preserved so `lineNumberAt` returns the same 1-indexed line a
 *  reader would see in the original source. Non-newline bytes inside
 *  the comment become spaces. */
function stripXmlComments(source: string): string {
  // Non-greedy `[\s\S]*?` so a doc file with many comments doesn't
  // collapse into one giant span between the first `<!--` and the
  // last `-->`. The `s` flag isn't used to stay ABI-stable across
  // tree-sitter / web-tree-sitter / node 18 vintage builds, and
  // `[\s\S]` is the canonical workaround.
  return source.replaceAll(/<!--[\s\S]*?-->/g, (match) => {
    let out = '';
    for (const ch of match) {
      // Replace each comment code point with a same-code-unit-width blank
      // (newline kept as-is) so byte offsets downstream stay aligned.
      out += ch === '\n' ? '\n' : ' '.repeat(ch.length);
    }
    return out;
  });
}

/** Map a byte offset in the source back to a 1-indexed line number. */
function lineNumberAt(source: string, offset: number): number {
  let line = 1;
  let codeUnitPos = 0;
  for (const ch of source) {
    if (codeUnitPos >= offset) break;
    if (ch.codePointAt(0) === 10) line++;
    codeUnitPos += ch.length;
  }
  return line;
}

/** Find the index of the closing tag `</tag>` after `fromIdx`. Returns
 *  the source length when no closing tag is found (treats the rest of
 *  the file as the body — handles malformed input without throwing).
 *  Bounded via `source.substring(fromIdx)`; the regex isn't `g`/`y`
 *  so `lastIndex` has no effect here and isn't used. */
function findClosingTag(source: string, tag: string, fromIdx: number): number {
  const closeRe = new RegExp(`</${tag}\\b[^>]*>`, 'i');
  const m = closeRe.exec(source.substring(fromIdx));
  return m ? fromIdx + m.index : source.length;
}

/** Turn a `<include refid="X"/>` value into the qualifiedName the
 *  resolver should look up. A bare `X` is local-namespace — return
 *  `<simpleClass>::X`. A dotted `a.b.c` references id `c` in class
 *  `b` — return `<b>::c`. */
function refidToQualifiedName(currentSimpleClass: string, refid: string): string {
  const lastDot = refid.lastIndexOf('.');
  if (lastDot < 0) return `${currentSimpleClass}::${refid}`;
  const id = refid.substring(lastDot + 1);
  const beforeId = refid.substring(0, lastDot);
  const classDot = beforeId.lastIndexOf('.');
  const cls = classDot < 0 ? beforeId : beforeId.substring(classDot + 1);
  return `${cls}::${id}`;
}

/** Shared inputs threaded into the per-section emit helpers of the
 *  Mapper-file path. Bundled into one object so each helper takes a
 *  single param (avoids `long_parameter_list`); the helpers mutate the
 *  `nodes` / `edges` / `unresolvedReferences` arrays in place, matching
 *  the inline accumulation the loops previously did. `ordinalById` is
 *  shared across the statement + mapping passes so id collisions across
 *  the two still get distinct ordinals (same Map the inline code used). */
interface MapperEmitArgs {
  filePath: string;
  source: string;
  simpleClass: string;
  fileId: string;
  now: number;
  ordinalById: Map<string, number>;
  nodes: Node[];
  edges: Edge[];
  unresolvedReferences: UnresolvedReference[];
}

/** Per-statement context for `emitStatementReferences`. Bundled into one
 *  object so the helper takes a single param (avoids
 *  `long_parameter_list`). `openingEnd` is the source offset just past
 *  the statement's opening tag (where the body begins); `openingText` is
 *  that opening tag verbatim (used for the resultMap/parameterMap attr
 *  scan); `startLine` is the opening tag's 1-indexed line. */
interface StatementReferenceArgs {
  filePath: string;
  source: string;
  simpleClass: string;
  nodeId: string;
  tag: string;
  id: string;
  startLine: number;
  openingEnd: number;
  openingText: string;
  unresolvedReferences: UnresolvedReference[];
}

/** Emit the references declared by a single MyBatis statement: the
 *  `resultMap="X"` / `parameterMap="X"` attribute refs, the
 *  `<include refid="X"/>` body refs, and the `#{paramName}` body refs.
 *  Behaviour is byte-for-byte the per-statement reference blocks that
 *  previously lived inline in the statement loop. */
function emitStatementReferences(args: StatementReferenceArgs): void {
  const { filePath, source, simpleClass, nodeId, tag, id, startLine, openingEnd, openingText, unresolvedReferences } =
    args;

  // F#64b v2 (2026-05-27) — link statements to the resultMap /
  // parameterMap they declare via attributes. Both nodes already
  // exist (xml.ts v1.1 emits them as `type_alias`); the missing
  // piece was the statement→mapping edge. Same `<Class>::<id>`
  // qualifiedName shape as the include-refid path, so the
  // standard resolver's qn-match resolves it for free.
  const resultMapMatch = RESULTMAP_ATTR_RE.exec(openingText);
  if (resultMapMatch) {
    unresolvedReferences.push({
      fromNodeId: nodeId,
      referenceName: refidToQualifiedName(simpleClass, resultMapMatch[1]!),
      referenceKind: 'references',
      line: startLine,
      column: 0,
      filePath,
      language: 'xml',
    });
  }
  const parameterMapMatch = PARAMETERMAP_ATTR_RE.exec(openingText);
  if (parameterMapMatch) {
    unresolvedReferences.push({
      fromNodeId: nodeId,
      referenceName: refidToQualifiedName(simpleClass, parameterMapMatch[1]!),
      referenceKind: 'references',
      line: startLine,
      column: 0,
      filePath,
      language: 'xml',
    });
  }

  // Scan the statement body for `<include refid="X"/>` patterns and
  // emit one UnresolvedReference per match. The standard resolver's
  // qualifiedName-match path resolves them against `<sql>` method
  // nodes mined elsewhere in the project.
  const closingStart = findClosingTag(source, tag, openingEnd);
  const body = source.substring(openingEnd, closingStart);
  INCLUDE_REFID_RE.lastIndex = 0;
  let inc: RegExpExecArray | null;
  while ((inc = INCLUDE_REFID_RE.exec(body)) !== null) {
    const refid = inc[1]!;
    const refLine = lineNumberAt(source, openingEnd + inc.index);
    unresolvedReferences.push({
      fromNodeId: nodeId,
      referenceName: refidToQualifiedName(simpleClass, refid),
      referenceKind: 'references',
      line: refLine,
      column: 0,
      filePath,
      language: 'xml',
    });
  }

  // F#64b v3 / v3.1: scan the statement body for `#{paramName}`
  // placeholders and emit one UnresolvedReference per occurrence.
  // The `referenceName` is the triple-segment qualifiedName
  // `<Class>::<method>::<param>` matching the shape the JVM
  // extractor's `tsEmitAnnotatedParameters` pass uses (v3 covers
  // Java, v3.1 added Kotlin), so the standard resolver's qn-match
  // binds these refs to the matching JVM parameter node
  // automatically — no hook sub-pass needed (same hands-off
  // strategy as v1.1 include-refid + v2 resultMap). Property
  // access (`#{user.name}`) takes only the head identifier so it
  // binds to the param node, not the nested property — the
  // property graph isn't carried for parameters.
  PARAM_BIND_RE.lastIndex = 0;
  let pb: RegExpExecArray | null;
  const seenInThisStatement = new Set<string>();
  while ((pb = PARAM_BIND_RE.exec(body)) !== null) {
    const head = pb[1]!.split('.', 1)[0]!;
    if (!head || seenInThisStatement.has(head)) continue;
    seenInThisStatement.add(head);
    const refLine = lineNumberAt(source, openingEnd + pb.index);
    unresolvedReferences.push({
      fromNodeId: nodeId,
      referenceName: `${simpleClass}::${id}::${head}`,
      referenceKind: 'references',
      line: refLine,
      column: 0,
      filePath,
      language: 'xml',
    });
  }
}

/** Emit one `kind:'method'` node per MyBatis statement
 *  (`<select|insert|update|delete|sql id="X">`), then delegate each
 *  statement's resultMap/parameterMap + include-refid + `#{paramName}`
 *  references to `emitStatementReferences`. Behaviour is byte-for-byte
 *  the inline statement loop that previously lived in `xmlExtract`. */
function emitMapperStatements(args: MapperEmitArgs): void {
  const { filePath, source, simpleClass, fileId, now, ordinalById, nodes, edges, unresolvedReferences } = args;

  STATEMENT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STATEMENT_RE.exec(source)) !== null) {
    const tag = m[1]!.toLowerCase();
    const id = m[2]!;
    const openingStart = m.index;
    const openingEnd = openingStart + m[0]!.length;
    const startLine = lineNumberAt(source, openingStart);
    const ordinal = ordinalById.get(id) ?? 0;
    ordinalById.set(id, ordinal + 1);
    const nodeId = generateNodeId({ filePath, kind: 'method', name: id, ordinal });
    nodes.push({
      id: nodeId,
      kind: 'method',
      name: id,
      qualifiedName: `${simpleClass}::${id}`,
      filePath,
      language: 'xml',
      startLine,
      endLine: startLine,
      startColumn: 0,
      endColumn: 0,
      signature: tag,
      updatedAt: now,
    });
    edges.push({ source: fileId, target: nodeId, kind: 'contains' });

    emitStatementReferences({
      filePath,
      source,
      simpleClass,
      nodeId,
      tag,
      id,
      startLine,
      openingEnd,
      openingText: m[0]!,
      unresolvedReferences,
    });
  }
}

/** Emit one `kind:'type_alias'` node per `<resultMap>` / `<parameterMap>`
 *  declaration. Behaviour is byte-for-byte the inline mapping loop that
 *  previously lived in `xmlExtract`. */
function emitMapperMappings(args: MapperEmitArgs): void {
  const { filePath, source, simpleClass, fileId, now, ordinalById, nodes, edges } = args;

  MAPPING_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MAPPING_RE.exec(source)) !== null) {
    const tag = m[1]!; // preserve original casing for the signature label
    const id = m[2]!;
    const openingText = m[0]!;
    const startLine = lineNumberAt(source, m.index);
    const typeMatch = TYPE_ATTR_RE.exec(openingText);
    const declaredType = typeMatch ? typeMatch[1]! : tag;
    const ordinal = ordinalById.get(id) ?? 0;
    ordinalById.set(id, ordinal + 1);
    const nodeId = generateNodeId({ filePath, kind: 'type_alias', name: id, ordinal });
    nodes.push({
      id: nodeId,
      kind: 'type_alias',
      name: id,
      qualifiedName: `${simpleClass}::${id}`,
      filePath,
      language: 'xml',
      startLine,
      endLine: startLine,
      startColumn: 0,
      endColumn: 0,
      signature: declaredType,
      updatedAt: now,
    });
    edges.push({ source: fileId, target: nodeId, kind: 'contains' });
  }
}

function xmlExtract(filePath: string, source: string): ExtractionResult {
  const startTime = Date.now();

  // Strip XML comments BEFORE the gate so a non-MyBatis file whose
  // comments happen to contain `<mapper namespace="...">` example
  // text doesn't falsely qualify, AND so statement-level regexes
  // never match element-shaped strings inside doc comments. The
  // replacement preserves byte length + newline positions so
  // `lineNumberAt` still maps offsets back to user-visible lines.
  source = stripXmlComments(source);

  // Two file shapes: MyBatis mapper file (`<mapper namespace="...">`
  // root) or MyBatis config file (`<configuration>` + `<mappers>`).
  // Try the mapper shape first since it's the more common path; fall
  // through to config-file extraction on no match. Other .xml files
  // (pom.xml, build configs, IDE descriptors) match neither gate and
  // get an empty result — they're tracked in `files` but emit no
  // symbols, same as a comment-only source file.
  const rootMatch = MYBATIS_ROOT_RE.exec(source);
  if (!rootMatch) {
    if (MYBATIS_CONFIG_ROOT_RE.test(source)) {
      return extractMybatisConfigFile(filePath, source, startTime);
    }
    return { nodes: [], edges: [], unresolvedReferences: [], errors: [], durationMs: Date.now() - startTime };
  }

  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const unresolvedReferences: UnresolvedReference[] = [];

  const namespace = rootMatch[1]!;
  // Last `.`-segment of the namespace = the simple class name of the
  // Mapper interface. MyBatis uses fully-qualified namespaces
  // (`com.example.UserMapper`) but the JVM (Java + Kotlin) extractor
  // sets `Node.qualifiedName = "UserMapper"` for the interface (not
  // package-qualified). Pre-compute it once so each node can use it.
  const lastDot = namespace.lastIndexOf('.');
  const simpleClass = lastDot >= 0 ? namespace.substring(lastDot + 1) : namespace;

  const lines = source.split('\n');
  const now = Date.now();
  const fileId = generateNodeId({ filePath, kind: 'file', name: filePath, ordinal: 0 });
  nodes.push({
    id: fileId,
    kind: 'file',
    name: filePath.split('/').pop() || filePath,
    qualifiedName: filePath,
    filePath,
    language: 'xml',
    startLine: 1,
    endLine: Math.max(1, lines.length),
    startColumn: 0,
    endColumn: lines.at(-1)?.length ?? 0,
    updatedAt: now,
  });

  // Per-id occurrence count for ordinal allocation. MyBatis disallows
  // duplicate ids inside one namespace, but a malformed file shouldn't
  // crash extraction — give each occurrence its own ordinal. Shared
  // across statement + mapping tags since id collisions across the
  // two would still produce the same node-id collision risk.
  const ordinalById = new Map<string, number>();
  const emitArgs: MapperEmitArgs = {
    filePath,
    source,
    simpleClass,
    fileId,
    now,
    ordinalById,
    nodes,
    edges,
    unresolvedReferences,
  };

  // ── Statements (select / insert / update / delete / sql) ──
  emitMapperStatements(emitArgs);

  // ── Mappings (resultMap / parameterMap) ──
  emitMapperMappings(emitArgs);

  return { nodes, edges, unresolvedReferences, errors: [], durationMs: Date.now() - startTime };
}

/**
 * F#64b v4 — Extract a Spring `mybatis-config.xml` file. Gates inside
 * `xmlExtract` confirm the shape (`<configuration>` + `<mappers>`)
 * before this is called.
 *
 * Emits:
 *   - File node.
 *   - One `UnresolvedReference` per `<mapper class="com.example.X"/>`
 *     declaration. `referenceName` is the simple class name (last
 *     dotted segment); the standard resolver's name-match path binds
 *     it to the Java/Kotlin Mapper interface node.
 *   - One `kind:'type_alias'` node per `<typeAlias alias="A"
 *     type="com.example.X"/>` declaration, qualifiedName =
 *     `<file>::<alias>`, signature = the declared type FQCN.
 *     NO paired graph edge to the target type — the common shape
 *     `<typeAlias alias="User" type="com.example.User"/>` has the
 *     alias + target sharing a simple name, which makes the
 *     resolver's name-match path race itself; the signature field
 *     carries the FQCN, which is enough for tool output.
 *
 * Deferred:
 *   - `<package name="com.example.mapper"/>` directives in `<mappers>`
 *     — this is auto-discovery (scan ALL classes in package), not a
 *     concrete reference. Could emit a metadata note in v4.1.
 *   - `<mapper resource="path/to/Mapper.xml"/>` — references an XML
 *     file, not a JVM class. The standard file-import resolution
 *     already covers cross-file mapper discovery.
 */
function extractMybatisConfigFile(filePath: string, source: string, startTime: number): ExtractionResult {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const unresolvedReferences: UnresolvedReference[] = [];

  const lines = source.split('\n');
  const now = Date.now();
  const fileId = generateNodeId({ filePath, kind: 'file', name: filePath, ordinal: 0 });
  nodes.push({
    id: fileId,
    kind: 'file',
    name: filePath.split('/').pop() || filePath,
    qualifiedName: filePath,
    filePath,
    language: 'xml',
    startLine: 1,
    endLine: Math.max(1, lines.length),
    startColumn: 0,
    endColumn: lines.at(-1)?.length ?? 0,
    updatedAt: now,
  });

  // ── <mapper class="com.example.X"/> declarations ──
  CONFIG_MAPPER_CLASS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CONFIG_MAPPER_CLASS_RE.exec(source)) !== null) {
    const fqcn = m[1]!;
    // Java/Kotlin interface qualifiedNames are simple class names, not
    // package-qualified. Last `.`-segment is what binds.
    const lastDot = fqcn.lastIndexOf('.');
    const simpleName = lastDot >= 0 ? fqcn.substring(lastDot + 1) : fqcn;
    if (!simpleName) continue;
    const line = lineNumberAt(source, m.index);
    unresolvedReferences.push({
      fromNodeId: fileId,
      referenceName: simpleName,
      referenceKind: 'references',
      line,
      column: 0,
      filePath,
      language: 'xml',
    });
  }

  // ── <typeAlias alias="A" type="com.example.X"/> declarations ──
  const aliasOrdinal = new Map<string, number>();
  TYPE_ALIAS_TAG_RE.lastIndex = 0;
  while ((m = TYPE_ALIAS_TAG_RE.exec(source)) !== null) {
    const openingText = m[0]!;
    const aliasMatch = ALIAS_ATTR_RE.exec(openingText);
    if (!aliasMatch) continue;
    const typeMatch = TYPE_ATTR_RE.exec(openingText);
    if (!typeMatch) continue;
    const alias = aliasMatch[1]!;
    const fqcn = typeMatch[1]!;
    const line = lineNumberAt(source, m.index);
    const ordinal = aliasOrdinal.get(alias) ?? 0;
    aliasOrdinal.set(alias, ordinal + 1);
    const nodeId = generateNodeId({ filePath, kind: 'type_alias', name: alias, ordinal });
    nodes.push({
      id: nodeId,
      kind: 'type_alias',
      name: alias,
      qualifiedName: `${filePath}::${alias}`,
      filePath,
      language: 'xml',
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: 0,
      signature: fqcn,
      updatedAt: now,
    });
    edges.push({ source: fileId, target: nodeId, kind: 'contains' });
    // NOTE: we deliberately do NOT emit a `type_of` UnresolvedReference
    // from the alias to its target type. The common-case shape
    // `<typeAlias alias="User" type="com.example.User"/>` produces an
    // alias node and a Java class that share the same simple name
    // (`User`); the standard resolver's name-match path then races
    // between self-binding and target-binding with no clean tiebreak.
    // The `signature` field already carries the declared FQCN
    // (`com.example.User`), which is enough to surface the linkage
    // in tool output — promoting it to a graph edge adds noise
    // without value. Re-enable if a consumer needs the edge.
  }

  return { nodes, edges, unresolvedReferences, errors: [], durationMs: Date.now() - startTime };
}

export const XML_DEF: LanguageDef = {
  name: 'xml',
  displayName: 'XML (MyBatis)',
  extensions: ['.xml'],
  // Scoped to MyBatis-convention paths — `mapper(s)/*.xml` and
  // `src/main/resources/**/*.xml`. A blanket `**/*.xml` glob picks up
  // every pom.xml / build.xml / IDE descriptor on every project. The
  // F#60 watcher-timing flake that motivated this narrowing was fixed
  // separately (task #14, 2026-05-27), but the narrow scope is still
  // semantically right for v1 — non-MyBatis XML adds extraction work
  // without producing graph value. Project-specific layouts add an
  // explicit glob in `.cartograph/config.json` when they need it.
  includeGlobs: [
    '**/mapper/**/*.xml',
    '**/mappers/**/*.xml',
    '**/src/main/resources/**/*.xml',
    '**/resources/mybatis/**/*.xml',
  ],
  customExtractor: xmlExtract,
};
