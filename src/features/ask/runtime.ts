import { RETRIEVE_K_DEFAULT, RETRIEVE_K_MAX, RETRIEVE_K_MIN } from './constants.js';
import { parseIntegerValue } from '../shared/cli-args.js';

export interface AskOptions {
  mode?: string;
  projectPath?: string;
  prompt?: string;
  retrieveK?: string;
  system?: string;
  maxTokens?: string;
  quiet?: boolean;
}

export type AskValidationResult = { ok: true } | { ok: false; error: string };
export type RetrieveKResult = { ok: true; value: number } | { ok: false; error: string };
export type PositiveIntResult = { ok: true; value: number | undefined } | { ok: false; error: string };
export type AskMode = 'code' | 'local_chat';
export type AskModeResult = { ok: true; value: AskMode } | { ok: false; error: string };

export interface AskCitation {
  node: {
    name: string;
    kind: string;
    filePath: string;
    startLine?: number;
  };
}

export interface RenderAskAnnotationsArgs {
  citationSections: string[];
  citations: AskCitation[];
  retrieveMs: number;
  chatMs: number;
  modelDisplayName: string;
  counter: string;
  dim?: (line: string) => string;
}

export const ASK_QUESTION_MAX_LENGTH = 4096;
export const LOCAL_CHAT_PROMPT_MAX_LENGTH = 64_000;

interface TextLimitValidation {
  emptyError: string;
  maxLength: number;
  maxLengthError: (actualLength: number) => string;
}

export function parseAskMode(raw = 'code'): AskModeResult {
  if (raw === 'code' || raw === 'local_chat') return { ok: true, value: raw };
  return { ok: false, error: "Invalid value for --mode: expected 'code' or 'local_chat'" };
}

export function validateAskQuestion(question: string): AskValidationResult {
  return validateTextLimit(question, {
    emptyError: 'ask: the question must not be empty.',
    maxLength: ASK_QUESTION_MAX_LENGTH,
    maxLengthError: (actualLength) =>
      `ask: the question must be at most ${ASK_QUESTION_MAX_LENGTH} characters (got ${actualLength}).`,
  });
}

export function validateLocalChatPrompt(prompt: string): AskValidationResult {
  return validateTextLimit(prompt, {
    emptyError: 'ask local_chat: prompt must not be empty.',
    maxLength: LOCAL_CHAT_PROMPT_MAX_LENGTH,
    maxLengthError: (actualLength) =>
      `ask local_chat: prompt must be at most ${LOCAL_CHAT_PROMPT_MAX_LENGTH} characters (got ${actualLength}).`,
  });
}

export function parseRetrieveK(raw: string | undefined): RetrieveKResult {
  if (raw === undefined) return { ok: true, value: RETRIEVE_K_DEFAULT };
  return parseIntegerValue(raw, '--retrieve-k', { min: RETRIEVE_K_MIN, max: RETRIEVE_K_MAX });
}

export function parseMaxTokens(raw: string | undefined): PositiveIntResult {
  if (raw === undefined) return { ok: true, value: undefined };
  return parseIntegerValue(raw, '--max-tokens', { min: 1 });
}

export function resolveLocalChatPrompt(question: string | undefined, options: AskOptions): string | undefined {
  return options.prompt ?? question;
}

export function resolveAskProjectPath(pathArg: string | undefined, options: AskOptions): string | undefined {
  return options.projectPath ?? pathArg;
}

function validateTextLimit(value: string, validation: TextLimitValidation): AskValidationResult {
  if (value.trim().length === 0) {
    return { ok: false, error: validation.emptyError };
  }
  if (value.length > validation.maxLength) {
    return {
      ok: false,
      error: validation.maxLengthError(value.length),
    };
  }
  return { ok: true };
}

export function renderAskAnnotations({
  citationSections,
  citations,
  retrieveMs,
  chatMs,
  modelDisplayName,
  counter,
  dim = (line) => line,
}: RenderAskAnnotationsArgs): string[] {
  const lines = citationSections.map((line) => (line ? dim(line) : ''));
  lines.push(`\n${dim('Retrieval sources:')}`);
  for (const citation of citations) {
    const loc = citation.node.startLine ? `:${citation.node.startLine}` : '';
    lines.push(dim(`  • ${citation.node.name} (${citation.node.kind}) ${citation.node.filePath}${loc}`));
  }
  lines.push(dim(`\n  retrieve ${retrieveMs}ms · chat ${chatMs}ms · model ${modelDisplayName} · ${counter}`));
  return lines;
}
