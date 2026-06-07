/**
 * Salesforce framework resolver.
 *
 * Bridges documented Salesforce source forms:
 * - LWC `@salesforce/apex/Class.method` imports to Apex methods.
 * - LWC `c/foo` imports and `<c-foo>` tags to local component bundles.
 * - Aura `{!c.action}` markup calls to same-bundle client-controller methods.
 * - Aura `component.get("c.serverMethod")` strings to the component's Apex controller.
 * - Visualforce controller / extension refs and `action="{!method}"` calls to Apex.
 */
import * as path from 'node:path';
import type { Language, Node } from '../../types.js';
import { makeLineIndex, normalizePath } from '../../utils.js';
import type { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types.js';
import type { UnresolvedReference } from '../../extraction/types.js';

const SALESFORCE_COMPONENT_KINDS = new Set<Node['kind']>(['component', 'resource']);
const AURA_CLIENT_ACTION_DECORATOR = 'AuraClientAction';
const LWC_COMPONENT_DECORATOR = 'LwcComponent';
const APEX_IMPORT_RE = /^@salesforce\/(?:apex|apexContinuation)\/(?:([A-Za-z_]\w*)\.)?([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/;
const CUSTOM_ELEMENT_RE = /<\s*c-([a-z][a-z0-9_-]*)\b/gi;
const AURA_ACTION_METHOD_RE = /\b([A-Za-z_]\w*)\s*:\s*function\s*\(/g;
const AURA_APEX_ACTION_RE = /\b(?:component|cmp)\.get\s*\(\s*(["'])c\.([A-Za-z_]\w*)\1\s*\)/g;
const CONTROLLER_ATTR_RE = /\b(?:controller|extensions)\s*=\s*(["'])([^"']+)\1/gi;

interface ApexMethodRef {
  namespace?: string;
  className: string;
  methodName: string;
}

export const salesforceResolver: FrameworkResolver = {
  name: 'salesforce',
  languages: ['javascript', 'typescript', 'html'],

  detect(context): boolean {
    if (context.fileExists('sfdx-project.json')) return true;
    return context.getAllFiles().some(isSalesforceProjectFile);
  },

  claimsReference(name): boolean {
    return (
      name.startsWith('@salesforce/') ||
      name.startsWith('lightning/') ||
      name.startsWith('c/') ||
      name.startsWith('c:') ||
      name.startsWith('c.')
    );
  },

  extract(filePath, content) {
    return {
      nodes: [...extractLwcComponentNode(filePath, content), ...extractAuraClientActionNodes(filePath, content)],
      references: [...extractLwcTemplateRefs(filePath, content), ...extractAuraApexActionRefs(filePath, content)],
    };
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    const apexImport = parseApexImport(ref.referenceName);
    if (apexImport) return resolveApexImport(ref, context, apexImport);

    const auraServerAction = parseAuraServerAction(ref.referenceName);
    if (auraServerAction && ref.referenceKind === 'calls') {
      return resolveAuraApexServerAction(ref, context, auraServerAction);
    }

    if (isSalesforceComponentRef(ref.referenceName)) {
      return resolveComponentRef(ref, context);
    }

    if (ref.referenceKind === 'references') {
      const classTarget = resolveApexClassRef(ref, context);
      if (classTarget) return classTarget;
    }

    if (ref.referenceKind !== 'calls') return null;
    return (
      resolveAuraClientAction(ref, context) ??
      resolveAuraApexServerAction(ref, context) ??
      resolveVisualforceAction(ref, context)
    );
  },
};

function isSalesforceProjectFile(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  return (
    normalized.includes('/force-app/main/default/') ||
    /(^|\/)(classes|triggers|lwc|aura|pages|components)\//.test(normalized) ||
    /\.(?:cls|trigger|cmp|app|page|component)$/.test(normalized)
  );
}

function parseApexImport(name: string): ApexMethodRef | null {
  const match = APEX_IMPORT_RE.exec(name);
  if (!match?.[2] || !match[3]) return null;
  return {
    ...(match[1] ? { namespace: match[1] } : {}),
    className: match[2],
    methodName: match[3],
  };
}

function parseAuraServerAction(name: string): string | null {
  const match = /^c\.([A-Za-z_]\w*)$/.exec(name);
  return match?.[1] ?? null;
}

function languageFromScriptPath(filePath: string): Extract<Language, 'javascript' | 'typescript'> {
  return filePath.endsWith('.ts') ? 'typescript' : 'javascript';
}

function lineAndColumn(content: string, offset: number): { line: number; column: number } {
  const lineOf = makeLineIndex(content);
  const line = lineOf(offset);
  const lineStart = content.lastIndexOf('\n', offset - 1) + 1;
  return { line, column: Math.max(0, offset - lineStart) };
}

function createSyntheticNode(args: {
  id: string;
  kind: Node['kind'];
  name: string;
  qualifiedName: string;
  filePath: string;
  language: Language;
  content: string;
  offset: number;
  decorators?: string[];
}): Node {
  const pos = lineAndColumn(args.content, args.offset);
  return {
    id: args.id,
    kind: args.kind,
    name: args.name,
    qualifiedName: args.qualifiedName,
    filePath: args.filePath,
    language: args.language,
    startLine: pos.line,
    endLine: pos.line,
    startColumn: pos.column,
    endColumn: pos.column,
    ...(args.decorators ? { decorators: args.decorators } : {}),
    updatedAt: Date.now(),
  };
}

function extractLwcComponentNode(filePath: string, content: string): Node[] {
  const info = lwcComponentInfo(filePath);
  if (!info) return [];
  const classOffset = content.search(
    /\bexport\s+default\s+class\b|\bclass\s+[A-Za-z_]\w*\s+extends\s+LightningElement\b/,
  );
  return [
    createSyntheticNode({
      id: `salesforce:lwc:${filePath}:${info.name}`,
      kind: 'component',
      name: info.name,
      qualifiedName: `${filePath}::${info.name}`,
      filePath,
      language: languageFromScriptPath(filePath),
      content,
      offset: Math.max(classOffset, 0),
      decorators: [LWC_COMPONENT_DECORATOR],
    }),
  ];
}

function lwcComponentInfo(filePath: string): { name: string } | null {
  const normalized = normalizePath(filePath);
  const parts = normalized.split('/');
  const lwcIdx = parts.lastIndexOf('lwc');
  if (lwcIdx < 0 || lwcIdx + 2 >= parts.length) return null;
  const folder = parts[lwcIdx + 1];
  const fileName = parts.at(-1);
  if (!folder || !fileName) return null;
  const ext = path.posix.extname(fileName);
  if (ext !== '.js' && ext !== '.ts') return null;
  const base = path.posix.basename(fileName, ext);
  return base === folder ? { name: folder } : null;
}

function extractAuraClientActionNodes(filePath: string, content: string): Node[] {
  if (!isAuraControllerScript(filePath)) return [];
  const nodes: Node[] = [];
  AURA_ACTION_METHOD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = AURA_ACTION_METHOD_RE.exec(content))) {
    const name = match[1]!;
    nodes.push(
      createSyntheticNode({
        id: `salesforce:aura-action:${filePath}:${name}:${match.index}`,
        kind: 'method',
        name,
        qualifiedName: `${filePath}::${name}`,
        filePath,
        language: languageFromScriptPath(filePath),
        content,
        offset: match.index,
        decorators: [AURA_CLIENT_ACTION_DECORATOR],
      }),
    );
  }
  return nodes;
}

function isAuraControllerScript(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  return /(^|\/)aura\/[^/]+\/[^/]+(?:Controller|Helper|Renderer)\.js$/.test(normalized);
}

function extractLwcTemplateRefs(filePath: string, content: string): UnresolvedReference[] {
  if (!isLwcTemplate(filePath)) return [];
  const refs: UnresolvedReference[] = [];
  CUSTOM_ELEMENT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CUSTOM_ELEMENT_RE.exec(content))) {
    const tagName = match[1]!;
    const pos = lineAndColumn(content, match.index);
    refs.push({
      fromNodeId: `file:${filePath}`,
      referenceName: `c/${kebabToCamel(tagName)}`,
      referenceKind: 'references',
      line: pos.line,
      column: pos.column,
    });
  }
  return refs;
}

function isLwcTemplate(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  return /(^|\/)lwc\/[^/]+\/[^/]+\.html$/.test(normalized);
}

function extractAuraApexActionRefs(filePath: string, content: string): UnresolvedReference[] {
  if (!isAuraControllerScript(filePath)) return [];
  const refs: UnresolvedReference[] = [];
  AURA_APEX_ACTION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = AURA_APEX_ACTION_RE.exec(content))) {
    const name = match[2]!;
    const offset = match.index + match[0].lastIndexOf(name);
    const pos = lineAndColumn(content, offset);
    refs.push({
      fromNodeId: `file:${filePath}`,
      referenceName: `c.${name}`,
      referenceKind: 'calls',
      line: pos.line,
      column: pos.column,
    });
  }
  return refs;
}

function isSalesforceComponentRef(name: string): boolean {
  return name.startsWith('c/') || name.startsWith('c:') || /^[A-Z]\w*$/.test(name);
}

function normalizeComponentCandidates(rawName: string): string[] {
  const stripped = rawName.replace(/^c[/:]/, '');
  const camel = stripped.includes('-') ? kebabToCamel(stripped) : stripped;
  const pascal = toPascal(camel);
  return [...new Set([stripped, camel, pascal, lowerFirst(pascal)])].filter(Boolean);
}

function kebabToCamel(name: string): string {
  return name.replaceAll(/-([a-z0-9])/g, (_m, ch: string) => ch.toUpperCase());
}

function toPascal(name: string): string {
  return name
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function lowerFirst(name: string): string {
  return name ? name.charAt(0).toLowerCase() + name.slice(1) : name;
}

function resolveComponentRef(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  for (const candidate of normalizeComponentCandidates(ref.referenceName)) {
    const target = context.getNodesByName(candidate).find((node) => SALESFORCE_COMPONENT_KINDS.has(node.kind));
    if (target) return frameworkRef(ref, target.id, 0.9);
  }
  return null;
}

function resolveApexClassRef(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const className = ref.referenceName.split('.').at(-1);
  if (!className) return null;
  const target = findApexClass(context, className);
  return target ? frameworkRef(ref, target.id, 0.9) : null;
}

function resolveApexImport(ref: UnresolvedRef, context: ResolutionContext, apexRef: ApexMethodRef): ResolvedRef | null {
  const target = findApexMethod(context, [apexRef.className], apexRef.methodName);
  return target ? frameworkRef(ref, target.id, 0.95) : null;
}

function resolveAuraClientAction(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (ref.language !== 'aura') return null;
  const bundle = auraBundleInfo(ref.filePath);
  if (!bundle) return null;
  const candidate = context
    .getNodesByName(ref.referenceName)
    .find(
      (node) =>
        node.decorators?.includes(AURA_CLIENT_ACTION_DECORATOR) &&
        normalizePath(node.filePath).startsWith(bundle.dir + '/'),
    );
  return candidate ? frameworkRef(ref, candidate.id, 0.95) : null;
}

function resolveAuraApexServerAction(
  ref: UnresolvedRef,
  context: ResolutionContext,
  methodName = ref.referenceName,
): ResolvedRef | null {
  const bundle = auraBundleInfo(ref.filePath);
  if (!bundle) return null;
  const controllers = readAuraControllerNames(context, bundle);
  if (controllers.length === 0) return null;
  const target = findApexMethod(context, controllers, methodName);
  return target ? frameworkRef(ref, target.id, 0.9) : null;
}

function resolveVisualforceAction(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (ref.language !== 'visualforce') return null;
  const source = context.readFile(ref.filePath);
  if (!source) return null;
  const controllers = extractControllerClassNames(source);
  if (controllers.length === 0) return null;
  const target = findApexMethod(context, controllers, ref.referenceName);
  return target ? frameworkRef(ref, target.id, 0.9) : null;
}

function auraBundleInfo(filePath: string): { dir: string; name: string } | null {
  const normalized = normalizePath(filePath);
  const parts = normalized.split('/');
  const auraIdx = parts.lastIndexOf('aura');
  if (auraIdx < 0 || auraIdx + 1 >= parts.length) return null;
  const name = parts[auraIdx + 1];
  if (!name) return null;
  return { dir: parts.slice(0, auraIdx + 2).join('/'), name };
}

function readAuraControllerNames(context: ResolutionContext, bundle: { dir: string; name: string }): string[] {
  for (const ext of ['cmp', 'app']) {
    const filePath = `${bundle.dir}/${bundle.name}.${ext}`;
    const source = context.readFile(filePath);
    if (source) return extractControllerClassNames(source);
  }
  return [];
}

function extractControllerClassNames(source: string): string[] {
  const names: string[] = [];
  CONTROLLER_ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CONTROLLER_ATTR_RE.exec(source))) {
    for (const raw of match[2]!.split(',')) {
      const name = raw.trim().split('.').at(-1);
      if (name) names.push(name);
    }
  }
  return [...new Set(names)];
}

function findApexClass(context: ResolutionContext, className: string): Node | null {
  return context.getNodesByName(className).find((node) => node.language === 'apex' && node.kind === 'class') ?? null;
}

function findApexMethod(context: ResolutionContext, classNames: readonly string[], methodName: string): Node | null {
  for (const className of classNames) {
    const classNode = findApexClass(context, className);
    if (!classNode) continue;
    const methods = context
      .getNodesInFile(classNode.filePath)
      .filter((node) => node.language === 'apex' && node.kind === 'method' && node.name === methodName)
      .filter((node) => node.qualifiedName.includes(classNode.name));
    const auraEnabled = methods.find((node) => node.decorators?.includes('AuraEnabled'));
    if (auraEnabled) return auraEnabled;
    if (methods[0]) return methods[0];
  }
  return null;
}

function frameworkRef(ref: UnresolvedRef, targetNodeId: string, confidence: number): ResolvedRef {
  return { original: ref, targetNodeId, confidence, resolvedBy: 'framework' };
}
