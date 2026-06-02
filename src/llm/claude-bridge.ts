import { compact } from '../utils.js';
/**
 * Claude-bridge chat backend.
 *
 * Spawns the user's `claude` CLI in headless print mode (`claude -p
 * --model <id> --output-format json`) and reads the assistant text from
 * stdout. Reuses the user's existing Claude Code login — no API key
 * required, no separate billing, no Anthropic SDK dependency.
 *
 * Trade-off: subprocess startup is ~500 ms–1 s per call. For the bulk
 * background pipelines (thousands of one-line summaries on a fresh
 * index) this dominates wall-clock time on first run. Steady state is
 * fine because every result is cached by content_hash, and per-call
 * cost is amortised across the many features that use the same
 * backend. If first-run latency becomes a complaint, the natural next
 * step is a long-lived subprocess that reads prompts off stdin with a
 * delimiter protocol; deferred until measured.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { errMsg } from '../errors.js';
import {
  type ChatBackend,
  type ChatMessage,
  type ChatOptions,
  type ChatProviderConfig,
  type ChatResult,
  LlmEndpointError,
} from './client.js';

/** Default per-call subprocess timeout. Generous because `ask` and
 *  `dead-code` can take longer than bulk one-line work. */
const DEFAULT_TIMEOUT_MS = 120_000;

/** Largest stdout payload we'll buffer before treating the call as
 *  runaway. Plenty for any single chat reply. */
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;

/** Choose between `askModel` (when configured + requested) and the default
 *  chat model. Used by the Claude-Code subprocess bridge below. */
function pickClaudeBridgeModel(cfg: ChatProviderConfig, useAskModel: boolean): string {
  if (useAskModel && cfg.askModel) return cfg.askModel;
  return cfg.model;
}

/**
 * Build the `claude` CLI argv for a one-shot headless call.
 *
 * We want a fast, minimal subprocess that uses the user's existing
 * OAuth login — NOT --bare (which forces ANTHROPIC_API_KEY only).
 * The combination below trims roughly 10–30 s of Claude Code
 * startup (MCP server loading, slash-command discovery, settings
 * walks) on every call without breaking auth:
 *
 *   --strict-mcp-config       skip the user's MCP servers entirely
 *                             (they're irrelevant for one-shot LLM
 *                             calls and would cause a recursion if
 *                             cartograph's own MCP server loaded
 *                             itself).
 *   --no-session-persistence  keep these calls out of `claude
 *                             /resume` history.
 *   --disable-slash-commands  skip skill discovery/sync.
 *
 * The remaining ~23 k tokens of Claude Code system prompt cannot
 * be turned off without --bare. That's the price of subprocess-
 * based auth; on a 1000-symbol first-time index it's a one-time
 * cost (subsequent runs hit cartograph's content_hash cache).
 */
function buildClaudeBridgeArgs(model: string): string[] {
  return [
    '-p',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--model',
    model,
    '--output-format',
    'json',
  ];
}

export class ClaudeBridgeChatBackend implements ChatBackend {
  private readonly cfg: ChatProviderConfig;
  private resolvedBin: string | null;

  constructor(cfg: ChatProviderConfig) {
    this.cfg = cfg;
    this.resolvedBin = cfg.claudeBin ? expandHome(cfg.claudeBin) : null;
  }

  async chat(messages: ChatMessage[], options: ChatOptions, useAskModel: boolean): Promise<ChatResult> {
    // `options.temperature` and `options.maxTokens` aren't honoured by
    // the `claude` CLI's `-p` flag — sampling and length live behind
    // model defaults / the user's Claude Code settings, not flags. The
    // caller's request is silently dropped for those.
    // `options.signal` IS honoured: aborts the in-flight subprocess.
    const bin = await this.resolveBin();
    if (!bin) {
      throw new LlmEndpointError(
        '`claude` binary not found on PATH. Install Claude Code or set llm.summarizeLlm.claudeBin.',
      );
    }
    const model = pickClaudeBridgeModel(this.cfg, useAskModel);
    // The `claude` CLI one-shot can't be GBNF-/tool-constrained the way
    // openai-compat and anthropic-api are, so `responseSchema` degrades to a SOFT
    // prompt instruction — best-effort, backed by the caller's
    // JSON.parse guard. (The classifier / dead-code prompts already
    // describe the shape; this restates it as an explicit schema.)
    let prompt = formatMessagesAsPrompt(messages);
    if (options.responseSchema) {
      prompt +=
        '\n\nReply with ONLY a JSON document matching this JSON schema — ' +
        'no prose, no markdown fences:\n' +
        JSON.stringify(options.responseSchema);
    }
    const args = buildClaudeBridgeArgs(model);
    const timeoutMs = this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const t0 = Date.now();
    const { stdout, stderr } = await runProcess({ bin, args, stdin: prompt, timeoutMs, abortSignal: options.signal });
    const durationMs = Date.now() - t0;

    let parsed: ClaudeCliOutput;
    try {
      parsed = parseClaudeCliOutput(stdout);
    } catch (err) {
      const tail = stderr.slice(-500);
      const stderrTail = tail ? ` — stderr: ${tail}` : '';
      throw new LlmEndpointError(`claude-bridge: failed to parse output (${errMsg(err)})${stderrTail}`);
    }

    return compact({
      text: parsed.text,
      durationMs,
      promptTokens: parsed.promptTokens,
      completionTokens: parsed.completionTokens,
    });
  }

  async isReachable(): Promise<boolean> {
    const bin = await this.resolveBin();
    if (!bin) return false;
    // PATH lookup already confirmed an executable file existed; for
    // an explicit `claudeBin` path the user may have typed something
    // that doesn't exist or isn't executable, so verify here. Without
    // this guard, the background summarisation reachability check
    // would pass and we'd burn a chat probe before noticing.
    try {
      await fs.promises.access(bin, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** Cache the resolved path so we don't re-PATH-walk per call. */
  private async resolveBin(): Promise<string | null> {
    if (this.resolvedBin) {
      // If user supplied an explicit path, return it even if missing —
      // `isReachable()` is the gate that verifies the file is usable.
      // chat() will spawn-fail with a readable error if it isn't.
      return this.resolvedBin;
    }
    const found = await findOnPath('claude');
    if (found) this.resolvedBin = found;
    return found;
  }
}

/**
 * Test one PATH-resolution candidate. Returns the path on success,
 * null when the file is missing, isn't a regular file, or lacks the
 * execute bit (X_OK reduces to existence+read on Windows, which is
 * fine for the PATHEXT-extension list `findOnPath` already built).
 */
async function tryExecutableCandidate(candidate: string): Promise<string | null> {
  try {
    const st = await fs.promises.stat(candidate);
    if (!st.isFile()) return null;
    await fs.promises.access(candidate, fs.constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Probe the OS PATH for a binary. Returns the resolved absolute path
 * or null. Cheap (one stat per PATH entry); no shell exec.
 */
export async function findOnPath(bin: string): Promise<string | null> {
  const PATH = process.env['PATH'] ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32' ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of PATH.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const found = await tryExecutableCandidate(path.join(dir, bin + ext));
      if (found) return found;
    }
  }
  return null;
}

/**
 * Flatten an OpenAI-style messages array into one prompt string for
 * `claude -p`. The CLI doesn't have native multi-turn input in print
 * mode, so we serialise: system messages prefixed, user/assistant
 * turns rendered in plain markdown headers. For the call shapes
 * cartograph uses (single user turn, optional system), this is
 * lossless.
 */
function formatMessagesAsPrompt(messages: ChatMessage[]): string {
  if (messages.length === 1 && messages[0]!.role === 'user') {
    return messages[0]!.content;
  }
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      parts.push(`# System\n${m.content}`);
    } else if (m.role === 'user') {
      parts.push(`# User\n${m.content}`);
    } else {
      parts.push(`# Assistant\n${m.content}`);
    }
  }
  return parts.join('\n\n');
}

interface ProcResult {
  stdout: string;
  stderr: string;
}

interface RunProcessArgs {
  bin: string;
  args: string[];
  stdin: string;
  timeoutMs: number;
  abortSignal?: AbortSignal | undefined;
}

/** Subprocess state tracker for event coordination. */
interface ProcessState {
  stdoutBytes: number;
  stderrBytes: number;
  stdoutChunks: Buffer[];
  stderrChunks: Buffer[];
  timedOut: boolean;
  aborted: boolean;
}

/** Setup data-stream handlers and return accumulated buffers guard. */
function setupDataHandlers(child: ReturnType<typeof spawn>, state: ProcessState): void {
  child.stdout?.on('data', (chunk: Buffer) => {
    state.stdoutBytes += chunk.length;
    if (state.stdoutBytes > MAX_STDOUT_BYTES) {
      child.kill('SIGTERM');
      return;
    }
    state.stdoutChunks.push(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    state.stderrBytes += chunk.length;
    if (state.stderrBytes > MAX_STDOUT_BYTES) return;
    state.stderrChunks.push(chunk);
  });
}

interface ProcessExit {
  code: number | null;
  stderr: string;
  timeoutMs: number;
}

/** Construct the final result or error based on process state. */
function buildProcessResult(state: ProcessState, exit: ProcessExit): ProcResult {
  if (state.aborted) {
    throw new LlmEndpointError('claude-bridge: aborted by caller');
  }
  if (state.timedOut) {
    throw new LlmEndpointError(`claude-bridge: process timed out after ${exit.timeoutMs}ms`);
  }
  if (exit.code !== 0) {
    const stderrTail = exit.stderr ? ` — ${exit.stderr.slice(0, 500)}` : '';
    throw new LlmEndpointError(`claude-bridge: exit ${exit.code}${stderrTail}`, exit.code ?? undefined);
  }
  const stdout = Buffer.concat(state.stdoutChunks).toString('utf-8');
  return { stdout, stderr: exit.stderr };
}

interface ProcessLifecycleArgs {
  child: ReturnType<typeof spawn>;
  state: ProcessState;
  timeoutMs: number;
  abortSignal: AbortSignal | undefined;
  resolve: (value: ProcResult) => void;
  reject: (reason: unknown) => void;
}

/** Wire timeout, abort, data, error, and close handlers onto the child process. */
function setupProcessLifecycle(opts: ProcessLifecycleArgs): void {
  const { child, state, timeoutMs, abortSignal, resolve, reject } = opts;

  // SIGTERM the child, then SIGKILL after a short grace if it ignores.
  // Used by both the timeout and the abort paths.
  const killChild = (): void => {
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
  };

  const timer = setTimeout(() => {
    state.timedOut = true;
    killChild();
  }, timeoutMs);
  timer.unref();

  // External-signal propagation: when the caller aborts (e.g.
  // Cartograph.close() during a background pass), kill the subprocess
  // immediately rather than waiting for it to finish naturally.
  const onAbort = (): void => {
    state.aborted = true;
    killChild();
  };
  if (abortSignal) abortSignal.addEventListener('abort', onAbort, { once: true });

  setupDataHandlers(child, state);

  child.on('error', (err) => {
    clearTimeout(timer);
    if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
    reject(new LlmEndpointError(`claude-bridge spawn failed: ${err.message}`));
  });

  child.on('close', (code) => {
    clearTimeout(timer);
    if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
    const stderr = Buffer.concat(state.stderrChunks).toString('utf-8');
    try {
      resolve(buildProcessResult(state, { code, stderr, timeoutMs }));
    } catch (err) {
      reject(err);
    }
  });
}

function runProcess(opts: RunProcessArgs): Promise<ProcResult> {
  const { bin, args, stdin, timeoutMs, abortSignal } = opts;
  return new Promise((resolve, reject) => {
    // Reject synchronously if the caller already aborted before we got
    // here — saves a spawn.
    if (abortSignal?.aborted) {
      reject(new LlmEndpointError('claude-bridge: aborted before spawn'));
      return;
    }
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const state: ProcessState = {
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutChunks: [],
      stderrChunks: [],
      timedOut: false,
      aborted: false,
    };
    setupProcessLifecycle({ child, state, timeoutMs, abortSignal, resolve, reject });
    // Pipe the prompt in via stdin (avoids argv length limits on big bodies).
    // End the stream so claude knows the prompt is complete.
    child.stdin.end(stdin, 'utf-8');
  });
}

function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(process.env['HOME'] ?? '', p.slice(1));
  }
  return p;
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

interface ClaudeCliOutput {
  text: string;
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
}

/** Parse one of the three observed `claude -p --output-format json`
 *  payload shapes into a uniform `{text, promptTokens?, completionTokens?}`.
 *  Pulled out of {@link ClaudeBridge.chat} so the cascading shape
 *  detection doesn't sit nested under `chat`'s outer try/catch. Throws
 *  on unrecognised shapes so the caller can wrap the error with the
 *  CLI's stderr tail. */
/** Extract the text payload out of an Anthropic-shaped `content` field
 *  (string for the simple shape; array of `{text}` blocks for the
 *  rich shape). Returns '' for any unrecognised shape. */
function extractClaudeMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b: { text?: string }) => b?.text ?? '').join('');
}

function parseClaudeCliOutput(stdout: string): ClaudeCliOutput {
  // The claude CLI's output IS untrusted (external process); wrap
  // the parse so a malformed payload surfaces the raw stdout slice
  // in the thrown error message instead of an opaque SyntaxError.
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`claude CLI stdout is not valid JSON (${msg}): ${stdout.slice(0, 200)}`);
  }
  if (typeof parsed === 'string') return { text: parsed };
  const obj = parsed as {
    result?: unknown;
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
    messages?: unknown;
  };
  if (typeof obj.result === 'string') {
    return {
      text: obj.result,
      promptTokens: numberOrUndefined(obj.usage?.input_tokens),
      completionTokens: numberOrUndefined(obj.usage?.output_tokens),
    };
  }
  if (Array.isArray(obj.messages)) {
    const last = [...obj.messages].reverse().find((m: { role?: string }) => m?.role === 'assistant');
    const c = last?.content;
    const text = extractClaudeMessageText(c);
    return { text };
  }
  throw new Error(`unexpected JSON shape: ${stdout.slice(0, 200)}`);
}
