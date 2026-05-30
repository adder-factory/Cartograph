/**
 * Generated tool-surface smoke / fuzz test (structural campaign P1).
 *
 * WHY THIS EXISTS
 * ---------------
 * cartograph's friction audits keep finding tools that crash or
 * misbehave on basic / edge input — the latest, an `ask`-command
 * crash, slid past a 3000+-test suite because nothing mechanically
 * exercised that entry point. This file is the safety net for a
 * large upcoming migration: it walks EVERY MCP tool and EVERY CLI
 * command so a regression can't hide in an untested corner.
 *
 * WHAT IT COVERS
 * --------------
 *  1. Smoke — every tool in the MCP registry is invoked once with a
 *     minimal valid argument set against a small indexed fixture
 *     repo. Asserts the handler does not throw and returns a
 *     well-formed ToolResult.
 *  2. Numeric fuzz — for every numeric/integer property declared in
 *     a tool's inputSchema, the tool is re-invoked with that arg set
 *     to each of: -1, 0, a huge value, NaN, and a non-integer float.
 *     Asserts the handler returns cleanly (error result OR valid
 *     result) and NEVER throws an unhandled exception. The fuzz uses
 *     `runHandler` (the schema-validation-free entrypoint) so the
 *     handler body itself is the thing under stress — `execute`
 *     would reject NaN / non-integer at the schema boundary and
 *     never reach the handler.
 *  3. CLI — every commander command (and nested subcommand) is
 *     spawned with `--help`, asserting a clean exit and non-empty
 *     usage output.
 *
 * SAFETY — destructive operations are SKIPPED
 * -------------------------------------------
 * The fixture is a throwaway temp dir, but several tool actions
 * mutate or destroy the index, are slow, or reach the network /
 * filesystem outside the fixture. Those are enumerated in
 * DESTRUCTIVE_ADMIN_ACTIONS / SKIP_TOOLS below with an inline
 * justification each. The test never touches the live MCP server —
 * it builds its own Cartograph instance and drives a local
 * ToolHandler.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Command } from 'commander';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { getToolModules } from '../src/mcp/tools/registry.js';
import type { ToolModule } from '../src/mcp/tools/types.js';
import type { ToolDefinition, ToolResult } from '../src/mcp/tool-types.js';

// ── safety lists ───────────────────────────────────────────────

/**
 * `cartograph_admin` actions that mutate or destroy the index, take
 * a long time, or reach outside the fixture. The smoke pass drives
 * `admin` with a safe read-ish action (`unlock`, idempotent on a
 * fixture with no lock) and SKIPS everything below. Each entry
 * carries its reason.
 */
const DESTRUCTIVE_ADMIN_ACTIONS = new Set<string>([
  'init', // creates .cartograph/ — the fixture already has one
  'uninit', // DESTRUCTIVE — deletes .cartograph/
  'index', // full re-index — slow; `index --force` wipes structural data
  'sync', // mutates the index
  'embed-only', // LLM/embedding pass — slow, needs a model
  'migrate', // schema migration — mutates the DB
  'build-similarity-edges', // writes similar_to edges into the live DB
  'prune-store', // evicts summary/embedding rows — destructive
  'scip-export', // writes a .scip file
  'scip-import', // reads/writes — mutates the index
  'summarize', // full LLM pipeline — slow, needs a model
  'embed', // embedding pass — slow, needs a model
  'classify', // LLM classify pass — slow, needs a model
  'install-models', // downloads GGUF model files over the network
]);

/** The one admin action safe to smoke-test — `unlock` is idempotent
 *  and a no-op when no stale lock file exists. */
const SAFE_ADMIN_ACTION = 'unlock';

/**
 * Tools (or tool actions) skipped entirely by the SMOKE pass, each
 * with a reason. They are still numeric-fuzzed where they declare
 * numeric props — the fuzz only cares that the handler doesn't throw.
 */
const SMOKE_SKIP_REASONS: Record<string, string> = {
  // cartograph_local_chat / cartograph_ask delegate to a local LLM —
  // no model is provisioned in CI, so the smoke call would either
  // hang or fail on a network/model error unrelated to a regression.
  // The handler is still fuzz-tested for crash-safety below.
  cartograph_local_chat: 'delegates to a local LLM (no model in CI)',
  cartograph_ask: 'delegates to a local LLM (no model in CI)',
};

/**
 * Per-family discriminator (`action` / `mode`) overrides so the
 * smoke call lands on a READ-ONLY, fast code path. Without these the
 * generic arg-builder would pick the first enum value, which for
 * `admin` is the destructive `init`.
 */
const SMOKE_DISCRIMINATOR: Record<string, Record<string, string>> = {
  cartograph_admin: { action: SAFE_ADMIN_ACTION },
  cartograph_note: { action: 'list' }, // read-only; `add` would mutate
  cartograph_session: { action: 'list' }, // read-only; `create` mutates
  cartograph_summaries: { action: 'pending' }, // read-only batch pull
  cartograph_coverage: { mode: 'ranked' }, // read-only ranked view
  cartograph_review: { mode: 'risk' }, // no-input project triage
  cartograph_find: { by: 'name' }, // name lookup is the cheapest slice
};

/**
 * Extra minimal args some tools need beyond their declared
 * `required` set to land on a non-error happy path. Kept tiny — the
 * smoke test only asserts a well-formed result, not specific output.
 */
const SMOKE_EXTRA_ARGS: Record<string, Record<string, unknown>> = {
  cartograph_find: { by: 'name', query: 'fixtureAlpha' },
  cartograph_node: { symbol: 'fixtureAlpha' },
  cartograph_graph: { direction: 'callers', start: 'fixtureAlpha' },
  cartograph_context: { task: 'understand fixtureAlpha' },
  cartograph_explore: { query: 'fixtureAlpha' },
  cartograph_biomarkers: { mode: 'project' },
  cartograph_at_range: { file: 'src/alpha.ts', startLine: 1, endLine: 5 },
  cartograph_sql: { query: 'SELECT COUNT(*) AS n FROM nodes' },
  cartograph_role: {},
  cartograph_module: { dirPath: 'src' },
  cartograph_blame: { symbol: 'fixtureAlpha' },
  cartograph_history: { symbol: 'fixtureAlpha' },
  cartograph_tests_for: { symbol: 'fixtureAlpha' },
  cartograph_trace_to_culprits: {},
  cartograph_propose_rename: { symbol: 'fixtureAlpha', newName: 'fixtureAlphaRenamed' },
  cartograph_imports: {},
  cartograph_compare_to_ref: {},
  cartograph_changed_since: {},
  cartograph_affected: {},
};

// ── helpers ────────────────────────────────────────────────────

/** Numeric fuzz values applied to every numeric/integer property. */
const FUZZ_VALUES: ReadonlyArray<{ label: string; value: number }> = [
  { label: 'negative', value: -1 },
  { label: 'zero', value: 0 },
  { label: 'huge', value: Number.MAX_SAFE_INTEGER },
  { label: 'NaN', value: Number.NaN },
  { label: 'float', value: 3.7 },
];

/** A ToolResult is well-formed if it has a non-empty `content` array
 *  whose first entry is a text block with a string `text` field. */
function assertWellFormed(toolName: string, result: unknown): void {
  expect(result, `${toolName}: handler returned a falsy result`).toBeTruthy();
  const r = result as ToolResult;
  expect(Array.isArray(r.content), `${toolName}: result.content is not an array`).toBe(true);
  expect(r.content.length, `${toolName}: result.content is empty`).toBeGreaterThan(0);
  const first = r.content[0]!;
  expect(first.type, `${toolName}: first content block is not a text block`).toBe('text');
  expect(typeof first.text, `${toolName}: content[0].text is not a string`).toBe('string');
}

/** Property names whose values are numeric (`type: 'number'` /
 *  `'integer'`, including a type-union containing one). */
function numericProps(def: ToolDefinition): string[] {
  const props = def.inputSchema.properties ?? {};
  const out: string[] = [];
  for (const [name, schema] of Object.entries(props)) {
    const t = (schema as { type?: unknown }).type;
    const types = Array.isArray(t) ? t : [t];
    if (types.some((x) => x === 'number' || x === 'integer')) out.push(name);
  }
  return out;
}

/**
 * Build the minimal valid smoke argument set for a tool: the
 * per-tool extras, plus the family discriminator override, plus a
 * generated value for any declared `required` key still missing.
 */
function buildSmokeArgs(mod: ToolModule): Record<string, unknown> {
  const def = mod.definition;
  const args: Record<string, unknown> = { ...(SMOKE_EXTRA_ARGS[def.name] ?? {}) };
  // Family discriminator takes precedence — it must land on a safe action.
  Object.assign(args, SMOKE_DISCRIMINATOR[def.name] ?? {});
  // Fill any still-missing required key with a schema-shaped placeholder.
  const props = def.inputSchema.properties ?? {};
  for (const req of def.inputSchema.required ?? []) {
    if (req in args) continue;
    const schema = props[req] as { type?: string; enum?: unknown[] } | undefined;
    if (schema?.enum && schema.enum.length > 0) {
      args[req] = schema.enum[0];
    } else if (schema?.type === 'number' || schema?.type === 'integer') {
      args[req] = 1;
    } else if (schema?.type === 'boolean') {
      args[req] = false;
    } else if (schema?.type === 'array') {
      args[req] = [];
    } else {
      args[req] = 'fixtureAlpha';
    }
  }
  return args;
}

// ── fixture repo ───────────────────────────────────────────────

let tempDir: string;
let cg: Cartograph;
let handler: ToolHandler;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-tool-surface-'));
  // Initialise it as a git repo so git-backed tools (blame, history,
  // compare-to-ref, changed-since) have a HEAD to read.
  fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, '__tests__'), { recursive: true });
  fs.writeFileSync(
    path.join(tempDir, 'src/alpha.ts'),
    [
      'export function fixtureAlpha(n: number): number {',
      '  return fixtureBeta(n) + 1;',
      '}',
      '',
      'export function fixtureBeta(n: number): number {',
      '  return n * 2;',
      '}',
      '',
      'export class FixtureService {',
      '  run(): number { return fixtureAlpha(3); }',
      '}',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(tempDir, '__tests__/alpha.test.ts'),
    [
      "import { fixtureAlpha } from '../src/alpha';",
      "describe('fixtureAlpha', () => {",
      "  it('doubles and adds one', () => {",
      '    expect(fixtureAlpha(2)).toBe(5);',
      '  });',
      '});',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(tempDir, 'package.json'),
    JSON.stringify({ name: 'tool-surface-fixture', version: '0.0.0' }, null, 2),
  );
  // Minimal git history so git-backed tools see a HEAD commit.
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: tempDir, stdio: 'ignore' });
  };
  try {
    git(['init', '-q']);
    git(['config', 'user.email', 'fixture@example.com']);
    git(['config', 'user.name', 'Fixture']);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'fixture']);
  } catch {
    /* git unavailable — git-backed tools degrade gracefully to an error result */
  }

  cg = await Cartograph.init(tempDir, { index: true });
  handler = new ToolHandler(cg);
}, 120_000);

afterAll(() => {
  try {
    cg?.destroy();
  } catch {
    /* idempotent */
  }
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// ── 1. SMOKE: every MCP tool invoked once ──────────────────────

describe('MCP tool surface — smoke (every registered tool)', () => {
  it('the registry exposes a non-trivial number of tools', () => {
    // Guards against an enumeration bug silently testing nothing.
    expect(getToolModules().length).toBeGreaterThanOrEqual(30);
  });

  for (const mod of getToolModules()) {
    const name = mod.definition.name;
    const skipReason = SMOKE_SKIP_REASONS[name];

    it(`${name} — minimal valid call returns a well-formed result`, async () => {
      if (skipReason) {
        // Documented skip — assert the handler at least exists so a
        // removed tool still fails this test.
        expect(typeof mod.handle, `${name}: skipped (${skipReason})`).toBe('function');
        return;
      }
      const args = buildSmokeArgs(mod);
      // `execute` runs the full pipeline (freshness gate + schema
      // validation + dispatch) — the same path the MCP server uses.
      let result: ToolResult;
      try {
        result = await handler.execute(name, args);
      } catch (err) {
        throw new Error(
          `${name}: handler threw an unhandled exception on a minimal valid call ` +
            `(args=${JSON.stringify(args)}): ${err instanceof Error ? err.stack : String(err)}`,
        );
      }
      assertWellFormed(name, result);
      // An error result is acceptable (the fixture may not satisfy
      // every tool's preconditions) — a THROW is not. But a generic
      // "Tool execution failed" envelope signals an uncaught handler
      // crash that execute() mopped up; surface it loudly.
      if (result.isError) {
        const text = result.content[0]?.text ?? '';
        expect(
          text,
          `${name}: returned the generic crash envelope — handler threw internally. ` +
            `args=${JSON.stringify(args)}\n${text}`,
        ).not.toMatch(/Tool execution failed/);
      }
    }, 60_000);
  }
});

// ── 2. NUMERIC FUZZ: every numeric prop × adversarial values ───

/**
 * REAL BUG CAUGHT (2026-05-18, fixed in the same change as this test).
 *
 * The first run of this fuzz pass found that a non-integer `limit`
 * (and `topN` / `k`) — e.g. `3.7` — flowed unsanitised through the
 * `clamp(...)`-based MCP-arg handling into a SQLite `LIMIT ?` bound
 * parameter. better-sqlite3 rejects a float in an integer bind slot
 * with `TypeError: datatype mismatch`, so the handler threw an
 * UNHANDLED exception. Eight tools were affected (at_range,
 * biomarkers, coverage, history, hotspots, note, review, session).
 *
 * Root cause: `clamp()` is NaN-safe but does not truncate the
 * fractional part. Fix: a new `clampInt()` helper in `src/utils.ts`
 * that `Math.trunc()`s before clamping, applied at every `limit`-
 * class clamp site. This assertion stays as the regression guard.
 */
describe('MCP tool surface — numeric property fuzz', () => {
  for (const mod of getToolModules()) {
    const name = mod.definition.name;
    const props = numericProps(mod.definition);
    if (props.length === 0) continue;

    it(`${name} — numeric props [${props.join(', ')}] never crash the handler`, async () => {
      const baseArgs = buildSmokeArgs(mod);
      const failures: string[] = [];

      for (const prop of props) {
        for (const { label, value } of FUZZ_VALUES) {
          const args = { ...baseArgs, [prop]: value };
          // `runHandler` bypasses schema validation so the adversarial
          // value reaches the handler body — that body is the thing
          // being stress-tested. A throw here is a real bug.
          try {
            const result = await handler.runHandler(name, args);
            // Result need not be successful — error is fine — but it
            // must be a well-formed ToolResult, not undefined/garbage.
            if (
              !result ||
              !Array.isArray((result as ToolResult).content) ||
              (result as ToolResult).content.length === 0
            ) {
              failures.push(`${prop}=${label}: handler returned a malformed result ` + `(${JSON.stringify(result)})`);
            }
          } catch (err) {
            failures.push(`${prop}=${label}: handler THREW — ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      expect(failures, `${name}: numeric fuzz found unhandled failures:\n  ${failures.join('\n  ')}`).toEqual([]);
    }, 120_000);
  }
});

// ── 3. CLI: every commander command spawned with --help ────────

describe('CLI surface — every command responds to --help', () => {
  const repoRoot = path.join(__dirname, '..');
  const cliEntry = path.join(repoRoot, 'src', 'bin', 'cartograph.ts');

  /** Spawn the CLI, returning combined output and exit code. */
  function runCli(cliArgs: string[]): { out: string; code: number } {
    try {
      const out = execFileSync('bun', [cliEntry, ...cliArgs], {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      });
      return { out, code: 0 };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { out: (e.stdout ?? '') + (e.stderr ?? ''), code: e.status ?? 1 };
    }
  }

  /** Walk the commander tree, collecting [pathSegments] for every
   *  real command and nested subcommand (skipping the auto `help`). */
  function collectCommandPaths(program: Command): string[][] {
    const paths: string[][] = [];
    function visit(cmd: Command, prefix: string[]): void {
      for (const sub of cmd.commands) {
        const subName = sub.name();
        if (!subName || subName === 'help') {
          continue;
        }
        const segs = [...prefix, subName];
        paths.push(segs);
        visit(sub, segs);
      }
    }
    visit(program, []);
    return paths;
  }

  it('enumerates a non-trivial number of CLI commands', async () => {
    const cli = await import('../src/bin/cartograph.js');
    const paths = collectCommandPaths(cli.program);
    expect(paths.length).toBeGreaterThanOrEqual(30);
  });

  it('every CLI command + subcommand prints usage on --help with a clean exit', async () => {
    const cli = await import('../src/bin/cartograph.js');
    const paths = collectCommandPaths(cli.program);

    const failures: string[] = [];
    for (const segs of paths) {
      const { out, code } = runCli([...segs, '--help']);
      // commander exits 0 from `--help`. Any non-zero exit, an empty
      // output, or a stack trace is a crash in the command wiring.
      if (code !== 0) {
        failures.push(`cartograph ${segs.join(' ')} --help → exit ${code}\n${out}`);
        continue;
      }
      if (!/[Uu]sage:/.test(out)) {
        failures.push(`cartograph ${segs.join(' ')} --help → exit 0 but no "Usage:" in output\n${out}`);
        continue;
      }
      if (/\bat\s+\S+\s+\(.*:\d+:\d+\)/.test(out)) {
        failures.push(`cartograph ${segs.join(' ')} --help → emitted a stack trace\n${out}`);
      }
    }

    expect(failures, `CLI --help failures:\n${failures.join('\n---\n')}`).toEqual([]);
  }, 600_000);
});
