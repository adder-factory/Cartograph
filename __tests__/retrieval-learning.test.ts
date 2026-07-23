import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Cartograph } from '../src/index.js';
import { getNodesByKind } from '../src/db/queries.js';
import { appendToolCall, insertSession } from '../src/db/queries-trace.js';
import { collectProjectLearningSeeds } from '../src/features/retrieval-learning/index.js';

describe('project-local retrieval learning', () => {
  let projectPath: string;
  let cg: Cartograph;

  beforeEach(async () => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-learning-'));
    fs.mkdirSync(path.join(projectPath, 'src'));
    fs.writeFileSync(
      path.join(projectPath, 'src', 'payment.ts'),
      'export class PaymentService { retryPayment(): boolean { return true; } }\n',
    );
    fs.writeFileSync(
      path.join(projectPath, 'src', 'inventory.ts'),
      'export function countStock(): number { return 1; }\n',
    );
    cg = await Cartograph.init(projectPath, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll({ summarize: false });
  });

  afterEach(() => {
    cg.close();
    fs.rmSync(projectPath, { recursive: true, force: true });
  });

  it('turns successful follow-up calls after a similar task into bounded local seeds', () => {
    const payment = getNodesByKind(cg.queries, 'class').find((node) => node.name === 'PaymentService');
    expect(payment).toBeDefined();
    if (!payment) throw new Error('missing PaymentService fixture');
    seedCallHistory(cg, 'learning-session', [
      ['cartograph_context', { task: 'fix payment retry handling', format: 'plan' }, '## Context route plan'],
      ['cartograph_node', { symbol: payment.id }, '## PaymentService'],
      ['cartograph_graph', { start: payment.id, direction: 'impact' }, '## Impact'],
      ['cartograph_verify', {}, '# Verification plan'],
    ]);

    const learned = collectProjectLearningSeeds(cg, {
      task: 'debug payment retry behavior',
      mode: 'auto',
    });

    expect(learned.report.status).toBe('ready');
    expect(learned.report.contextMatches).toBe(1);
    expect(learned.report.candidates[0]).toMatchObject({
      nodeId: payment.id,
      name: 'PaymentService',
      provenance: 'project-session-outcome',
    });
    expect(learned.report.candidates[0]?.tools).toEqual(['cartograph_graph', 'cartograph_node']);
    expect(learned.evidenceByNodeId.get(payment.id)?.join(' ')).toContain('project-local follow-up');
  });

  it('abstains from unrelated history and supports an explicit off switch', () => {
    const payment = getNodesByKind(cg.queries, 'class').find((node) => node.name === 'PaymentService');
    expect(payment).toBeDefined();
    if (!payment) throw new Error('missing PaymentService fixture');
    seedCallHistory(cg, 'unrelated-session', [
      ['cartograph_context', { task: 'fix payment retry handling' }, '## Code Context'],
      ['cartograph_node', { symbol: payment.id }, '## PaymentService'],
    ]);

    expect(
      collectProjectLearningSeeds(cg, { task: 'redesign inventory warehouse counting', mode: 'auto' }).report.status,
    ).toBe('empty');
    const disabled = collectProjectLearningSeeds(cg, { task: 'payment retry', mode: 'off' });
    expect(disabled.report.status).toBe('off');
    expect(disabled.extraCandidates).toEqual([]);
  });

  it('never learns from legacy sessions that lack an exact project-root stamp', () => {
    const payment = getNodesByKind(cg.queries, 'class').find((node) => node.name === 'PaymentService');
    expect(payment).toBeDefined();
    if (!payment) throw new Error('missing PaymentService fixture');
    const startedTs = Date.now() - 10;
    insertSession({ qb: cg.queries, id: 'legacy-null-project', startedTs });
    appendToolCall(cg.queries, {
      sessionId: 'legacy-null-project',
      step: 1,
      ts: startedTs + 1,
      toolName: 'cartograph_context',
      argsJson: JSON.stringify({ task: 'fix payment retry handling' }),
      resultSummary: '## Code Context',
      durationMs: 1,
    });
    appendToolCall(cg.queries, {
      sessionId: 'legacy-null-project',
      step: 2,
      ts: startedTs + 2,
      toolName: 'cartograph_node',
      argsJson: JSON.stringify({ symbol: payment.id }),
      resultSummary: '## PaymentService',
      durationMs: 1,
    });

    const learned = collectProjectLearningSeeds(cg, { task: 'debug payment retry behavior' });
    expect(learned.report.status).toBe('empty');
    expect(learned.report.sessionsScanned).toBe(0);
  });
});

type SeedCall = readonly [toolName: string, args: Record<string, unknown>, resultSummary: string];

function seedCallHistory(cg: Cartograph, sessionId: string, calls: readonly SeedCall[]): void {
  const startedTs = Date.now() - calls.length * 10;
  insertSession({ qb: cg.queries, id: sessionId, startedTs, projectRoot: cg.projectRoot });
  calls.forEach(([toolName, args, resultSummary], index) => {
    appendToolCall(cg.queries, {
      sessionId,
      step: index + 1,
      ts: startedTs + index,
      toolName,
      argsJson: JSON.stringify(args),
      resultSummary,
      durationMs: 1,
    });
  });
}
