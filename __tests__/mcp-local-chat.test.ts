/**
 * `cartograph_local_chat` — verifies the agent-facing surface that
 * lets the parent agent delegate bulk-prose subtasks to the user's
 * configured local LLM. Covers the happy path, the prompt-length
 * gate, and the unreachable-backend error shape.
 *
 * Uses vi.spyOn on LlmClient.prototype to intercept chat calls without
 * a real backend (nllc GGUF / claude CLI / Anthropic HTTPS).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { LlmClient } from '../src/llm/client.js';
import { LOCAL_CHAT_TOOL } from '../src/mcp/tools/local-chat.js';

describe('cartograph_local_chat — module flags', () => {
  it('bypasses the freshness gate (it relays a prompt, never reads the index)', () => {
    // local_chat does not query the code graph, so a stale index must
    // not block the LLM relay call. Task #39.
    expect(LOCAL_CHAT_TOOL.bypassFreshnessGate).toBe(true);
  });
});

describe('cartograph_local_chat', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-local-chat-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), `export function alpha(){return 1;}\n`);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));

    // Intercept LlmClient at the prototype level so internal instantiations
    // (inside cartograph-llm-service) use our fake response too.
    vi.spyOn(LlmClient.prototype, 'isReachable').mockResolvedValue(true);
    vi.spyOn(LlmClient.prototype, 'chat').mockResolvedValue({
      text: 'local-model reply ok',
      durationMs: 1,
    });

    cg = await Cartograph.init(dir, {
      config: {
        llm: {
          summarizeLlm: {
            provider: 'openai-compat',
            endpoint: 'http://localhost:8081',
            model: '/fake/models/fake-local-model.gguf',
          },
        },
      },
    });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg, { profile: 'full' });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    handler?.closeAll();
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns the local model reply with a model + duration trailer', async () => {
    const result = await handler.execute('cartograph_local_chat', {
      prompt: 'summarize this in one sentence',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/local-model reply ok/);
    expect(text).toMatch(/local-chat:.*fake-local-model\.gguf/);
    expect(text).toMatch(/\d+ms/);
  });

  it('rejects empty prompts', async () => {
    // cartograph_local_chat is now a Zod-backed `defineTool` module —
    // an empty `prompt` fails `z.string().min(1)` at the dispatch
    // boundary and surfaces as a formatted `Invalid arguments` error.
    const result = await handler.execute('cartograph_local_chat', { prompt: '' });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Invalid arguments for `cartograph_local_chat`/);
    expect(text).toMatch(/prompt: must be at least 1 character/);
  });

  it('rejects prompts over the 64k char cap', async () => {
    // 64_001 chars — one over the gate. The Zod schema's
    // `.max(64000)` rejects it at the dispatch boundary before the
    // service-side LOCAL_CHAT_MAX_PROMPT_CHARS layer is reached.
    const huge = 'x'.repeat(64_001);
    const result = await handler.execute('cartograph_local_chat', { prompt: huge });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/prompt: must be at most 64000 character/);
  });

  it('forwards an optional system message', async () => {
    // The spy echoes a fixed reply, but the system message
    // path going through cg.llm.localLlm shouldn't crash and the
    // result trailer still arrives.
    const result = await handler.execute('cartograph_local_chat', {
      prompt: 'do the thing',
      system: 'You are a helpful summarizer.',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/local-model reply ok/);
  });

  it('returns a clean error when no chat backend is configured', async () => {
    // Spin a fresh Cartograph with NO llm config so resolveLlmConfig
    // returns null. The error message names config.llm.summarizeLlm so
    // the user knows where to set it.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-local-chat-no-cfg-'));
    try {
      fs.mkdirSync(path.join(dir2, 'src'));
      fs.writeFileSync(path.join(dir2, 'package.json'), JSON.stringify({ name: 'y', version: '0.0.0' }));
      // No llm config at all.
      const cg2 = await Cartograph.init(dir2, {});
      const handler2 = new ToolHandler(cg2, { profile: 'full' });
      try {
        const result = await handler2.execute('cartograph_local_chat', { prompt: 'hi' });
        const text = result.content[0]?.text ?? '';
        expect(text).toMatch(/local_chat failed/);
        expect(text).toMatch(/summarize provider/);
      } finally {
        handler2.closeAll();
        cg2.close();
      }
    } finally {
      if (fs.existsSync(dir2)) fs.rmSync(dir2, { recursive: true, force: true });
    }
  });
});
