import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars.js';
import { extractFromSource } from '../src/extraction/index.js';
import type { Node } from '../src/types.js';

const fixtureRoot = path.resolve('crates/cartograph-extract/tests/fixtures/v1_1_33');

const symbolSchema = z
  .object({
    kind: z.string(),
    name: z.string(),
    qualified_name: z.string(),
    start_line: z.number().int().positive(),
    end_line: z.number().int().positive(),
    start_column: z.number().int().nonnegative(),
    end_column: z.number().int().nonnegative(),
    signature: z.string().nullable(),
    docstring: z.string().nullable(),
    exported: z.boolean(),
    default_export: z.boolean(),
    async_symbol: z.boolean(),
    static_member: z.boolean(),
    visibility: z.enum(['public', 'private', 'protected', 'internal']).nullable(),
  })
  .strict();

const oracleSchema = z
  .object({
    baseline: z.literal('v1.1.33'),
    cases: z.array(
      z
        .object({
          path: z.string(),
          language: z.string(),
          symbols: z.array(symbolSchema),
          containments: z.array(z.object({ parent: z.string(), child: z.string() }).strict()),
          references: z.array(
            z
              .object({
                owner: z.string().nullable(),
                name: z.string(),
                kind: z.string(),
                line: z.number().int().positive(),
                column: z.number().int().nonnegative(),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();

type OracleCase = z.infer<typeof oracleSchema>['cases'][number];

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['typescript', 'tsx', 'javascript', 'jsx']);
});

describe('v2 Rust extraction oracle provenance', () => {
  it('keeps the committed projection equal to the v1.1.33 extractor', () => {
    const rawOracle: unknown = JSON.parse(readFileSync(path.join(fixtureRoot, 'expected.json'), 'utf8'));
    const oracle = oracleSchema.parse(rawOracle);

    const actual = oracle.cases.map(projectV1Case);
    expect(actual).toEqual(oracle.cases);
  });
});

function projectV1Case(expected: OracleCase): OracleCase {
  const fixture = path.join(fixtureRoot, path.basename(expected.path));
  const result = extractFromSource(expected.path, readFileSync(fixture, 'utf8'));
  const nodesById = new Map(result.nodes.map((node) => [node.id, node]));
  const fileNodes = result.nodes.filter((node) => node.kind === 'file');
  if (fileNodes.length !== 1) throw new Error('v1.1.33 oracle must contain exactly one file node');
  const fileNode = fileNodes[0];
  if (!fileNode) throw new Error('v1.1.33 oracle file node is unavailable');

  return {
    path: fileNode.filePath,
    language: fileNode.language,
    symbols: result.nodes.filter((node) => node.kind !== 'file').map(projectSymbol),
    containments: result.edges
      .filter((edge) => edge.kind === 'contains' && nodesById.get(edge.source)?.kind !== 'file')
      // The four locked fixtures have unique local names. Broader v2 corpora must
      // project containment by qualified identity instead of this readable v1 view.
      .map((edge) => ({
        parent: requiredNode(nodesById, edge.source).name,
        child: requiredNode(nodesById, edge.target).name,
      })),
    references: result.unresolvedReferences.map((reference) => ({
      owner: referenceOwner(nodesById, reference.fromNodeId),
      name: reference.referenceName,
      kind: reference.referenceKind,
      line: reference.line,
      column: reference.column,
    })),
  };
}

function projectSymbol(node: Node): OracleCase['symbols'][number] {
  return {
    kind: node.kind,
    name: node.name,
    qualified_name: node.qualifiedName,
    start_line: node.startLine,
    end_line: node.endLine,
    start_column: node.startColumn,
    end_column: node.endColumn,
    signature: node.signature ?? null,
    docstring: node.docstring ?? null,
    exported: node.isExported ?? false,
    default_export: node.isDefaultExport ?? false,
    async_symbol: node.isAsync ?? false,
    static_member: node.isStatic ?? false,
    visibility: node.visibility ?? null,
  };
}

function referenceOwner(nodes: Map<string, Node>, id: string): string | null {
  const node = requiredNode(nodes, id);
  return node.kind === 'file' ? null : node.name;
}

function requiredNode(nodes: Map<string, Node>, id: string): Node {
  const node = nodes.get(id);
  if (!node) throw new Error('v1.1.33 oracle references an unknown node');
  return node;
}
