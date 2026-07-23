/**
 * cartograph_session({action}) family — sessions + macros (#13).
 *
 * Covers create/list/resume on the session side plus
 * macro_save/macro_run/macro_list/macro_delete with positional
 * argument substitution.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { appendToolCall, insertSession } from '../src/db/queries-trace.js';

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]!.text;
}

describe('cartograph_session family (#13)', () => {
  let tempDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-session-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src/lib.ts'),
      ['export function alpha(): number { return 1; }', 'export function beta(): number { return alpha() + 2; }'].join(
        '\n',
      ),
    );
    cg = await Cartograph.init(tempDir, { index: true });
    handler = new ToolHandler(cg, { profile: 'full' });
  });

  afterEach(() => {
    if (cg) cg.close();
    else if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
  });

  describe('sessions', () => {
    it('create returns an id and surfaces the label', async () => {
      const r = await handler.runHandler('cartograph_session', {
        action: 'create',
        label: 'investigation-A',
      });
      const text = textOf(r);
      expect(text).toMatch(/Session created/);
      expect(text).toMatch(/`investigation-A`/);
      expect(text).toMatch(/`[0-9a-f]+-[0-9a-f]{6}`/);
    });

    it('list shows the created session newest-first', async () => {
      await handler.runHandler('cartograph_session', { action: 'create', label: 'one' });
      await handler.runHandler('cartograph_session', { action: 'create', label: 'two' });
      const text = textOf(await handler.runHandler('cartograph_session', { action: 'list' }));
      expect(text).toContain('Recent sessions');
      expect(text).toContain('`one`');
      expect(text).toContain('`two`');
    });

    it('resume by label renders the session header', async () => {
      await handler.runHandler('cartograph_session', { action: 'create', label: 'x' });
      const text = textOf(await handler.runHandler('cartograph_session', { action: 'resume', label: 'x' }));
      expect(text).toContain('Resume session `x`');
    });

    it('resume errors when neither id nor label is given', async () => {
      const r = await handler.runHandler('cartograph_session', { action: 'resume' });
      expect(r.isError ?? r.content[0]!.text).toBeTruthy();
      expect(textOf(r)).toMatch(/pass either 'id' or 'label'/);
    });

    it('resume errors when the session is unknown', async () => {
      const text = textOf(await handler.runHandler('cartograph_session', { action: 'resume', label: 'nope' }));
      expect(text).toMatch(/No session matched/);
    });

    it('create output does not promise that subsequent tool calls will be captured', async () => {
      const text = textOf(
        await handler.runHandler('cartograph_session', {
          action: 'create',
          label: 'regression-create-wording',
        }),
      );
      expect(text).not.toMatch(/subsequent tool calls under this session/);
    });

    it('delete by label removes the session from list', async () => {
      await handler.runHandler('cartograph_session', { action: 'create', label: 'doomed' });
      const del = textOf(await handler.runHandler('cartograph_session', { action: 'delete', label: 'doomed' }));
      expect(del).toMatch(/Deleted session/);
      const list = textOf(await handler.runHandler('cartograph_session', { action: 'list' }));
      expect(list).not.toContain('`doomed`');
    });

    it('delete errors when neither id nor label is given', async () => {
      const r = await handler.runHandler('cartograph_session', { action: 'delete' });
      expect(textOf(r)).toMatch(/pass either 'id' or 'label'/);
    });

    it('delete errors when the session is unknown', async () => {
      const text = textOf(await handler.runHandler('cartograph_session', { action: 'delete', label: 'never-existed' }));
      expect(text).toMatch(/No session matched/);
    });

    it('audit flags source-heavy sessions and missing close-out calls', async () => {
      const sessionId = 'audit-session';
      const ts = Date.now();
      insertSession({ qb: cg.queries, id: sessionId, startedTs: ts, label: 'audit-me' });
      appendToolCall(cg.queries, {
        sessionId,
        step: 1,
        ts: ts + 1,
        toolName: 'cartograph_context',
        argsJson: JSON.stringify({ task: 'alpha' }),
        resultSummary: 'ok',
        durationMs: 2_500,
      });
      appendToolCall(cg.queries, {
        sessionId,
        step: 2,
        ts: ts + 2,
        toolName: 'cartograph_node',
        argsJson: JSON.stringify({ symbol: 'alpha', code: true, detail: 'full' }),
        resultSummary: 'ok',
        durationMs: 12,
      });

      const text = textOf(await handler.runHandler('cartograph_session', { action: 'audit', label: 'audit-me' }));

      expect(text).toContain('Session audit `audit-me`');
      expect(text).toContain('Source-heavy context call');
      expect(text).toContain('No end-of-task self-check recorded');
      expect(text).toContain('No test-selection call recorded');
    });

    it('audit treats plan and handoff context formats as metadata-only', async () => {
      const sessionId = 'metadata-context-session';
      const ts = Date.now();
      insertSession({ qb: cg.queries, id: sessionId, startedTs: ts, label: 'metadata-context' });
      for (const [index, format] of ['plan', 'handoff'].entries()) {
        appendToolCall(cg.queries, {
          sessionId,
          step: index + 1,
          ts: ts + index + 1,
          toolName: 'cartograph_context',
          argsJson: JSON.stringify({ task: 'alpha', format }),
          resultSummary: format === 'plan' ? '## Context route plan' : '## Coding task handoff',
          durationMs: 1,
        });
      }

      const text = textOf(
        await handler.runHandler('cartograph_session', { action: 'audit', label: 'metadata-context' }),
      );
      expect(text).not.toContain('Source-heavy context call');
      expect(text).not.toContain('for the next broad route decision');
    });

    it('usage renders aggregate tool counts without args or result bodies', async () => {
      const sessionId = 'usage-session';
      const ts = Date.now();
      insertSession({ qb: cg.queries, id: sessionId, startedTs: ts, label: 'usage-me' });
      appendToolCall(cg.queries, {
        sessionId,
        step: 1,
        ts: ts + 1,
        toolName: 'cartograph_find',
        argsJson: JSON.stringify({ query: 'secret-token' }),
        resultSummary: 'found private detail',
        durationMs: 10,
      });
      appendToolCall(cg.queries, {
        sessionId,
        step: 2,
        ts: ts + 2,
        toolName: 'cartograph_find',
        argsJson: JSON.stringify({ query: 'another-secret' }),
        resultSummary: 'error: failed lookup',
        durationMs: 30,
      });

      const text = textOf(await handler.runHandler('cartograph_session', { action: 'usage' }));

      expect(text).toContain('MCP Usage');
      expect(text).toContain('| cartograph_find | 2 |');
      expect(text).toContain('error-like summaries');
      expect(text).not.toContain('secret-token');
      expect(text).not.toContain('private detail');
    });
  });

  describe('macros', () => {
    it('macro_save validates that referenced tools exist', async () => {
      const text = textOf(
        await handler.runHandler('cartograph_session', {
          action: 'macro_save',
          name: 'bad',
          steps: [{ tool: 'cartograph_does_not_exist', args: {} }],
        }),
      );
      expect(text).toMatch(/unknown tool/);
    });

    it('macro_save rejects null step args instead of saving a corrupt recipe', async () => {
      const text = textOf(
        await handler.runHandler('cartograph_session', {
          action: 'macro_save',
          name: 'bad-args',
          steps: [{ tool: 'cartograph_status', args: null }],
        }),
      );
      expect(text).toMatch(/steps\[0\]\.args must be an object/);
    });

    it('macro_save + macro_list shows the recipe', async () => {
      await handler.runHandler('cartograph_session', {
        action: 'macro_save',
        name: 'callers-of-target',
        steps: [{ tool: 'cartograph_graph', args: { direction: 'callers', start: 'alpha' } }],
      });
      const text = textOf(await handler.runHandler('cartograph_session', { action: 'macro_list' }));
      expect(text).toContain('`callers-of-target`');
      expect(text).toContain('1 step');
    });

    it('macro_run executes the steps and surfaces tool output', async () => {
      await handler.runHandler('cartograph_session', {
        action: 'macro_save',
        name: 'lookup-alpha',
        steps: [{ tool: 'cartograph_graph', args: { direction: 'callers', start: 'alpha' } }],
      });
      const text = textOf(
        await handler.runHandler('cartograph_session', {
          action: 'macro_run',
          name: 'lookup-alpha',
        }),
      );
      expect(text).toMatch(/Macro `lookup-alpha`/);
      expect(text).toMatch(/Step 1: `cartograph_graph`/);
      expect(text).toContain('beta');
    });

    it('macro_run substitutes ${0} positional args into string fields', async () => {
      await handler.runHandler('cartograph_session', {
        action: 'macro_save',
        name: 'callers-by-name',
        steps: [{ tool: 'cartograph_graph', args: { direction: 'callers', start: '${0}' } }],
      });
      const text = textOf(
        await handler.runHandler('cartograph_session', {
          action: 'macro_run',
          name: 'callers-by-name',
          args: ['alpha'],
        }),
      );
      expect(text).toContain('beta');
    });

    it('#28: macro_run substitutes ${0} into nested array/object args', async () => {
      await handler.runHandler('cartograph_session', {
        action: 'macro_save',
        name: 'nested-sub',
        steps: [{ tool: 'cartograph_graph', args: { direction: 'callers', batch: ['${0}'] } }],
      });
      const text = textOf(
        await handler.runHandler('cartograph_session', {
          action: 'macro_run',
          name: 'nested-sub',
          args: ['alpha'],
        }),
      );
      // The placeholder must not survive into the rendered step args.
      expect(text).not.toContain('${0}');
      expect(text).toContain('alpha');
    });

    it('#29: macro_run strips the backtick-wrapped `> _call:` footer', async () => {
      await handler.runHandler('cartograph_session', {
        action: 'macro_save',
        name: 'find-step',
        steps: [{ tool: 'cartograph_find', args: { by: 'name', query: 'alpha' } }],
      });
      const text = textOf(
        await handler.runHandler('cartograph_session', {
          action: 'macro_run',
          name: 'find-step',
        }),
      );
      // The delta-cursor footer (`> _call: \`c_xxxx\`_`) must not bleed
      // into the composed macro output.
      expect(text).not.toMatch(/^> _call: /m);
    });

    it('#30: macro_run rejects a self-recursive macro instead of blowing the stack', async () => {
      await handler.runHandler('cartograph_session', {
        action: 'macro_save',
        name: 'recurse',
        steps: [{ tool: 'cartograph_session', args: { action: 'macro_run', name: 'recurse' } }],
      });
      const text = textOf(
        await handler.runHandler('cartograph_session', {
          action: 'macro_run',
          name: 'recurse',
        }),
      );
      expect(text).toMatch(/recursive macro_run detected/);
    });

    it('macro_delete removes the recipe', async () => {
      await handler.runHandler('cartograph_session', {
        action: 'macro_save',
        name: 'temp',
        steps: [{ tool: 'cartograph_status', args: {} }],
      });
      const del = textOf(
        await handler.runHandler('cartograph_session', {
          action: 'macro_delete',
          name: 'temp',
        }),
      );
      expect(del).toMatch(/Deleted macro/);
      const list = textOf(await handler.runHandler('cartograph_session', { action: 'macro_list' }));
      expect(list).not.toContain('temp');
    });
  });

  describe('dispatch', () => {
    it('rejects an unknown action with a usage hint', async () => {
      // Since the P4 Zod migration the unknown-action rejection comes
      // from the `defineTool` `safeParse` path: the message lists every
      // valid enum value and the received value.
      const r = await handler.runHandler('cartograph_session', { action: 'nope' });
      expect(textOf(r)).toMatch(/action: must be one of/);
      expect(textOf(r)).toContain("'macro_run'");
      expect(textOf(r)).toContain('"nope"');
    });
  });
});
