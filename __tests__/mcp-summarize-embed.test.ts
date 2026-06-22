/**
 * MCP `cartograph_admin({action: 'summarize' | 'embed' | 'classify'})` —
 * CLI/MCP alignment verification. The phase handlers are thin wrappers
 * around `cg.llm.summarizeAll` / `embedAll` / `classifyAll` (which already
 * have integration tests in embeddings.test.ts), so these mostly verify
 * dispatch + arg routing.
 *
 * Uses vi.spyOn on LlmClient / EmbeddingProvider to avoid real backends.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { LlmClient } from '../src/llm/client.js';
import * as embeddingClientModule from '../src/llm/embedding-client.js';
import { defaultChatHandler } from './helpers/fake-chat-client.js';
import { FakeEmbeddingProvider } from './helpers/fake-embedding-provider.js';

describe('cartograph_admin pipeline-phase actions (summarize / embed / classify)', () => {
  let tempDir: string;
  let cg: Cartograph | null = null;
  let handler: ToolHandler | null = null;
  let fakeEmbedProvider: FakeEmbeddingProvider;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-summ-emb-'));
    fakeEmbedProvider = new FakeEmbeddingProvider();

    fs.writeFileSync(
      path.join(tempDir, 'sample.ts'),
      `export function authenticateUser(name: string): string {
  const token = 'secret';
  const claim = 'session';
  return name + token + claim;
}

export function lookupAccount(id: string): { id: string } {
  const cache = new Map<string, { id: string }>();
  cache.set(id, { id });
  return { id };
}

export class TokenStore {
  private bag: Map<string, string> = new Map();
  put(k: string, v: string): void { this.bag.set(k, v); }
  get(k: string): string | undefined { return this.bag.get(k); }
}
`,
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    handler?.closeAll();
    if (cg) {
      try {
        cg.close();
      } catch {}
      cg = null;
    }
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("cartograph_admin({action:'summarize'}) runs the chained summarise+embed pass", async () => {
    vi.spyOn(LlmClient.prototype, 'isReachable').mockResolvedValue(true);
    vi.spyOn(LlmClient.prototype, 'chat').mockImplementation(async (msgs) => ({
      text: defaultChatHandler(msgs),
      durationMs: 1,
    }));
    vi.spyOn(embeddingClientModule, 'createEmbeddingClient').mockReturnValue(fakeEmbedProvider);

    cg = await Cartograph.init(tempDir, {
      config: {
        llm: {
          summarizeLlm: {
            provider: 'openai-compat',
            endpoint: 'http://localhost:8081',
            model: '/fake/models/chat.gguf',
          },
          embeddingLlm: {
            provider: 'openai-compat',
            endpoint: 'http://localhost:8080',
            model: '/fake/models/embed.gguf',
          },
        },
      },
    });
    await cg.indexAll({ summarize: false });
    expect(fakeEmbedProvider.embedCalls).toBe(0);

    handler = new ToolHandler(cg);
    const result = await handler.execute('cartograph_admin', { action: 'summarize' });

    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Summarised \d+ new symbol/);
    // Embed phase fired during the chained pass.
    expect(fakeEmbedProvider.embedCalls).toBeGreaterThan(0);
  });

  it("cartograph_admin({action:'embed'}) runs the embed-only path (cache hit on already-embedded)", async () => {
    vi.spyOn(LlmClient.prototype, 'isReachable').mockResolvedValue(true);
    vi.spyOn(LlmClient.prototype, 'chat').mockImplementation(async (msgs) => ({
      text: defaultChatHandler(msgs),
      durationMs: 1,
    }));
    vi.spyOn(embeddingClientModule, 'createEmbeddingClient').mockReturnValue(fakeEmbedProvider);

    cg = await Cartograph.init(tempDir, {
      config: {
        llm: {
          summarizeLlm: {
            provider: 'openai-compat',
            endpoint: 'http://localhost:8081',
            model: '/fake/models/chat.gguf',
          },
          embeddingLlm: {
            provider: 'openai-compat',
            endpoint: 'http://localhost:8080',
            model: '/fake/models/embed.gguf',
          },
        },
      },
    });
    await cg.indexAll();
    await cg.llm.bgCtrl.awaitCompletion();

    handler = new ToolHandler(cg);
    const beforeEmbed = fakeEmbedProvider.embedCalls;
    const result = await handler.execute('cartograph_admin', { action: 'embed' });

    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Embedded \d+ new vector/);
    // Pure cache hit — no new embed calls fire.
    expect(fakeEmbedProvider.embedCalls).toBe(beforeEmbed);
  });

  it("cartograph_admin({action:'summarize'}) surfaces embed-phase failure as a warning", async () => {
    vi.spyOn(LlmClient.prototype, 'isReachable').mockResolvedValue(true);
    vi.spyOn(LlmClient.prototype, 'chat').mockImplementation(async (msgs) => ({
      text: defaultChatHandler(msgs),
      durationMs: 1,
    }));
    vi.spyOn(embeddingClientModule, 'createEmbeddingClient').mockReturnValue(fakeEmbedProvider);

    cg = await Cartograph.init(tempDir, {
      config: {
        llm: {
          summarizeLlm: {
            provider: 'openai-compat',
            endpoint: 'http://localhost:8081',
            model: '/fake/models/chat.gguf',
          },
          embeddingLlm: {
            provider: 'openai-compat',
            endpoint: 'http://localhost:8080',
            model: '/fake/models/embed.gguf',
          },
        },
      },
    });
    await cg.indexAll({ summarize: false });
    // Stub summarizeAll to mimic a partial-failure path: summaries
    // succeed, but the embed phase reports failed:true. Verifies the
    // handler's warning-injection code path.
    cg.llm.summarizeAll = async () => ({
      candidates: 3,
      generated: 3,
      cacheHits: 0,
      errors: 0,
      durationMs: 10,
      embed: {
        candidates: 3,
        generated: 0,
        errors: 1,
        durationMs: 5,
        failed: true,
        failureReason: 'endpoint down',
      },
    });

    handler = new ToolHandler(cg);
    const result = await handler.execute('cartograph_admin', { action: 'summarize' });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Embed phase failed/);
    expect(text).toMatch(/endpoint down/);
  });

  it("cartograph_admin({action:'classify'}) runs the role-classification phase over existing summaries", async () => {
    vi.spyOn(LlmClient.prototype, 'isReachable').mockResolvedValue(true);
    vi.spyOn(LlmClient.prototype, 'chat').mockImplementation(async (msgs) => ({
      text: defaultChatHandler(msgs),
      durationMs: 1,
    }));

    cg = await Cartograph.init(tempDir, {
      config: {
        llm: {
          summarizeLlm: {
            provider: 'openai-compat',
            endpoint: 'http://localhost:8081',
            model: '/fake/models/chat.gguf',
          },
        },
      },
    });
    // Seed: full pipeline pass populates summaries + roles.
    await cg.indexAll();
    await cg.llm.bgCtrl.awaitCompletion();

    // Wipe roles so classify has work to do, leaving summaries intact.
    const db = cg.queries.db;
    db.exec('UPDATE nodes SET role = NULL, role_model = NULL');

    handler = new ToolHandler(cg);
    const result = await handler.execute('cartograph_admin', { action: 'classify' });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Classified \d+ symbol/);
  });

  it("cartograph_admin({action:'classify'}) reports zero candidates when every summary already has a role", async () => {
    vi.spyOn(LlmClient.prototype, 'isReachable').mockResolvedValue(true);
    vi.spyOn(LlmClient.prototype, 'chat').mockImplementation(async (msgs) => ({
      text: defaultChatHandler(msgs),
      durationMs: 1,
    }));

    cg = await Cartograph.init(tempDir, {
      config: {
        llm: {
          summarizeLlm: {
            provider: 'openai-compat',
            endpoint: 'http://localhost:8081',
            model: '/fake/models/chat.gguf',
          },
        },
      },
    });
    await cg.indexAll();
    await cg.llm.bgCtrl.awaitCompletion();

    handler = new ToolHandler(cg);
    // Run classify a second time — every summary already has a role
    // from the active model, so the candidate set is empty.
    const result = await handler.execute('cartograph_admin', { action: 'classify' });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/No candidates|Classified 0/);
  });

  it("cartograph_admin({action:'embed'}) errors cleanly when no embedding provider configured", async () => {
    vi.spyOn(LlmClient.prototype, 'isReachable').mockResolvedValue(true);
    vi.spyOn(LlmClient.prototype, 'chat').mockImplementation(async (msgs) => ({
      text: defaultChatHandler(msgs),
      durationMs: 1,
    }));

    cg = await Cartograph.init(tempDir, {
      config: {
        llm: {
          summarizeLlm: {
            provider: 'openai-compat',
            endpoint: 'http://localhost:8081',
            model: '/fake/models/chat.gguf',
          },
        },
      },
    });
    await cg.indexAll();

    handler = new ToolHandler(cg);
    const result = await handler.execute('cartograph_admin', { action: 'embed' });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/no embedding provider|Embed failed/i);
  });
});
