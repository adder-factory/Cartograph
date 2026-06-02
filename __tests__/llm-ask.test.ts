import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { askWithCandidates } from '../src/llm/ask.js';
import type { ChatOptions, ChatResult, LlmClient } from '../src/llm/client.js';
import type { QueryBuilder } from '../src/db/queries.js';
import type { Node, SearchResult } from '../src/types.js';

type ChatMessage = Parameters<LlmClient['chat']>[0][number];

class CapturingClient {
  calls: Array<{ messages: ChatMessage[]; options: ChatOptions & { useAskModel?: boolean } }> = [];
  nextText = 'The answer cites `EXTRACTION_LOGIC_VERSION`.';

  async chat(messages: ChatMessage[], options: ChatOptions & { useAskModel?: boolean } = {}): Promise<ChatResult> {
    this.calls.push({ messages, options });
    return { text: this.nextText };
  }
}

function node(name: string, filePath: string, body: string, startLine = 1): Node {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body);
  const rel = path.relative(testRoot, filePath).replaceAll('\\', '/');
  return {
    id: `node:${name}`,
    name,
    kind: 'function',
    qualifiedName: `${rel}::${name}`,
    filePath: rel,
    language: 'typescript',
    signature: `function ${name}(): void`,
    startLine,
    endLine: startLine + body.split('\n').length - 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
  };
}

function result(node_: Node, score: number): SearchResult {
  return { node: node_, score };
}

function queriesWithDescriptions(descriptions: Record<string, string>): QueryBuilder {
  return {
    queries: {
      fetchSummariesAndDocstrings: {
        all({ nodeIds }: { nodeIds: string }) {
          return JSON.parse(nodeIds).map((id: string) => ({
            node_id: id,
            summary: descriptions[id] ?? '',
            docstring: '',
          }));
        },
      },
    },
  } as unknown as QueryBuilder;
}

let testRoot = '';

describe('askWithCandidates', () => {
  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-llm-ask-'));
  });

  afterEach(() => {
    if (fs.existsSync(testRoot)) fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it('hard-pins named question entities, anchors the system prompt, and forwards ask options', async () => {
    const payload = node(
      'PAYLOAD_VERSION',
      path.join(testRoot, 'src/payload.ts'),
      'export function PAYLOAD_VERSION() {}',
    );
    const extraction = node(
      'EXTRACTION_LOGIC_VERSION',
      path.join(testRoot, 'src/extraction.ts'),
      'export function EXTRACTION_LOGIC_VERSION() {\n  return 1;\n}',
    );
    const client = new CapturingClient();
    client.nextText = '<think>scratchpad</think> This answer only mentions PAYLOAD_VERSION.';
    const signal = new AbortController().signal;

    const answer = await askWithCandidates({
      projectRoot: testRoot,
      question: 'What triggers an EXTRACTION_LOGIC_VERSION bump?',
      candidates: [result(payload, 0.99), result(extraction, 0.2)],
      queries: queriesWithDescriptions({
        [payload.id]: 'Payload summary',
        [extraction.id]: '<think>hidden</think>Extraction summary',
      }),
      client: client as unknown as LlmClient,
      options: { temperature: 0.4, maxTokens: 321, useAskModel: true, signal },
    });

    expect(answer.citations.map((c) => c.node.name)).toEqual(['EXTRACTION_LOGIC_VERSION', 'PAYLOAD_VERSION']);
    expect(answer.citations[0]!.summary).toBe('Extraction summary');
    expect(answer.answer).toStartWith('This answer only mentions PAYLOAD_VERSION.');
    expect(answer.answer).toContain('question mentioned [EXTRACTION_LOGIC_VERSION]');

    expect(client.calls.length).toBe(1);
    const call = client.calls[0]!;
    expect(call.options).toMatchObject({ temperature: 0.4, maxTokens: 321, useAskModel: true, signal });
    expect(call.messages.length).toBe(2);
    expect(call.messages[0]).toMatchObject({
      role: 'system',
      content: expect.stringContaining('EXTRACTION_LOGIC_VERSION'),
    });
    const prompt = call.messages[1]!.content;
    expect(prompt.indexOf('### EXTRACTION_LOGIC_VERSION')).toBeLessThan(prompt.indexOf('### PAYLOAD_VERSION'));
    expect(prompt).toContain('*Summary*: Extraction summary');
    expect(prompt).toContain('```typescript');
  });

  it('uses a single user prompt with default chat options when the question names no code entity', async () => {
    const alpha = node('alpha', path.join(testRoot, 'src/alpha.ts'), 'export function alpha() { return 1; }');
    const beta = node('beta', path.join(testRoot, 'src/beta.ts'), 'export function beta() { return 2; }');
    const client = new CapturingClient();
    client.nextText = 'Use `alpha` in src/alpha.ts.';

    const answer = await askWithCandidates({
      projectRoot: testRoot,
      question: 'How does the helper work?',
      candidates: [result(alpha, 0.8), result(beta, 0.7)],
      queries: queriesWithDescriptions({ [alpha.id]: 'Alpha summary', [beta.id]: 'Beta summary' }),
      client: client as unknown as LlmClient,
    });

    expect(answer.answer).toBe('Use `alpha` in src/alpha.ts.');
    expect(answer.citations.map((c) => c.node.name)).toEqual(['alpha', 'beta']);
    expect(client.calls.length).toBe(1);
    expect(client.calls[0]!.messages).toHaveLength(1);
    expect(client.calls[0]!.messages[0]).toMatchObject({ role: 'user' });
    expect(client.calls[0]!.options).toMatchObject({ temperature: 0.2, maxTokens: 800 });
    expect(client.calls[0]!.options.useAskModel).toBeUndefined();
  });
});
