/**
 * NeuG framework/resource resolver.
 *
 * NeuG support is intentionally narrow: when a Python project imports `neug`,
 * mine literal graph/database/node/edge declarations into `resource` nodes.
 * That gives agents searchable graph-resource landmarks without inventing
 * runtime semantics for dynamic graph operations.
 */

import type { Language, Node } from '../../types.js';
import { stripCommentsForRegex } from '../../utils.js';
import type { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types.js';
import { makeFrameworkNodeAtOffset } from './node-builders.js';

const NEUG_LANGUAGES = ['python'] as const;
const NEUG_CALL_RE = /\b(?:(?:neug|ng)\.)?(Graph|Database|Vertex|Node|Edge|Relationship)\s*\(\s*(['"])([^'"]+)\2/g;

export const neugResolver: FrameworkResolver = {
  name: 'neug',
  languages: NEUG_LANGUAGES,
  anchors: ['neug', 'Graph(', 'Database(', 'Vertex(', 'Edge(', 'Relationship('],

  detect(context: ResolutionContext): boolean {
    if (hasDependency(context.readFile('pyproject.toml')) || hasDependency(context.readFile('requirements.txt'))) {
      return true;
    }
    return context.getAllFiles().some((file) => {
      if (!file.endsWith('.py')) return false;
      const content = context.readFile(file);
      return Boolean(content && /\b(?:import\s+neug|from\s+neug\s+import)\b/.test(content));
    });
  },

  resolve(_ref: UnresolvedRef, _context: ResolutionContext): ResolvedRef | null {
    return null;
  },

  extractNodes(filePath: string, content: string): Node[] {
    const safe = stripCommentsForRegex(content, 'python');
    if (!safe.includes('neug') && !/\b(?:Graph|Database|Vertex|Node|Edge|Relationship)\s*\(/.test(safe)) return [];

    const nodes: Node[] = [];
    const seen = new Set<string>();
    NEUG_CALL_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = NEUG_CALL_RE.exec(safe)) !== null) {
      const resourceType = match[1]!;
      const resourceName = match[3]!;
      const name = `neug:${resourceType.toLowerCase()}:${resourceName}`;
      const key = `${filePath}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      nodes.push(
        makeResourceNode({ filePath, content: safe, offset: match.index, name, resourceType, language: 'python' }),
      );
    }
    return nodes;
  },
};

function hasDependency(content: string | null): boolean {
  return Boolean(content && /(^|[\s"'=<>])neug([\s"',<>=]|$)/i.test(content));
}

function makeResourceNode(args: {
  filePath: string;
  content: string;
  offset: number;
  name: string;
  resourceType: string;
  language: Language;
}): Node {
  return makeFrameworkNodeAtOffset({
    idPrefix: 'neug:resource',
    kind: 'resource',
    name: args.name,
    filePath: args.filePath,
    content: args.content,
    offset: args.offset,
    language: args.language,
    signature: `NeuG ${args.resourceType}`,
  });
}
