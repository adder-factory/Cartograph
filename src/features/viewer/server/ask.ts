import type * as http from 'node:http';
import { z } from 'zod';
import { errMsg } from '../../../errors.js';
import {
  ASK_BODY_BYTE_LIMIT,
  ASK_CITATION_LIMIT,
  ASK_QUESTION_CHAR_LIMIT,
  ASK_RETRIEVE_K,
  ASK_SELECTION_CHAR_LIMIT,
  ASK_SYMBOL_CHAR_LIMIT,
  HTTP_BAD_REQUEST,
  HTTP_INTERNAL_ERROR,
  HTTP_OK,
  HTTP_PAYLOAD_TOO_LARGE,
  HTTP_SERVICE_UNAVAILABLE,
} from './constants.js';
import type { RequestContext } from './context.js';
import { ensureCartograph } from './context.js';
import { clampString, parseJsonObject, readBody, sendJson } from './http.js';

const askRequestBodySchema = z.object({
  question: z.unknown().optional(),
  symbol: z.unknown().optional(),
  selection: z.unknown().optional(),
});

function buildAskPrompt(question: string, symbol: string, selection: string): string {
  const symbolPrefixed = `About \`${symbol}\` (in this codebase): ${question}`;
  let fullQuestion = symbol ? symbolPrefixed : question;
  if (selection) {
    fullQuestion += `\n\nThe user has selected this snippet from the source:\n\`\`\`\n${selection}\n\`\`\``;
  }
  return fullQuestion;
}

function sendAskErrorResponse(res: http.ServerResponse, err: unknown): void {
  const m = errMsg(err);
  const noLlm = /No (?:chat|ask) provider configured|not reachable/i.test(m);
  sendJson(res, noLlm ? HTTP_SERVICE_UNAVAILABLE : HTTP_INTERNAL_ERROR, {
    error: m,
    hint: noLlm
      ? 'Run `cartograph admin llm-plan`, apply a preset with `cartograph admin llm-apply --preset <id>`, start the backend, then restart the viewer.'
      : undefined,
  });
}

export async function handleAskRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  let body: string;
  try {
    body = await readBody(req, ASK_BODY_BYTE_LIMIT);
  } catch (err) {
    const msg = errMsg(err);
    sendJson(res, msg === 'body too large' ? HTTP_PAYLOAD_TOO_LARGE : HTTP_BAD_REQUEST, { error: msg });
    return;
  }
  const rawJson = parseJsonObject(body);
  if (!rawJson.ok) {
    if (rawJson.reason === 'not-object') {
      sendJson(res, HTTP_BAD_REQUEST, { error: 'body must be a JSON object' });
      return;
    }
    sendJson(res, HTTP_BAD_REQUEST, { error: 'invalid JSON body' });
    return;
  }
  const parsedBody = askRequestBodySchema.safeParse(rawJson.value);
  if (!parsedBody.success) {
    sendJson(res, HTTP_BAD_REQUEST, { error: 'body must be a JSON object' });
    return;
  }
  const parsed = rawJson.value;

  const question = clampString(parsed['question'], ASK_QUESTION_CHAR_LIMIT);
  const symbol = clampString(parsed['symbol'], ASK_SYMBOL_CHAR_LIMIT);
  const selection = clampString(parsed['selection'], ASK_SELECTION_CHAR_LIMIT, { trim: false });
  if (!question) {
    sendJson(res, HTTP_BAD_REQUEST, { error: 'question is required' });
    return;
  }
  const fullQuestion = buildAskPrompt(question, symbol, selection);

  let cg: Awaited<ReturnType<typeof ensureCartograph>>;
  try {
    cg = await ensureCartograph(ctx);
  } catch (err) {
    sendJson(res, HTTP_INTERNAL_ERROR, { error: `failed to open project: ${errMsg(err)}` });
    return;
  }

  try {
    const result = await cg.llm.ask(fullQuestion, { retrieveK: ASK_RETRIEVE_K });
    sendJson(res, HTTP_OK, {
      answer: result.answer,
      citations: (result.citations ?? []).slice(0, ASK_CITATION_LIMIT).map((c) => ({
        name: c.node.name,
        kind: c.node.kind,
        file: c.node.filePath,
        line: c.node.startLine,
      })),
    });
  } catch (err) {
    sendAskErrorResponse(res, err);
  }
}
