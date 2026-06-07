import { RETRIEVE_K_DEFAULT, RETRIEVE_K_MAX, RETRIEVE_K_MIN } from './constants.js';
import { parseIntegerValue } from '../shared/cli-args.js';

export interface AskOptions {
  projectPath?: string;
  retrieveK?: string;
  quiet?: boolean;
}

export type AskValidationResult = { ok: true } | { ok: false; error: string };
export type RetrieveKResult = { ok: true; value: number } | { ok: false; error: string };

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

export function validateAskQuestion(question: string): AskValidationResult {
  if (question.trim().length === 0) {
    return { ok: false, error: 'ask: the question must not be empty.' };
  }
  if (question.length > ASK_QUESTION_MAX_LENGTH) {
    return {
      ok: false,
      error: `ask: the question must be at most ${ASK_QUESTION_MAX_LENGTH} characters (got ${question.length}).`,
    };
  }
  return { ok: true };
}

export function parseRetrieveK(raw: string | undefined): RetrieveKResult {
  if (raw === undefined) return { ok: true, value: RETRIEVE_K_DEFAULT };
  return parseIntegerValue(raw, '--retrieve-k', { min: RETRIEVE_K_MIN, max: RETRIEVE_K_MAX });
}

export function resolveAskProjectPath(pathArg: string | undefined, options: AskOptions): string | undefined {
  return options.projectPath ?? pathArg;
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
