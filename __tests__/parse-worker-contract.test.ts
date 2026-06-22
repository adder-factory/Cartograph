import { describe, expect, it } from 'vitest';
import { parseParseWorkerCommand, parseParseWorkerReply } from '../src/extraction/parse-worker-contract.js';
import { extractionResultSchema } from '../src/extraction/types.js';

function extractionResult() {
  return {
    nodes: [],
    edges: [],
    unresolvedReferences: [],
    errors: [],
    durationMs: 1,
  };
}

const SAMPLE_UPDATED_AT = 123;
const SAMPLE_BETWEENNESS = 0.5;
const SAMPLE_DURATION_MS = 2;
const SAMPLE_NODE_RANGE = {
  startLine: 1,
  endLine: 4,
  startColumn: 0,
  endColumn: 1,
} as const;
const SAMPLE_EDGE_LOCATION = {
  line: 2,
  column: 4,
} as const;
const SAMPLE_REFERENCE_LOCATION = {
  line: 3,
  column: 10,
  siteCount: 2,
  extraLine: 4,
} as const;
const SAMPLE_NESTED_RANGE = {
  startLine: 2,
  startCol: 2,
  endLine: 3,
  endCol: 3,
} as const;
const SAMPLE_ERROR_LOCATION = {
  line: 4,
  column: 1,
} as const;

function populatedExtractionResult() {
  return {
    nodes: [
      {
        id: 'n1',
        kind: 'function',
        name: 'readConfig',
        qualifiedName: 'src/config.readConfig',
        filePath: 'src/config.ts',
        language: 'typescript',
        startLine: SAMPLE_NODE_RANGE.startLine,
        endLine: SAMPLE_NODE_RANGE.endLine,
        startColumn: SAMPLE_NODE_RANGE.startColumn,
        endColumn: SAMPLE_NODE_RANGE.endColumn,
        docstring: 'Reads config.',
        signature: 'readConfig(): Config',
        visibility: 'public',
        isExported: true,
        isAsync: false,
        isStatic: false,
        decorators: ['memoized'],
        decoratorArgs: [
          {
            name: 'memoized',
            argStrings: ['"project"'],
            argIdents: ['project'],
            namedArgs: { scope: 'project' },
          },
        ],
        updatedAt: SAMPLE_UPDATED_AT,
        centrality: null,
        betweenness: SAMPLE_BETWEENNESS,
        bodyHash: 'body-hash',
      },
    ],
    edges: [
      {
        source: 'n1',
        target: 'n2',
        kind: 'calls',
        metadata: { receiver: 'config' },
        line: SAMPLE_EDGE_LOCATION.line,
        column: SAMPLE_EDGE_LOCATION.column,
        confidence: 'EXTRACTED',
      },
    ],
    unresolvedReferences: [
      {
        fromNodeId: 'n1',
        referenceName: 'MissingConfig',
        referenceKind: 'type_of',
        line: SAMPLE_REFERENCE_LOCATION.line,
        column: SAMPLE_REFERENCE_LOCATION.column,
        filePath: 'src/config.ts',
        language: 'typescript',
        candidates: ['Config'],
        siteCount: SAMPLE_REFERENCE_LOCATION.siteCount,
        extraLines: [SAMPLE_REFERENCE_LOCATION.extraLine],
      },
    ],
    nestedFunctionManifest: [
      {
        parentNodeId: 'n1',
        filePath: 'src/config.ts',
        name: 'normalize',
        startLine: SAMPLE_NESTED_RANGE.startLine,
        startCol: SAMPLE_NESTED_RANGE.startCol,
        endLine: SAMPLE_NESTED_RANGE.endLine,
        endCol: SAMPLE_NESTED_RANGE.endCol,
        signature: null,
        bodyHash: 'nested-body-hash',
      },
    ],
    errors: [
      {
        message: 'Recovered from partial parse',
        filePath: 'src/config.ts',
        line: SAMPLE_ERROR_LOCATION.line,
        column: SAMPLE_ERROR_LOCATION.column,
        severity: 'warning',
        code: 'partial_parse',
      },
    ],
    durationMs: SAMPLE_DURATION_MS,
  };
}

describe('parse worker IPC contract', () => {
  it('parses grammar-load commands with validated language names', () => {
    expect(parseParseWorkerCommand({ type: 'load-grammars', languages: ['typescript', 'python'] })).toEqual({
      type: 'load-grammars',
      languages: ['typescript', 'python'],
    });
  });

  it('rejects malformed parse commands with a pathful error', () => {
    expect(() => parseParseWorkerCommand({ type: 'parse', id: 1, filePath: 'src/a.ts' })).toThrow(
      /invalid parse worker command: content:/,
    );
  });

  it('rejects unknown language names before grammar loading', () => {
    expect(() => parseParseWorkerCommand({ type: 'load-grammars', languages: ['not-a-language'] })).toThrow(
      /invalid parse worker command: languages\.0:/,
    );
  });

  it('parses parse-result replies with extraction results and profile deltas', () => {
    const parsed = parseParseWorkerReply({
      type: 'parse-result',
      id: 7,
      result: extractionResult(),
      profileDelta: [{ label: 'parse:typescript', count: 1, totalMs: 4, maxMs: 4 }],
    });

    expect(parsed).toEqual({
      type: 'parse-result',
      id: 7,
      result: extractionResult(),
      profileDelta: [{ label: 'parse:typescript', count: 1, totalMs: 4, maxMs: 4 }],
    });
  });

  it('parses populated parse-result replies across the full extraction boundary shape', () => {
    const result = populatedExtractionResult();

    expect(parseParseWorkerReply({ type: 'parse-result', id: 8, result })).toEqual({
      type: 'parse-result',
      id: 8,
      result,
    });
  });

  it('keeps the extraction result schema owned by the extraction contract module', () => {
    const result = populatedExtractionResult();

    expect(extractionResultSchema.parse(result)).toEqual(result);
    expect(extractionResultSchema.safeParse({ nodes: [], edges: [], errors: [] }).success).toBe(false);
  });

  it('rejects malformed parse-result replies before the pool resolves them', () => {
    expect(() =>
      parseParseWorkerReply({
        type: 'parse-result',
        id: 7,
        result: { nodes: [], edges: [], errors: [] },
      }),
    ).toThrow(/invalid parse worker reply: result:/);
  });
});
