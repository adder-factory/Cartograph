/**
 * MCP LLM-routing visibility — three formatter contracts that close the
 * "what model is actually being used?" question:
 *
 *  1. `cartograph_status` exposes the configured chat / askChat / embedding
 *     models so split-provider setups are obvious without reading config.json.
 *  2. `cartograph_ask` trailer includes the model id used for synthesis.
 *  3. `cartograph_find({mode: 'semantic'})` empty-state distinguishes
 *     "source has no embedding row" from "source embedded but no neighbours".
 *
 * No real LLM calls happen here — we configure provider strings and inspect
 * the rendered output. Fixtures use nllc with fake GGUF paths (no HTTP).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

// Every test here does a real Cartograph.init({ index: true }) + a
// status call — ~1s of tree-sitter work in isolation, but under the
// full suite's heavy parallelism it can be starved past the default.
// Test timeout raised via the project-wide `bunfig.toml [test]`
// `testTimeout` setting (was `vi.setConfig({ testTimeout: 30000 })`
// in the vitest era — bun:test doesn't expose a per-file equivalent).

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]!.text;
}

describe('MCP LLM-routing visibility', () => {
  let tempDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-llm-visibility-'));
  });

  afterEach(() => {
    if (cg) cg.close();
    else if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
  });

  // -------------------------------------------------------------
  // cartograph_status — LLM providers section
  // -------------------------------------------------------------
  describe('handleStatus — LLM providers section', () => {
    it('renders chat + embedding lines when both are configured (nllc)', async () => {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'src/x.ts'), `export function x(): void {}\n`);
      cg = await Cartograph.init(tempDir, {
        index: true,
        config: {
          llm: {
            enabled: true,
            summarizeLlm: {
              provider: 'openai-compat',
              endpoint: 'http://localhost:8081',
              model: '/fake/models/fake-chat-model.gguf',
            },
            embeddingLlm: {
              provider: 'openai-compat',
              endpoint: 'http://localhost:8080',
              model: '/fake/models/fake-embed-model.gguf',
            },
          },
        },
      });
      handler = new ToolHandler(cg, { profile: 'full' });

      const text = textOf(await handler.runHandler('cartograph_status', {}));
      expect(text).toMatch(/### .*LLM providers/);
      expect(text).toContain('**Summarize model:**');
      expect(text).toContain('fake-chat-model.gguf');
      expect(text).toContain('**Embedding model:**');
      expect(text).toContain('fake-embed-model.gguf');
    });

    it('only renders an Ask model line when askLlm differs from summarizeLlm', async () => {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'src/x.ts'), `export function x(): void {}\n`);

      // Single-provider: chat alone, no askChat. Ask line should NOT appear.
      cg = await Cartograph.init(tempDir, {
        index: true,
        config: {
          llm: {
            enabled: true,
            summarizeLlm: {
              provider: 'openai-compat',
              endpoint: 'http://localhost:8081',
              model: '/fake/models/fake-chat-model.gguf',
            },
          },
        },
      });
      handler = new ToolHandler(cg, { profile: 'full' });

      const text = textOf(await handler.runHandler('cartograph_status', {}));
      expect(text).toMatch(/### .*LLM providers/);
      expect(text).toContain('**Summarize model:**');
      expect(text).not.toContain('**Ask model:**');
    });

    it('renders an Ask model line in split-provider configs', async () => {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'src/x.ts'), `export function x(): void {}\n`);
      cg = await Cartograph.init(tempDir, {
        index: true,
        config: {
          llm: {
            enabled: true,
            summarizeLlm: {
              provider: 'openai-compat',
              endpoint: 'http://localhost:8081',
              model: '/fake/models/fast-local-model.gguf',
            },
            askLlm: {
              provider: 'claude-bridge',
              model: 'high-quality-ask-model',
              claudeBin: '/usr/bin/env',
            },
          },
        },
      });
      handler = new ToolHandler(cg, { profile: 'full' });

      const text = textOf(await handler.runHandler('cartograph_status', {}));
      expect(text).toContain('**Summarize model:**');
      expect(text).toContain('fast-local-model.gguf');
      expect(text).toContain('**Ask model:** `high-quality-ask-model`');
    });

    it('does not borrow the chat endpoint when askChat omits one', async () => {
      // Real-world case: claude-bridge ask + openai-compat chat. The
      // bridge shells out, so askChat has no `endpoint`. The Ask line
      // must NOT claim the chat block's model path — it must show
      // the claude-bridge model.
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'src/x.ts'), `export function x(): void {}\n`);
      cg = await Cartograph.init(tempDir, {
        index: true,
        config: {
          llm: {
            enabled: true,
            summarizeLlm: {
              provider: 'openai-compat',
              endpoint: 'http://localhost:8081',
              model: '/fake/models/qwen3-coder.gguf',
            },
            askLlm: {
              provider: 'claude-bridge',
              model: 'claude-sonnet-4-6',
              claudeBin: '/usr/bin/env',
            },
          },
        },
      });
      handler = new ToolHandler(cg, { profile: 'full' });

      const text = textOf(await handler.runHandler('cartograph_status', {}));
      const askLine = text.split('\n').find((l) => l.startsWith('- **Ask model:**'));
      expect(askLine).toBeDefined();
      expect(askLine).toContain('`claude-sonnet-4-6`');
      expect(askLine).toContain('provider `claude-bridge`');
      expect(askLine).not.toContain('qwen3-coder');
    });

    it('surfaces a "no LLM configured" hint when the section is empty (B14)', async () => {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'src/x.ts'), `export function x(): void {}\n`);
      cg = await Cartograph.init(tempDir, { config: { llm: { enabled: false } }, index: true });
      handler = new ToolHandler(cg, { profile: 'full' });

      const text = textOf(await handler.runHandler('cartograph_status', {}));
      expect(text).toMatch(/### .*LLM providers/);
      expect(text).toMatch(/No LLM configured/);
    });
  });

  // -------------------------------------------------------------
  // cartograph_find({by: 'name', mode: 'semantic'}) — three-way empty-state
  // -------------------------------------------------------------
  describe("cartograph_find({by: 'name', mode: 'semantic'}) — empty-state branches", () => {
    it('flags missing embedding-model config when llm has none', async () => {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'src/x.ts'), `export function thing(): void {}\n`);
      cg = await Cartograph.init(tempDir, { index: true });
      handler = new ToolHandler(cg, { profile: 'full' });

      const text = textOf(
        await handler.runHandler('cartograph_find', { by: 'name', mode: 'semantic', symbol: 'thing' }),
      );
      expect(text).toMatch(/No embedding model configured/);
    });

    it('flags an unembedded source distinct from a "no neighbours" result', async () => {
      // Configure embeddings but DON'T run any embedding pass — symbol_embeddings
      // table stays empty. The message must mention the model name and
      // attribute the empty state to the source row's absence.
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'src/x.ts'), `export function thing(): void {}\n`);
      cg = await Cartograph.init(tempDir, {
        index: true,
        config: {
          llm: {
            enabled: true,
            embeddingLlm: {
              provider: 'openai-compat',
              endpoint: 'http://localhost:8080',
              model: '/fake/models/fake-embed-model.gguf',
            },
          },
        },
      });
      handler = new ToolHandler(cg, { profile: 'full' });

      const text = textOf(
        await handler.runHandler('cartograph_find', { by: 'name', mode: 'semantic', symbol: 'thing' }),
      );
      expect(text).toMatch(/has no embedding row for model `[^`]*fake-embed-model\.gguf` yet/);
      // The old conflated message must NOT appear.
      expect(text).not.toMatch(/may not have an embedding yet/);
    });
  });

  // -------------------------------------------------------------
  // cartograph_status — SQLite Backend line (upstream issue #138)
  // -------------------------------------------------------------
  describe('handleStatus — SQLite backend visibility', () => {
    it('renders Backend line so the active sqlite implementation is visible', async () => {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'src/x.ts'), `export function x(): void {}\n`);
      cg = await Cartograph.init(tempDir, { index: true });
      handler = new ToolHandler(cg, { profile: 'full' });

      const text = textOf(await handler.runHandler('cartograph_status', {}));
      // Post-spike (Slice "drop NodeSqliteAdapter") `bun:sqlite +
      // sqlite-vec` is the only backend; the older `node:sqlite` /
      // `better-sqlite3` strings are extinct. Test now just asserts
      // the Backend line is rendered with the active stack.
      expect(text).toMatch(/\*\*Backend:\*\* bun:sqlite \+ sqlite-vec/);
    });
  });
});
