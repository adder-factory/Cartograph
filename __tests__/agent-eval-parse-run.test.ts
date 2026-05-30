/**
 * agent-eval `parse-run.mjs` sub-agent recovery.
 *
 * In natural-delegation mode the stream-json only records the main thread's
 * single `Agent` spawn; the sub-agent's real tool calls live in an on-disk
 * session transcript. parse-run.mjs locates that transcript by SESSION ID and
 * folds the sub-agent counts back in. These tests drive it through a fake
 * `CLAUDE_CONFIG_DIR` (the env var parse-run honours) so they're hermetic — no
 * dependency on the developer's real ~/.claude.
 *
 * Each test pins a behaviour that would silently break the published
 * tool-call numbers:
 *  - sub-agent calls are recovered and split by category (cg/read/grep);
 *  - `fullCalls` = main + sub (the honest total the prior code undercounted);
 *  - a missing session degrades cleanly to main-only (no crash, sub fields null).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const PARSE_RUN = path.resolve(__dirname, '../scripts/agent-eval/parse-run.mjs');

function writeJsonl(file: string, events: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n'));
}

/** Run parse-run.mjs with a fake CLAUDE_CONFIG_DIR; return the emitted metrics JSON. */
function runParse(runJsonl: string, configDir: string, outJson: string): Record<string, unknown> {
  execFileSync('node', [PARSE_RUN, runJsonl, '--json', outJson, '--meta', 'corpus=t,arm=with,run=1'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
    stdio: 'pipe',
  });
  return JSON.parse(fs.readFileSync(outJson, 'utf8'));
}

describe('agent-eval parse-run.mjs — sub-agent transcript recovery', () => {
  let tmp: string;
  const SID = 'aaaaaaaa-1111-2222-3333-444444444444';

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-parse-run-'));
  });
  afterEach(() => {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
  });

  function streamJson(): string {
    const f = path.join(tmp, 'with-run1.jsonl');
    writeJsonl(f, [
      { type: 'system', subtype: 'init', session_id: SID, tools: ['mcp__cartograph__cartograph_explore'] },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'a1', name: 'Agent', input: { subagent_type: 'Explore', description: 'explore' } },
          ],
        },
      },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a1', content: 'answer' }] } },
      {
        type: 'result',
        subtype: 'success',
        session_id: SID,
        duration_ms: 1000,
        num_turns: 2,
        total_cost_usd: 0.1,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]);
    return f;
  }

  it('recovers sub-agent calls by category and computes fullCalls = main + sub', () => {
    const projDir = path.join(tmp, 'projects', '-fake-project');
    // Main transcript located by session id; sub-agent transcript beside it.
    writeJsonl(path.join(projDir, `${SID}.jsonl`), [{ type: 'system', subtype: 'init', session_id: SID }]);
    writeJsonl(path.join(projDir, SID, 'subagents', 'agent-x.jsonl'), [
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 's1', name: 'mcp__cartograph__cartograph_explore', input: { query: 'q' } },
            { type: 'tool_use', id: 's2', name: 'Read', input: { file_path: '/a' } },
            { type: 'tool_use', id: 's3', name: 'Read', input: { file_path: '/b' } },
            { type: 'tool_use', id: 's4', name: 'Grep', input: { pattern: 'p' } },
            { type: 'tool_use', id: 's5', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 's1', content: 'X'.repeat(1234) }] } },
    ]);

    const m = runParse(streamJson(), path.join(tmp), path.join(tmp, 'out.json'));

    expect(m.sessionId).toBe(SID);
    expect(m.totalCalls).toBe(1); // main: just the Agent spawn
    expect(m.cgCalls).toBe(0); // main made no direct cartograph call
    expect(m.subagentTranscripts).toBe(1);
    expect(m.subCalls).toBe(5);
    expect(m.subCgCalls).toBe(1);
    expect(m.subReadCalls).toBe(2);
    expect(m.subGrepCalls).toBe(1); // Grep
    expect(m.subOutBytes).toBe(1234);
    expect(m.fullCalls).toBe(6); // 1 main + 5 sub
    expect(m.fullCgCalls).toBe(1);
  });

  it('degrades to main-only when no session transcript exists', () => {
    // Empty projects dir → session not found → sub fields null, full === main.
    fs.mkdirSync(path.join(tmp, 'projects'), { recursive: true });
    const m = runParse(streamJson(), path.join(tmp), path.join(tmp, 'out.json'));
    expect(m.subagentTranscripts).toBeNull();
    expect(m.subCalls).toBeNull();
    expect(m.fullCalls).toBe(m.totalCalls); // no sub data → full collapses to main
  });
});
