import { describe, expect, it } from 'vitest';
import { ContextRouteSchema } from '../src/features/context-route/contract.js';
import { analyzeCodingTask, buildContextRoute } from '../src/features/context-route/runtime.js';
import type { Node } from '../src/types.js';

function node(overrides: Partial<Node> & Pick<Node, 'id' | 'name' | 'kind' | 'filePath'>): Node {
  return {
    qualifiedName: overrides.name,
    language: 'typescript',
    startLine: 10,
    endLine: 20,
    startColumn: 0,
    endColumn: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('deterministic coding-task router', () => {
  it('classifies a multi-clause debugging task and extracts code anchors', () => {
    const analysis = analyzeCodingTask(
      'Fix PaymentService in src/payment.ts; also update processCheckout and then verify the regression tests',
    );

    expect(analysis.taskKind).toBe('debug');
    expect(analysis.clauses).toEqual([
      'Fix PaymentService in src/payment.ts',
      'update processCheckout',
      'verify the regression tests',
    ]);
    expect(analysis.anchors).toEqual({
      identifiers: ['PaymentService', 'processCheckout'],
      paths: ['src/payment.ts'],
    });
  });

  it('abstains when retrieval only returns generic containers', () => {
    const route = buildContextRoute({
      task: 'improve how coding agents discover edit sites and choose tests',
      nodes: [
        node({ id: 'tests', name: 'tests', kind: 'module', filePath: 'src/tests.ts' }),
        node({ id: 'sites', name: 'sites', kind: 'variable', filePath: 'src/context/sites.ts' }),
      ],
    });

    expect(route.status).toBe('abstained');
    expect(route.candidates.every((candidate) => candidate.confidence === 'low')).toBe(true);
    expect(ContextRouteSchema.safeParse(route).success).toBe(true);
  });

  it('promotes an explicitly named production behavior as a high-confidence edit site', () => {
    const route = buildContextRoute({
      task: 'Fix PaymentService processPayment retry behavior',
      nodes: [
        node({
          id: 'payment',
          name: 'processPayment',
          qualifiedName: 'PaymentService.processPayment',
          kind: 'method',
          filePath: 'src/payment.ts',
          docstring: 'Process a payment and retry transient failures.',
        }),
      ],
    });

    expect(route.status).toBe('ready');
    expect(route.candidates[0]).toMatchObject({
      nodeId: 'payment',
      bucket: 'edit-site',
      confidence: 'high',
    });
    expect(route.candidates[0]?.evidence.join(' ')).toContain('explicit identifier');
  });

  it('separates test and configuration evidence from production edit sites', () => {
    const route = buildContextRoute({
      task: 'Add retry policy to PaymentService and update its tests and config',
      nodes: [
        node({ id: 'service', name: 'PaymentService', kind: 'class', filePath: 'src/payment.ts' }),
        node({ id: 'test', name: 'PaymentService retries', kind: 'function', filePath: 'src/payment.test.ts' }),
        node({ id: 'config', name: 'retryPolicy', kind: 'property', filePath: 'config/payment.json' }),
      ],
    });

    expect(route.candidates.map((candidate) => [candidate.nodeId, candidate.bucket])).toEqual([
      ['service', 'edit-site'],
      ['test', 'test'],
      ['config', 'configuration'],
    ]);
  });

  it('uses deterministic intent evidence to route broad prose without pretending it was an exact name match', () => {
    const route = buildContextRoute({
      task: 'improve how agents choose verification commands',
      nodes: [node({ id: 'verify', name: 'buildVerificationPlan', kind: 'function', filePath: 'src/verify/plan.ts' })],
      intentEvidenceByNodeId: new Map([
        ['verify', ['docstring matched clause "improve how agents choose verification commands"']],
      ]),
    });

    expect(route.status).toBe('ready');
    expect(route.candidates[0]).toMatchObject({ confidence: 'high', bucket: 'edit-site' });
    expect(route.candidates[0]?.evidence).toContain(
      'docstring matched clause "improve how agents choose verification commands"',
    );
  });
});
