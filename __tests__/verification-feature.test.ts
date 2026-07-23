import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import Cartograph from '../src/index.js';
import { buildVerificationCommands, buildVerificationPlan } from '../src/features/verification/runtime.js';
import type { AffectedTestCandidate } from '../src/features/affected/contract.js';
import { ToolHandler } from '../src/mcp/tools.js';

function git(root: string, ...args: string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
}

describe('verification command planning', () => {
  const direct: AffectedTestCandidate = {
    path: 'src/service.test.ts',
    tier: 'direct',
    distance: 1,
    reason: 'direct-dependent',
  };

  it('prefers targeted tests plus one project verify gate when available', () => {
    const commands = buildVerificationCommands({
      manager: 'bun',
      scripts: { test: 'bun test', verify: 'bun run typecheck && bun test' },
      candidates: [direct],
      suiteRisk: false,
    });

    expect(commands).toEqual([
      {
        kind: 'targeted-tests',
        command: 'bun run test -- src/service.test.ts',
        reason: 'Run the direct and likely tests selected from the dependency graph.',
      },
      {
        kind: 'project-gate',
        command: 'bun run verify',
        reason: "Run the repository's aggregate verification gate.",
      },
    ]);
  });

  it('adds a full-suite fallback for broad fan-out and falls back to common gates', () => {
    const commands = buildVerificationCommands({
      manager: 'npm',
      scripts: { test: 'vitest', typecheck: 'tsc --noEmit', lint: 'eslint .' },
      candidates: [{ ...direct, tier: 'broad', distance: 3, reason: 'transitive-dependent' }],
      suiteRisk: true,
    });

    expect(commands.map((command) => [command.kind, command.command])).toEqual([
      ['full-suite', 'npm test'],
      ['project-gate', 'npm run typecheck'],
      ['project-gate', 'npm run lint'],
    ]);
  });
});

describe('verification plan integration', () => {
  let root: string;
  let cg: Cartograph;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cartograph-verify-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'bun test', typecheck: 'tsc --noEmit' } }),
    );
    writeFileSync(join(root, 'bun.lock'), '');
    writeFileSync(join(root, 'src/service.ts'), 'export function service(): number { return 1; }\n');
    writeFileSync(
      join(root, 'src/service.test.ts'),
      "import { service } from './service.js';\nimport { test, expect } from 'bun:test';\ntest('service', () => expect(service()).toBe(1));\n",
    );
    git(root, 'init');
    git(root, 'config', 'user.email', 'verify@example.test');
    git(root, 'config', 'user.name', 'Verify Test');
    cg = Cartograph.initSync(root, { config: { include: ['src/**/*.ts'], exclude: [] } });
    await cg.indexAll();
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'baseline');
  });

  afterEach(() => {
    cg.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('combines changed files, tiered tests, commands, and structural self-checks without running commands', async () => {
    writeFileSync(join(root, 'src/service.ts'), 'export function service(): number { return 2; }\n');

    const plan = await buildVerificationPlan(cg, {});

    expect(plan.status).toBe('ready');
    expect(plan.changedFiles).toEqual(['src/service.ts']);
    expect(plan.testCandidates).toContainEqual({
      path: 'src/service.test.ts',
      tier: 'direct',
      distance: 1,
      reason: 'direct-dependent',
    });
    expect(plan.commands.some((command) => command.kind === 'targeted-tests')).toBe(true);
    expect(plan.commandsExecuted).toBe(false);
    expect(plan.structural?.filesScanned).toBe(1);
    expect(plan.structural?.findingsIntroduced).toBeGreaterThanOrEqual(0);

    const handler = new ToolHandler(cg, { profile: 'coding' });
    const result = await handler.execute('cartograph_verify', { files: ['src/service.ts'] });
    handler.closeAll();
    const text = result.content[0]?.text ?? '';
    expect(result.isError).not.toBe(true);
    expect(text).toContain('## Verification plan');
    expect(text).toContain('Commands were planned only; Cartograph did not execute them.');
    expect(text).toContain('src/service.test.ts');
  });

  it('returns an explicit clean state for an unchanged working tree', async () => {
    const plan = await buildVerificationPlan(cg, {});

    expect(plan.status).toBe('clean');
    expect(plan.changedFiles).toEqual([]);
    expect(plan.commands).toEqual([]);
    expect(plan.structural?.filesScanned).toBe(0);
  });
});
