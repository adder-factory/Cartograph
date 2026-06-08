/**
 * Symfony framework resolver.
 *
 * Extracts route nodes from PHP `#[Route(...)]` attributes and simple
 * `config/routes*.yaml` controller bindings. Controller references such as
 * `App\Controller\OrderController::show` resolve to the matching local PHP
 * method when present.
 */

import type { Language, Node } from '../../types.js';
import type { UnresolvedReference } from '../../extraction/types.js';
import { makeLineIndex, stripCommentsForRegex } from '../../utils.js';
import type { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types.js';

const SYMFONY_LANGUAGES = ['php', 'yaml'] as const;
const PHP_ROUTE_ATTR_RE = /#\[\s*Route\s*\(([\s\S]*?)\)\s*\]/g;
const STRING_ARG_RE = /(['"])(.*?)\1/;
const NAME_ARG_RE = /\bname\s*:\s*(['"])(.*?)\1/;
const METHODS_ARG_RE = /\bmethods\s*:\s*\[([^\]]+)\]/;
const CONTROLLER_REF_RE = /(?:^|\\)(\w+Controller)::(\w+)$/;

export const symfonyResolver: FrameworkResolver = {
  name: 'symfony',
  languages: SYMFONY_LANGUAGES,
  anchors: ['#[Route', 'Route(', 'controller:', '_controller:', 'symfony/framework-bundle'],

  detect(context: ResolutionContext): boolean {
    if (context.fileExists('symfony.lock') || context.fileExists('bin/console')) return true;
    const composer = context.readFile('composer.json');
    if (composer) {
      try {
        const pkg = JSON.parse(composer) as {
          require?: Record<string, string>;
          'require-dev'?: Record<string, string>;
        };
        const deps = { ...pkg.require, ...pkg['require-dev'] };
        if (deps['symfony/framework-bundle'] || deps['symfony/routing']) return true;
      } catch {
        return false;
      }
    }
    return context.fileExists('config/routes.yaml') || context.fileExists('config/routes.yml');
  },

  claimsReference(name: string): boolean {
    return CONTROLLER_REF_RE.test(name);
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    const parsed = parseControllerRef(ref.referenceName);
    if (!parsed) return null;
    const classCandidates = context.getNodesByName(parsed.controller);
    for (const classNode of classCandidates) {
      if (classNode.kind !== 'class' || classNode.language !== 'php') continue;
      const method = context
        .getNodesInFile(classNode.filePath)
        .find((node) => node.kind === 'method' && node.name === parsed.method && node.language === 'php');
      if (method) {
        return { original: ref, targetNodeId: method.id, confidence: 0.9, resolvedBy: 'framework' };
      }
      return { original: ref, targetNodeId: classNode.id, confidence: 0.82, resolvedBy: 'framework' };
    }
    return null;
  },

  extract(filePath: string, content: string) {
    if (isYamlRouteFile(filePath)) return extractYamlRoutes(filePath, content);
    if (!filePath.endsWith('.php')) return { nodes: [], references: [] };
    return extractPhpAttributeRoutes(filePath, content);
  },
};

function extractPhpAttributeRoutes(
  filePath: string,
  content: string,
): {
  nodes: Node[];
  references: UnresolvedReference[];
} {
  const safe = stripCommentsForRegex(content, 'php');
  const nodes: Node[] = [];
  const references: UnresolvedReference[] = [];
  PHP_ROUTE_ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PHP_ROUTE_ATTR_RE.exec(safe)) !== null) {
    const args = match[1] ?? '';
    const pathValue = STRING_ARG_RE.exec(args)?.[2];
    if (!pathValue) continue;
    const name = NAME_ARG_RE.exec(args)?.[2] ?? pathValue;
    const methods = METHODS_ARG_RE.exec(args)?.[1]?.replaceAll(/\s+/g, ' ').trim();
    const routeNode = makeRouteNode({
      filePath,
      content: safe,
      offset: match.index,
      name,
      routePath: pathValue,
      signature: methods ? `${pathValue} [${methods}]` : pathValue,
      language: 'php',
    });
    nodes.push(routeNode);

    const nearbyMethod = readFollowingMethodName(safe, PHP_ROUTE_ATTR_RE.lastIndex);
    if (nearbyMethod) references.push(makeReference(routeNode, nearbyMethod, 'calls'));
  }
  return { nodes, references };
}

function extractYamlRoutes(filePath: string, content: string): { nodes: Node[]; references: UnresolvedReference[] } {
  const nodes: Node[] = [];
  const references: UnresolvedReference[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const header = /^([A-Za-z0-9_.-]+)\s*:\s*$/.exec(lines[i] ?? '');
    if (!header?.[1]) continue;
    const block = readIndentedBlock(lines, i + 1);
    const routePath = readYamlScalar(block, 'path') ?? `/${header[1]}`;
    const controller = readYamlScalar(block, 'controller') ?? readYamlScalar(block, '_controller');
    const routeNode = makeRouteNode({
      filePath,
      content,
      offset: lineOffset(content, i),
      name: header[1],
      routePath,
      signature: routePath,
      language: 'yaml',
    });
    nodes.push(routeNode);
    if (controller) references.push(makeReference(routeNode, controller.trim(), 'calls'));
  }
  return { nodes, references };
}

function isYamlRouteFile(filePath: string): boolean {
  return /(^|\/)config\/routes.*\.ya?ml$/.test(filePath) || /\.routing\.ya?ml$/.test(filePath);
}

function readIndentedBlock(lines: string[], startLine: number): string[] {
  const out: string[] = [];
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\S/.test(line) && line.trim().endsWith(':')) break;
    out.push(line);
  }
  return out;
}

function readYamlScalar(lines: string[], key: string): string | null {
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(`${key}:`)) continue;
    const value = trimmed.slice(key.length + 1).trim();
    if (!value) continue;
    return stripOuterQuotes(value);
  }
  return null;
}

function readFollowingMethodName(content: string, start: number): string | null {
  const snippet = content.slice(start, start + 400);
  const match = /\bfunction\s+(\w+)\s*\(/.exec(snippet);
  return match?.[1] ?? null;
}

function stripOuterQuotes(value: string): string {
  const first = value[0];
  const last = value.at(-1);
  if (first !== '"' && first !== "'") return value;
  if (first !== last) return value;
  return value.slice(1, -1);
}

function parseControllerRef(name: string): { controller: string; method: string } | null {
  const match = CONTROLLER_REF_RE.exec(name);
  if (!match?.[1] || !match[2]) return null;
  return { controller: match[1], method: match[2] };
}

function makeRouteNode(args: {
  filePath: string;
  content: string;
  offset: number;
  name: string;
  routePath: string;
  signature: string;
  language: Language;
}): Node {
  const lineOf = makeLineIndex(args.content);
  const line = lineOf(args.offset);
  const column = Math.max(0, args.offset - (args.content.lastIndexOf('\n', args.offset - 1) + 1));
  return {
    id: `symfony:route:${args.filePath}:${line}:${args.name}`,
    kind: 'route',
    name: args.name,
    qualifiedName: `${args.filePath}#${args.name}`,
    filePath: args.filePath,
    language: args.language,
    startLine: line,
    endLine: line,
    startColumn: column,
    endColumn: column + args.name.length,
    signature: args.signature,
    updatedAt: Date.now(),
  };
}

function makeReference(node: Node, name: string, kind: UnresolvedReference['referenceKind']): UnresolvedReference {
  return {
    fromNodeId: node.id,
    referenceName: name,
    referenceKind: kind,
    line: node.startLine,
    column: node.startColumn,
    filePath: node.filePath,
    language: node.language,
  };
}

function lineOffset(content: string, lineIndex: number): number {
  let offset = 0;
  for (let i = 0; i < lineIndex; i++) {
    offset += (content.split('\n')[i] ?? '').length + 1;
  }
  return offset;
}
