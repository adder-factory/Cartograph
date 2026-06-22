/**
 * Drupal framework resolver (F#62, 2026-05-26; F#69 hook-detection
 * moved to an index-hook 2026-05-28).
 *
 * Detects Drupal 8/9/10/11 projects via composer.json `drupal/*` deps.
 * Two extraction surfaces + one resolver path:
 *
 *  1. **`*.routing.yml` files** — parses the YAML AST via tree-sitter
 *     (no regex), walks each top-level mapping pair as a route
 *     definition. Emits a `route` node per route + `references`
 *     unresolved-refs to the `_controller` / `_form` / `_entity_*`
 *     handler FQCN. Uses the new `FrameworkResolver.extract()` hook.
 *
 *  1b. **`*.services.yml` files** (Drupal v2, 2026-05-29) — walks the
 *     top-level `services:` mapping. Emits a `resource` node per service
 *     id + `references` to its implementing `class:` FQCN (or the id
 *     itself for the `Drupal\My\Foo:` shorthand) and to every
 *     `@service_id` argument / `alias:` target. `_defaults`/`_instanceof`
 *     pseudo-keys are skipped.
 *
 *  2. **Resolution** — `_controller: '\Drupal\…\Foo::bar'` resolves
 *     to method `bar` on class `Foo` (or class node fallback);
 *     `_form: '\Drupal\…\Form\MyForm'` resolves to the class;
 *     `hook_X` resolves to the first matching `*_X` function in any
 *     hook file. The `hook_X` resolution path remains here so refs
 *     to `hook_X` emitted from elsewhere (e.g. cross-file traversal,
 *     future YAML / annotation extraction) still resolve, even
 *     though the in-tree hook-implementation discovery moved to
 *     [`src/index-hooks/drupal-hooks.ts`](../../index-hooks/drupal-hooks.ts).
 *
 * Hook-implementation discovery (`.module` / `.install` / `.theme` /
 * `.inc` files) lives in the [`drupal-hooks` index-hook](../../index-hooks/drupal-hooks.ts)
 * — F#69 (2026-05-28) moved it out of `extract()` so the detection
 * walks indexed PHP function nodes instead of regex-scanning source.
 *
 * Adapted from upstream 5b71a895 (PR #271) with corrections:
 *   - Routing.yml parsing via tree-sitter-yaml AST (upstream used
 *     regex; this avoids the YAML-anchors / multi-line-value /
 *     comment-collision bug class).
 *   - Route node IDs use content hash (via `generateNodeId`) — not
 *     line-numbered strings. Preserves the G7 stable-node-id
 *     contract: a route's id doesn't drift when an unrelated
 *     comment moves it down a line.
 *
 * Plugin discovery (docblock `@Block(id = "…")` annotations → `resource`
 * node per plugin id) lives in the [`drupal-plugins` index-hook](../../index-hooks/drupal-plugins.ts)
 * — Drupal v3, 2026-05-29 — for the same reason hook discovery does:
 * it walks indexed PHP class nodes + their docstrings, no source re-parse.
 *
 * services.yml coverage (v4): `class:` / `alias:` / `parent:`, both
 * `@service` factories AND class-static-method factories
 * (`['Drupal\My\F','create']` / `'Drupal\My\F::create'` → the class FQCN),
 * and arguments in BOTH positional (`['@a']`) and named (`{ $a: '@a' }`)
 * form. Service tags (`tags:` providers + `!tagged_iterator` consumers)
 * are linked project-wide by the
 * [`drupal-service-tags` index-hook](../../index-hooks/drupal-service-tags.ts)
 * — a single file can't see other modules' tags, so the cross-module
 * linkage lives in a post-extraction pass. PHP-8-attribute plugins
 * (`#[Block(id: '…')]`, Drupal 11) are covered by `drupal-plugins.ts` (v4).
 *
 * Virtual `hook_*` contract nodes (when Drupal core isn't indexed) are
 * synthesized by the
 * [`drupal-hooks` index-hook](../../index-hooks/drupal-hooks.ts) (v4).
 *
 * Still deferred:
 *   - Twig template scanning (no shipped tree-sitter-twig grammar)
 */

import type { UnresolvedReference } from '../../extraction/types.js';
import type { Node, NodeKind } from '../../types.js';
import type { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types.js';
import { generateNodeId } from '../../extraction/tree-sitter-helpers.js';
import { getParser } from '../../extraction/grammars.js';
import { logWarn } from '../../errors.js';
import { hasComposerDependencyMatching } from './composer-manifest.js';

/** Drupal hook-file extensions. Files matching these are the
 *  `.module` / `.install` / `.theme` / `.inc` shape that carry hook
 *  implementations. Re-used by the [`drupal-hooks` index-hook](../../index-hooks/drupal-hooks.ts)
 *  so the two surfaces don't drift if the extension set grows. */
export const HOOK_FILE_EXTENSIONS = ['.module', '.install', '.theme', '.inc'] as const;

function isDrupalHookFile(filePath: string): boolean {
  return HOOK_FILE_EXTENSIONS.some((ext) => filePath.endsWith(ext));
}

/** Parse the last segment from a Drupal FQCN like
 *  `\Drupal\my_module\Controller\Foo`. Returns null when the input
 *  doesn't look like a backslash-separated FQCN. */
function lastFqcnSegment(fqcn: string): string | null {
  const clean = fqcn.replace(/^\\+/, '').trim();
  if (!clean.includes('\\')) return null;
  const parts = clean.split('\\');
  return parts.at(-1) ?? null;
}

interface YamlNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  namedChildren: YamlNode[];
}

/** Read the text of a yaml `flow_node` key/value, stripping quote
 *  wrappers if present. Plain scalars are stored verbatim; single-
 *  and double-quoted strings drop their delimiters. */
function readYamlScalar(node: YamlNode): string {
  const raw = node.text;
  if (raw.length >= 2) {
    const first = raw.charAt(0);
    const last = raw.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return raw.substring(1, raw.length - 1);
    }
  }
  return raw;
}

/** Find a mapping pair whose key matches `keyName` directly under the
 *  given mapping node. Handles both block mappings (`block_mapping_pair`)
 *  and inline/flow mappings (`flow_pair`, e.g. `{ name: x }`). */
function findMappingPair(mapping: YamlNode, keyName: string): YamlNode | null {
  for (const pair of mapping.namedChildren) {
    if (pair.type !== 'block_mapping_pair' && pair.type !== 'flow_pair') continue;
    const keyNode = pair.namedChildren[0];
    if (!keyNode) continue;
    const keyText = readYamlScalar(keyNode);
    if (keyText === keyName) return pair;
  }
  return null;
}

/** Get the value node of a `block_mapping_pair`. */
function pairValue(pair: YamlNode): YamlNode | null {
  return pair.namedChildren[1] ?? null;
}

/** Read a pair's value as a scalar, tolerating a missing pair OR a
 *  value-less key (`class:` with nothing after it) — both yield null
 *  rather than throwing. */
function readPairScalar(pair: YamlNode | null): string | null {
  const value = pair ? pairValue(pair) : null;
  return value ? readYamlScalar(value) : null;
}

/** Descend a `block_node > block_mapping` chain to find the inner
 *  `block_mapping` so callers can iterate `block_mapping_pair`s
 *  directly. Returns null when the shape doesn't match. */
function asMapping(node: YamlNode | null): YamlNode | null {
  if (!node) return null;
  if (node.type === 'block_mapping' || node.type === 'flow_mapping') return node;
  const inner = node.namedChildren.find((c) => c.type === 'block_mapping' || c.type === 'flow_mapping');
  return inner ?? null;
}

interface RoutingHandler {
  fqcn: string;
  /** 1-indexed line where the handler reference appears (for the unresolved-ref). */
  line: number;
}

/** Extract handler FQCNs from a Drupal route's `defaults` mapping.
 *  Catches `_controller`, `_form`, `_entity_form`, `_entity_list`,
 *  `_entity_view`. */
function collectHandlers(defaultsMapping: YamlNode): RoutingHandler[] {
  const handlers: RoutingHandler[] = [];
  const handlerKeys = new Set(['_controller', '_form', '_entity_form', '_entity_list', '_entity_view']);
  for (const pair of defaultsMapping.namedChildren) {
    if (pair.type !== 'block_mapping_pair') continue;
    const keyNode = pair.namedChildren[0];
    if (!keyNode) continue;
    const key = readYamlScalar(keyNode);
    if (!handlerKeys.has(key)) continue;
    const valueNode = pair.namedChildren[1];
    if (!valueNode) continue;
    handlers.push({
      fqcn: readYamlScalar(valueNode),
      line: keyNode.startPosition.row + 1,
    });
  }
  return handlers;
}

/** Format the `methods: [GET, POST]` suffix when present. */
function readMethodsList(mapping: YamlNode): string[] {
  const pair = findMappingPair(mapping, 'methods');
  if (!pair) return [];
  const value = pairValue(pair);
  if (!value) return [];
  const flow = value.type === 'flow_node' ? value : null;
  const seq = flow?.namedChildren.find((c) => c.type === 'flow_sequence');
  if (!seq) return [];
  const out: string[] = [];
  for (const item of seq.namedChildren) {
    if (item.type !== 'flow_node') continue;
    const v = readYamlScalar(item).toUpperCase();
    if (v) out.push(v);
  }
  return out;
}

/** Build the `references` a single route emits from its `defaults`
 *  mapping — one `references` ref per handler FQCN (`_controller` /
 *  `_form` / `_entity_*`). Returns `[]` when the route has no
 *  `defaults` mapping. */
function collectRouteHandlerReferences(routeBodyMapping: YamlNode, routeId: string): UnresolvedReference[] {
  const defaultsPair = findMappingPair(routeBodyMapping, 'defaults');
  const defaultsMapping = defaultsPair ? asMapping(pairValue(defaultsPair)) : null;
  if (!defaultsMapping) return [];
  return collectHandlers(defaultsMapping).map((handler) => ({
    fromNodeId: routeId,
    referenceName: handler.fqcn,
    referenceKind: 'references' as const,
    line: handler.line,
    column: 0,
  }));
}

/** Process one top-level routing.yml `block_mapping_pair` into a `route`
 *  node + its handler references. Returns null when the pair isn't a
 *  well-formed route (missing name/body, non-mapping body, or no `path:`)
 *  — the caller skips it. Behaviour matches the inline loop body it
 *  replaced exactly (same guards, same ordering, same ids). */
function extractRouteFromPair(
  routePair: YamlNode,
  filePath: string,
  now: number,
): { node: Node; references: UnresolvedReference[] } | null {
  if (routePair.type !== 'block_mapping_pair') return null;
  const routeNameNode = routePair.namedChildren[0];
  const routeBodyNode = routePair.namedChildren[1];
  if (!routeNameNode || !routeBodyNode) return null;
  const routeName = readYamlScalar(routeNameNode);
  const routeBodyMapping = asMapping(routeBodyNode);
  if (!routeBodyMapping) return null;

  const pathPair = findMappingPair(routeBodyMapping, 'path');
  const pathValue = pathPair ? readYamlScalar(pairValue(pathPair)!) : null;
  if (!pathValue) return null;

  const methods = readMethodsList(routeBodyMapping);
  const methodTag = methods.length > 0 ? ` [${methods.join(',')}]` : '';
  const displayName = `${pathValue}${methodTag}`;
  const lineNum = routeNameNode.startPosition.row + 1;

  const routeId = generateNodeId({
    filePath,
    kind: 'route',
    name: `${routeName}::${pathValue}`,
    ordinal: 0,
  });
  const node: Node = {
    id: routeId,
    kind: 'route' as NodeKind,
    name: displayName,
    qualifiedName: `${filePath}::${routeName}`,
    filePath,
    language: 'yaml',
    startLine: lineNum,
    endLine: lineNum,
    startColumn: 0,
    endColumn: 0,
    updatedAt: now,
  };

  return { node, references: collectRouteHandlerReferences(routeBodyMapping, routeId) };
}

/** Walk a routing.yml AST and emit one route per top-level
 *  mapping-pair + references to its handler classes/methods. */
function extractDrupalRoutes(filePath: string, content: string): { nodes: Node[]; references: UnresolvedReference[] } {
  const parser = getParser('yaml');
  if (!parser) {
    // F#71 — surface the failure rather than silently dropping the
    // file's routes. In production `loadAllGrammars` is called before
    // any framework resolver runs, so a null parser here means a real
    // load-order or vendoring regression. logWarn keeps the rest of
    // the index alive (matches the surrounding try/catch in the
    // orchestrator) but the warning makes the regression visible.
    logWarn('Drupal: yaml grammar not loaded; skipping routing.yml', { filePath });
    return { nodes: [], references: [] };
  }
  const tree = parser.parse(content);
  if (!tree) return { nodes: [], references: [] };
  const root = tree.rootNode as unknown as YamlNode;
  const nodes: Node[] = [];
  const references: UnresolvedReference[] = [];
  const now = Date.now();

  // Walk stream > document > block_node > block_mapping > pairs.
  for (const doc of root.namedChildren) {
    if (doc.type !== 'document') continue;
    const docBody = doc.namedChildren[0];
    const topMapping = asMapping(docBody ?? null);
    if (!topMapping) continue;

    for (const routePair of topMapping.namedChildren) {
      const route = extractRouteFromPair(routePair, filePath, now);
      if (!route) continue;
      nodes.push(route.node);
      references.push(...route.references);
    }
  }
  return { nodes, references };
}

// ---------------------------------------------------------------------------
// services.yml (Drupal v2, 2026-05-29)
// ---------------------------------------------------------------------------

/** A scalar leaf of a YAML sequence with its 1-indexed line. */
interface SequenceScalar {
  text: string;
  line: number;
}

/** Descend to the `flow_sequence` / `block_sequence` inside a value node
 *  (the sibling of {@link asMapping} for sequences). Returns null when the
 *  value isn't a sequence in any wrapper shape. */
function asSequence(value: YamlNode | null): YamlNode | null {
  if (!value) return null;
  if (value.type === 'flow_sequence' || value.type === 'block_sequence') return value;
  return value.namedChildren.find((c) => c.type === 'flow_sequence' || c.type === 'block_sequence') ?? null;
}

/** Collect scalar items from a YAML sequence value, handling BOTH the
 *  flow form (`['@a', '@b']`) and the block form (`- '@a'` lines). Returns
 *  each item's unwrapped scalar text + line. Non-scalar items (nested
 *  mappings/sequences — e.g. tagged or named arguments) are skipped. */
function collectSequenceScalars(value: YamlNode | null): SequenceScalar[] {
  const seq = asSequence(value);
  if (!seq) return [];
  const out: SequenceScalar[] = [];
  for (const item of seq.namedChildren) {
    // flow_sequence → flow_node items directly; block_sequence →
    // block_sequence_item wrapping a flow_node leaf.
    const leaf = item.type === 'block_sequence_item' ? (item.namedChildren[0] ?? null) : item;
    if (!leaf || (leaf.type !== 'flow_node' && leaf.type !== 'plain_scalar')) continue;
    out.push({ text: readYamlScalar(leaf), line: leaf.startPosition.row + 1 });
  }
  return out;
}

/** Collect the VALUES of a named-argument mapping (`arguments: { $logger:
 *  '@logger.channel.default' }`) as scalar leaves with their line. The
 *  `$name` keys are PHP parameter names (documentation only); the value
 *  (a `@service` ref or `%param%`) is what we emit. Returns [] when the
 *  value isn't a mapping — so a positional `arguments:` sequence is a
 *  no-op here and flows through {@link collectSequenceScalars} instead. */
function collectMappingArguments(value: YamlNode | null): SequenceScalar[] {
  const mapping = asMapping(value);
  if (!mapping) return [];
  const out: SequenceScalar[] = [];
  for (const pair of mapping.namedChildren) {
    if (pair.type !== 'block_mapping_pair' && pair.type !== 'flow_pair') continue;
    const v = pairValue(pair);
    if (!v) continue;
    out.push({ text: readYamlScalar(v), line: v.startPosition.row + 1 });
  }
  return out;
}

interface ServiceRefArgs {
  bodyMapping: YamlNode | null;
  serviceId: string;
  serviceNodeId: string;
  /** Line of the service-id key — fallback for the class ref when the
   *  class comes from the FQCN-shorthand id rather than a `class:` pair. */
  defLine: number;
}

/** Collect the `references` a single service definition emits: its
 *  implementing `class:` FQCN (or the id itself for the `Drupal\My\Foo:`
 *  shorthand), its `alias:` target, and each `@service_id` argument. Alias
 *  and argument refs are emitted as the BARE id (no `@`) so they pass the
 *  resolver's known-name pre-filter (a service id is a `resource` node name). */
function collectServiceReferences(args: ServiceRefArgs): UnresolvedReference[] {
  const { bodyMapping, serviceId, serviceNodeId, defLine } = args;
  const refs: UnresolvedReference[] = [];
  const addRef = (referenceName: string, line: number): void => {
    refs.push({ fromNodeId: serviceNodeId, referenceName, referenceKind: 'references', line, column: 0 });
  };
  if (!bodyMapping) {
    // Shorthand `Drupal\My\Foo:` with a null/empty body — the id is the class.
    if (serviceId.includes('\\')) addRef(serviceId, defLine);
    return refs;
  }

  collectClassAliasParentRefs({ bodyMapping, serviceId, defLine, addRef });
  const factoryRef = collectFactoryRef(findMappingPair(bodyMapping, 'factory'));
  if (factoryRef) addRef(factoryRef.id, factoryRef.line);
  collectArgumentRefs(bodyMapping, addRef);
  return refs;
}

interface ServiceRefCollectorArgs {
  bodyMapping: YamlNode;
  serviceId: string;
  defLine: number;
  addRef(referenceName: string, line: number): void;
}

function collectClassAliasParentRefs(args: ServiceRefCollectorArgs): void {
  const { bodyMapping, serviceId, defLine, addRef } = args;
  const classPair = findMappingPair(bodyMapping, 'class');
  const classValue = readPairScalar(classPair);
  const classFqcn = classValue ?? (serviceId.includes('\\') ? serviceId : null);
  if (classFqcn) addRef(classFqcn, classPair ? classPair.startPosition.row + 1 : defLine);

  const aliasPair = findMappingPair(bodyMapping, 'alias');
  const aliasTarget = readPairScalar(aliasPair);
  if (aliasPair && aliasTarget) addRef(aliasTarget, aliasPair.startPosition.row + 1);

  // `parent: base.service` — service inheritance (bare service id).
  const parentPair = findMappingPair(bodyMapping, 'parent');
  const parentTarget = readPairScalar(parentPair);
  if (parentPair && parentTarget) addRef(parentTarget, parentPair.startPosition.row + 1);
}

function collectArgumentRefs(bodyMapping: YamlNode, addRef: (referenceName: string, line: number) => void): void {
  const argsPair = findMappingPair(bodyMapping, 'arguments');
  if (!argsPair) return;
  const argsValue = pairValue(argsPair);
  // Positional form `arguments: ['@a', '@b']` and named form
  // `arguments: { $a: '@a' }` are mutually exclusive shapes.
  for (const arg of [...collectSequenceScalars(argsValue), ...collectMappingArguments(argsValue)]) {
    const refId = serviceRefId(arg.text);
    if (refId) addRef(refId, arg.line);
  }
}

/** Extract the ref a `factory:` references, from the four common forms:
 *  `factory: ['@svc', 'method']` / `'@svc:method'` (a service factory →
 *  bare service id) and `factory: ['Drupal\My\F', 'create']` /
 *  `'Drupal\My\F::create'` (a class-static-method factory → the class
 *  FQCN, which resolves via the backslash-qualified pre-filter, same as a
 *  `class:` ref). Bare-id / non-FQCN forms return null. */
function collectFactoryRef(factoryPair: YamlNode | null): { id: string; line: number } | null {
  if (!factoryPair) return null;
  const value = pairValue(factoryPair);
  if (!value) return null;
  const seq = collectSequenceScalars(value);
  if (seq.length > 0) {
    const first = seq[0]!;
    const svcId = serviceRefId(first.text);
    if (svcId) return { id: svcId, line: first.line };
    // Class-static-method factory `['Drupal\My\F', 'create']` — emit the
    // class FQCN (seq.length >= 2 ⇒ [class, method]; require a backslash
    // so a bare non-class scalar isn't mistaken for one).
    if (seq.length >= 2 && first.text.includes('\\')) return { id: first.text, line: first.line };
    return null;
  }
  if (value.type === 'flow_node' || value.type === 'plain_scalar') {
    const raw = readYamlScalar(value);
    const svcId = serviceRefId(raw.split(':')[0]!);
    if (svcId) return { id: svcId, line: factoryPair.startPosition.row + 1 };
    // Scalar class-static factory `'Drupal\My\F::create'` — the FQCN is
    // the part before `::`.
    if (raw.includes('::') && raw.includes('\\')) {
      return { id: raw.split('::')[0]!, line: factoryPair.startPosition.row + 1 };
    }
    return null;
  }
  return null;
}

/** Strip a Symfony/Drupal service-argument prefix. `@svc` and the
 *  optional-service `@?svc` both reference service `svc`; anything else
 *  (a `%param%`, a plain scalar) is not a service ref → null. */
function serviceRefId(arg: string): string | null {
  const m = /^@\??(.+)$/.exec(arg);
  if (!m) return null;
  const id = m[1]!.trim();
  // `@@literal` escapes a leading @ — not a service ref.
  return id.startsWith('@') ? null : id;
}

/** Walk a `*.services.yml` AST and emit one `resource` node per service
 *  definition under the top-level `services:` mapping, plus `references`
 *  to (a) the service's implementing `class:` FQCN and (b) every
 *  `@service_id` argument / `alias:` target. */
function extractDrupalServices(
  filePath: string,
  content: string,
): { nodes: Node[]; references: UnresolvedReference[] } {
  const parser = getParser('yaml');
  if (!parser) {
    logWarn('Drupal: yaml grammar not loaded; skipping services.yml', { filePath });
    return { nodes: [], references: [] };
  }
  const tree = parser.parse(content);
  if (!tree) return { nodes: [], references: [] };
  const root = tree.rootNode as unknown as YamlNode;
  const nodes: Node[] = [];
  const references: UnresolvedReference[] = [];
  const now = Date.now();

  for (const doc of root.namedChildren) {
    const servicesMapping = findDrupalServicesMapping(doc);
    if (!servicesMapping) continue;
    for (const svcPair of servicesMapping.namedChildren) {
      const extracted = extractDrupalServicePair({ svcPair, filePath, now });
      if (!extracted) continue;
      nodes.push(extracted.node);
      references.push(...extracted.references);
    }
  }
  return { nodes, references };
}

function findDrupalServicesMapping(doc: YamlNode): YamlNode | null {
  if (doc.type !== 'document') return null;
  const topMapping = asMapping(doc.namedChildren[0] ?? null);
  if (!topMapping) return null;
  const servicesPair = findMappingPair(topMapping, 'services');
  return servicesPair ? asMapping(pairValue(servicesPair)) : null;
}

function extractDrupalServicePair(args: {
  svcPair: YamlNode;
  filePath: string;
  now: number;
}): { node: Node; references: UnresolvedReference[] } | null {
  const { svcPair, filePath, now } = args;
  if (svcPair.type !== 'block_mapping_pair') return null;
  const idNode = svcPair.namedChildren[0];
  if (!idNode) return null;
  const serviceId = readYamlScalar(idNode);
  if (!serviceId || serviceId.startsWith('_')) return null;

  const lineNum = idNode.startPosition.row + 1;
  const serviceNodeId = generateNodeId({ filePath, kind: 'resource', name: serviceId, ordinal: 0 });
  const node: Node = {
    id: serviceNodeId,
    kind: 'resource' as NodeKind,
    name: serviceId,
    qualifiedName: `${filePath}::${serviceId}`,
    filePath,
    language: 'yaml',
    startLine: lineNum,
    endLine: lineNum,
    startColumn: 0,
    endColumn: 0,
    updatedAt: now,
  };
  const references = collectServiceReferences({
    bodyMapping: asMapping(pairValue(svcPair)),
    serviceId,
    serviceNodeId,
    defLine: lineNum,
  });
  return { node, references };
}

/** One service↔tag relationship parsed from a `*.services.yml`: a service
 *  either PROVIDES a tag (`tags: [{ name: X }]`) or CONSUMES one
 *  (`arguments: [!tagged_iterator X]`). Consumed by the project-wide
 *  [`drupal-service-tags` index-hook](../../index-hooks/drupal-service-tags.ts),
 *  which links providers and consumers through one synthetic tag node so
 *  the linkage spans modules (a single file can't know the others' tags). */
export interface DrupalServiceTagFact {
  serviceId: string;
  tagName: string;
  role: 'provides' | 'consumes';
  /** 1-indexed line of the tag reference. */
  line: number;
}

/** Read a tagged-services argument value (`!tagged_iterator some.tag`, or
 *  the verbose `!tagged_iterator { tag: some.tag, … }`). Returns the tag
 *  name when the node carries a `!tagged*` YAML tag, else null. */
function readTaggedArg(node: YamlNode): string | null {
  // The tag + its value sit under a `flow_node`; unwrap one layer if the
  // tag child isn't directly present.
  const host = node.namedChildren.some((c) => c.type === 'tag')
    ? node
    : (node.namedChildren.find((c) => c.type === 'flow_node') ?? node);
  const tagChild = host.namedChildren.find((c) => c.type === 'tag');
  if (!tagChild?.text.startsWith('!tagged')) return null;
  const rest = host.namedChildren.find((c) => c.type !== 'tag');
  if (!rest) return null;
  // Verbose form carries a `tag:` key; scalar form is the tag name itself.
  const mapping = asMapping(rest);
  return mapping ? readPairScalar(findMappingPair(mapping, 'tag')) : readYamlScalar(rest);
}

/** Collect the `name` of each declared service tag from a `tags:` value
 *  (`- { name: X, priority: N }` block or `[{ name: X }]` flow). */
function collectDeclaredTags(tagsValue: YamlNode | null): Array<{ name: string; line: number }> {
  const seq = asSequence(tagsValue);
  if (!seq) return [];
  const out: Array<{ name: string; line: number }> = [];
  for (const item of seq.namedChildren) {
    const leaf = item.type === 'block_sequence_item' ? (item.namedChildren[0] ?? null) : item;
    const mapping = asMapping(leaf);
    if (!mapping) continue;
    const namePair = findMappingPair(mapping, 'name');
    const name = readPairScalar(namePair);
    if (name) out.push({ name, line: (namePair ?? leaf!).startPosition.row + 1 });
  }
  return out;
}

/** Parse the service↔tag facts from a `*.services.yml` document — both the
 *  `tags:` declarations (PROVIDES) and the `!tagged_iterator` arguments
 *  (CONSUMES), positional or named-arg form. Pure parse; the index-hook
 *  resolves service ids to nodes and wires the cross-module tag graph. */
export function extractServiceTagFacts(content: string): DrupalServiceTagFact[] {
  const parser = getParser('yaml');
  if (!parser) return [];
  const tree = parser.parse(content);
  if (!tree) return [];
  const root = tree.rootNode as unknown as YamlNode;
  const facts: DrupalServiceTagFact[] = [];
  for (const doc of root.namedChildren) {
    if (doc.type !== 'document') continue;
    const topMapping = asMapping(doc.namedChildren[0] ?? null);
    if (!topMapping) continue;
    const servicesPair = findMappingPair(topMapping, 'services');
    const servicesMapping = servicesPair ? asMapping(pairValue(servicesPair)) : null;
    if (!servicesMapping) continue;

    for (const svcPair of servicesMapping.namedChildren) collectFactsFromServicePair(svcPair, facts);
  }
  return facts;
}

function collectFactsFromServicePair(svcPair: YamlNode, facts: DrupalServiceTagFact[]): void {
  if (svcPair.type !== 'block_mapping_pair') return;
  const idNode = svcPair.namedChildren[0];
  if (!idNode) return;
  const serviceId = readYamlScalar(idNode);
  if (!serviceId || serviceId.startsWith('_')) return;
  const body = asMapping(pairValue(svcPair));
  if (body) collectServiceTagFacts(body, serviceId, facts);
}

/** Append a single service's tag facts (provides + consumes) to `facts`. */
function collectServiceTagFacts(body: YamlNode, serviceId: string, facts: DrupalServiceTagFact[]): void {
  const tagsPair = findMappingPair(body, 'tags');
  for (const t of collectDeclaredTags(tagsPair ? pairValue(tagsPair) : null)) {
    facts.push({ serviceId, tagName: t.name, role: 'provides', line: t.line });
  }
  const argsPair = findMappingPair(body, 'arguments');
  const argsValue = argsPair ? pairValue(argsPair) : null;
  for (const argNode of taggedArgNodes(argsValue)) {
    const tagName = readTaggedArg(argNode);
    if (tagName) facts.push({ serviceId, tagName, role: 'consumes', line: argNode.startPosition.row + 1 });
  }
}

/** The candidate arg nodes that may carry a `!tagged_iterator` — items of a
 *  positional `arguments:` sequence AND values of a named-arg mapping. */
function taggedArgNodes(argsValue: YamlNode | null): YamlNode[] {
  if (!argsValue) return [];
  const out: YamlNode[] = [];
  collectTaggedSequenceArgNodes(argsValue, out);
  collectTaggedMappingArgNodes(argsValue, out);
  return out;
}

function collectTaggedSequenceArgNodes(argsValue: YamlNode, out: YamlNode[]): void {
  const seq = asSequence(argsValue);
  if (!seq) return;
  for (const item of seq.namedChildren) {
    const leaf = item.type === 'block_sequence_item' ? (item.namedChildren[0] ?? null) : item;
    if (leaf) out.push(leaf);
  }
}

function collectTaggedMappingArgNodes(argsValue: YamlNode, out: YamlNode[]): void {
  const mapping = asMapping(argsValue);
  if (!mapping) return;
  for (const pair of mapping.namedChildren) {
    if (pair.type !== 'block_mapping_pair' && pair.type !== 'flow_pair') continue;
    const v = pairValue(pair);
    if (v) out.push(v);
  }
}

function frameworkResolved(ref: UnresolvedRef, targetNodeId: string, confidence: number): ResolvedRef {
  return { original: ref, targetNodeId, confidence, resolvedBy: 'framework' };
}

function resolveDrupalController(ref: UnresolvedRef, context: ResolutionContext, name: string): ResolvedRef | null {
  const controllerMatch = /^\\?(?:Drupal\\[^:]+\\)?([^\\:]+)::(\w+)$/.exec(name);
  if (!controllerMatch) return null;
  const className = controllerMatch[1];
  const methodName = controllerMatch[2];
  if (!className || !methodName) return null;

  for (const cls of context.getNodesByName(className)) {
    if (cls.kind !== 'class') continue;
    const method = context.getNodesInFile(cls.filePath).find((n) => n.kind === 'method' && n.name === methodName);
    return frameworkResolved(ref, method?.id ?? cls.id, method ? 0.9 : 0.7);
  }
  return null;
}

function resolveDrupalFqcn(ref: UnresolvedRef, context: ResolutionContext, name: string): ResolvedRef | null {
  if (!name.includes('\\') || name.includes('::')) return null;
  const className = lastFqcnSegment(name);
  if (!className) return null;
  const cls = context.getNodesByName(className).find((n) => n.kind === 'class');
  return cls ? frameworkResolved(ref, cls.id, 0.85) : null;
}

function resolveDrupalHook(ref: UnresolvedRef, context: ResolutionContext, name: string): ResolvedRef | null {
  if (!name.startsWith('hook_')) return null;
  const suffixLower = `_${name.slice('hook_'.length)}`;
  const first = context
    .getNodesByKind('function')
    .find((n) => n.name.endsWith(suffixLower) && isDrupalHookFile(n.filePath));
  return first ? frameworkResolved(ref, first.id, 0.75) : null;
}

function resolveDrupalService(ref: UnresolvedRef, context: ResolutionContext, name: string): ResolvedRef | null {
  const svc = context.getNodesByName(name).find((n) => n.kind === 'resource');
  return svc ? frameworkResolved(ref, svc.id, 0.85) : null;
}

export const drupalResolver: FrameworkResolver = {
  name: 'drupal',
  languages: ['php', 'yaml'],

  detect(context: ResolutionContext): boolean {
    return hasComposerDependencyMatching(context.readFile('composer.json'), (name) => name.startsWith('drupal/'));
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    const name = ref.referenceName;

    return (
      resolveDrupalController(ref, context, name) ??
      resolveDrupalFqcn(ref, context, name) ??
      resolveDrupalHook(ref, context, name) ??
      resolveDrupalService(ref, context, name)
    );
  },

  extract(filePath: string, content: string): { nodes: Node[]; references: UnresolvedReference[] } {
    if (filePath.endsWith('.routing.yml')) {
      return extractDrupalRoutes(filePath, content);
    }
    if (filePath.endsWith('.services.yml')) {
      return extractDrupalServices(filePath, content);
    }
    // Hook-implementation discovery moved to the `drupal-hooks` index-hook
    // (F#69, 2026-05-28). The hook walks indexed PHP function nodes after
    // extraction completes, so this surface no longer scans `.module` /
    // `.install` / `.theme` / `.inc` files.
    return { nodes: [], references: [] };
  },
};
