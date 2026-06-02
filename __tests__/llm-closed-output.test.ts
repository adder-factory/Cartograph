/**
 * Grammar-constrained closed-output classifiers — change-kind and
 * commit-intent.
 *
 * Both modules ask the chat backend for a small JSON object
 * (`{"kind":…}` / `{"intent":…}`) constrained by a `responseSchema`.
 * These tests exercise the thin `JSON.parse` guard that replaced the
 * old prose-tolerant string-munging parsers: a valid object, an
 * out-of-taxonomy label, and a non-JSON reply must each land on the
 * documented fallback.
 */

import { describe, it, expect } from 'vitest';
import { classifyChangeKind } from '../src/llm/change-kind.js';
import { classifyCommitMessageWithFallback } from '../src/llm/commit-intent.js';
import { FakeLlmClient } from './helpers/fake-chat-client.js';

/** A FakeLlmClient whose chat() always replies with a fixed string. */
function clientReplying(text: string): FakeLlmClient {
  return new FakeLlmClient(() => text);
}

describe('classifyChangeKind — grammar-constrained chat output', () => {
  const baseArgs = {
    name: 'foo',
    kind: 'function',
    beforeBody: 'function foo() { return 1; }',
    afterBody: 'function foo() { return 2; }',
  };

  it('parses a valid {kind} object into the labelled result', async () => {
    const client = clientReplying('{"kind":"behavioral_change"}');
    const res = await classifyChangeKind({ client, ...baseArgs });
    expect(res.kind).toBe('behavioral_change');
    expect(res.score).toBe(1);
    expect(client.chatCalls).toBe(1);
  });

  it('falls back to modification when the label is outside the taxonomy', async () => {
    const client = clientReplying('{"kind":"not_a_real_label"}');
    const res = await classifyChangeKind({ client, ...baseArgs });
    expect(res.kind).toBe('modification');
    expect(res.score).toBe(0);
  });

  it('falls back to modification on a non-JSON reply', async () => {
    const client = clientReplying('refactor, probably');
    const res = await classifyChangeKind({ client, ...baseArgs });
    expect(res.kind).toBe('modification');
    expect(res.score).toBe(0);
  });

  it('rule-dispatches an added symbol without calling the model', async () => {
    const client = clientReplying('{"kind":"refactor"}');
    const res = await classifyChangeKind({
      client,
      ...baseArgs,
      beforeBody: '',
    });
    expect(res.kind).toBe('addition');
    expect(client.chatCalls).toBe(0);
  });
});

describe('classifyCommitMessageWithFallback — grammar-constrained chat fallback', () => {
  it('resolves via the heuristic without a chat call when a rule fires', async () => {
    const client = clientReplying('{"intent":"perf"}');
    const res = await classifyCommitMessageWithFallback('feat: add a thing', client);
    expect(res.intent).toBe('feat');
    expect(client.chatCalls).toBe(0);
  });

  it('parses a valid {intent} object on the chat fallback path', async () => {
    const client = clientReplying('{"intent":"perf"}');
    const res = await classifyCommitMessageWithFallback('wip', client);
    expect(res.intent).toBe('perf');
    expect(res.score).toBe(1);
    expect(client.chatCalls).toBe(1);
  });

  it('keeps the heuristic verdict when the model replies {intent:"unknown"}', async () => {
    const client = clientReplying('{"intent":"unknown"}');
    const res = await classifyCommitMessageWithFallback('wip', client);
    expect(res.intent).toBe('unknown');
  });

  it('keeps the heuristic verdict on a non-JSON reply', async () => {
    const client = clientReplying('could be a fix');
    const res = await classifyCommitMessageWithFallback('wip', client);
    expect(res.intent).toBe('unknown');
  });
});
