import { compact } from '../utils.js';
/**
 * Anthropic-API chat backend.
 *
 * Direct Anthropic Messages API via `@anthropic-ai/sdk`. Used as the
 * fallback when `claude` CLI isn't installed but the user has
 * `ANTHROPIC_API_KEY` set (or supplied `chat.apiKey` in config).
 *
 * Lazy-imports the SDK so users on the openai-compat or claude-bridge
 * path don't pay the require cost.
 */

import {
  type ChatBackend,
  type ChatMessage,
  type ChatOptions,
  type ChatProviderConfig,
  type ChatResult,
  LlmEndpointError,
} from './client.js';

interface AnthropicSdkClient {
  messages: {
    create: (
      params: {
        model: string;
        max_tokens: number;
        temperature?: number;
        system?: string;
        messages: Array<{ role: 'user' | 'assistant'; content: string }>;
        /** Forced single-tool call — how this backend honours
         *  `ChatOptions.responseSchema` as a HARD constraint. */
        tools?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
        tool_choice?: { type: 'tool'; name: string };
      },
      requestOpts?: { signal?: AbortSignal },
    ) => Promise<{
      content: Array<{ type: string; text?: string; input?: unknown }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    }>;
  };
}

/** Tool name used for the forced structured-output call. */
const STRUCTURED_TOOL_NAME = 'emit_result';

/**
 * Pull the reply text out of an Anthropic response. With a forced
 * tool call the payload is the `tool_use` block's `input` object —
 * re-serialised to JSON so callers get the same `text` shape the
 * other backends produce. Otherwise it's the concatenated text blocks.
 */
function extractAnthropicText(
  content: Array<{ type: string; text?: string; input?: unknown }>,
  viaTool: boolean,
): string {
  if (viaTool) {
    const toolUse = content.find((b) => b.type === 'tool_use');
    return toolUse?.input === undefined ? '' : JSON.stringify(toolUse.input);
  }
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

/** Choose between `askModel` (when configured + requested) and the
 *  default chat model. Pulled out of {@link AnthropicApiChatBackend.chat}
 *  so its conditional doesn't hit complex_conditional. */
function pickAnthropicModel(cfg: ChatProviderConfig, useAskModel: boolean): string {
  if (useAskModel && cfg.askModel) return cfg.askModel;
  return cfg.model;
}

export class AnthropicApiChatBackend implements ChatBackend {
  private readonly cfg: ChatProviderConfig;
  private clientPromise: Promise<AnthropicSdkClient> | null = null;

  constructor(cfg: ChatProviderConfig) {
    this.cfg = cfg;
  }

  async chat(messages: ChatMessage[], options: ChatOptions, useAskModel: boolean): Promise<ChatResult> {
    const client = await this.getClient();
    const model = pickAnthropicModel(this.cfg, useAskModel);

    // Anthropic API splits system out of messages[].
    const system = messages.find((m) => m.role === 'system')?.content;
    const conversation = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    // `responseSchema` → force a single-tool call whose `input_schema`
    // is the requested schema. Anthropic guarantees the model emits a
    // `tool_use` block matching it — a HARD structured-output constraint,
    // the API-side counterpart of the openai-compat json_schema grammar.
    const viaTool = options.responseSchema !== undefined;

    const t0 = Date.now();
    const res = await client.messages.create(
      {
        model,
        max_tokens: options.maxTokens ?? 256,
        temperature: options.temperature ?? 0,
        ...(system ? { system } : {}),
        messages: conversation,
        ...(viaTool
          ? {
              tools: [
                {
                  name: STRUCTURED_TOOL_NAME,
                  description: 'Return the result as structured JSON matching the input schema.',
                  input_schema: options.responseSchema!,
                },
              ],
              tool_choice: { type: 'tool' as const, name: STRUCTURED_TOOL_NAME },
            }
          : {}),
      },
      options.signal ? { signal: options.signal } : undefined,
    );
    const text = extractAnthropicText(res.content ?? [], viaTool);
    return compact({
      text,
      durationMs: Date.now() - t0,
      promptTokens: res.usage?.input_tokens,
      completionTokens: res.usage?.output_tokens,
    });
  }

  async isReachable(): Promise<boolean> {
    if (!resolveApiKey(this.cfg)) return false;
    try {
      await this.getClient();
      return true;
    } catch {
      return false;
    }
  }

  private getClient(): Promise<AnthropicSdkClient> {
    if (this.clientPromise) return this.clientPromise;
    this.clientPromise = (async () => {
      const apiKey = resolveApiKey(this.cfg);
      if (!apiKey) {
        throw new LlmEndpointError(
          'anthropic-api: no API key found. Set ANTHROPIC_API_KEY or llm.summarizeLlm.apiKey.',
        );
      }
      // Optional peer dep — keep its absence non-fatal at compile time
      // by going through `loadModule()` instead of a static import.
      // Users on the openai-compat or claude-bridge path don't need this
      // package installed at all.
      type SdkModule = { default?: new (opts: { apiKey: string; timeout?: number }) => AnthropicSdkClient };
      let mod: SdkModule;
      try {
        mod = (await loadModule('@anthropic-ai/sdk')) as SdkModule;
      } catch {
        throw new LlmEndpointError(
          'anthropic-api: @anthropic-ai/sdk is not installed. Run `npm install @anthropic-ai/sdk` or switch provider to "openai-compat" or "claude-bridge".',
        );
      }
      const Ctor = mod.default;
      if (!Ctor) throw new LlmEndpointError('anthropic-api: SDK has no default export');
      return new Ctor({ apiKey, timeout: this.cfg.timeoutMs ?? 60_000 });
    })();
    return this.clientPromise;
  }
}

// `import()` on a literal string fails compile when the module isn't
// declared. Going through a Function-built dynamic import keeps the
// module name out of the type checker so `@anthropic-ai/sdk` can stay
// an optional peer dep.
const loadModule: (specifier: string) => Promise<unknown> =
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('s', 'return import(s)') as (specifier: string) => Promise<unknown>;

function resolveApiKey(cfg: ChatProviderConfig): string | undefined {
  return cfg.apiKey ?? process.env['ANTHROPIC_API_KEY'];
}
