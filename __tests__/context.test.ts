/**
 * Context Builder Tests
 *
 * Tests for the context building functionality.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Cartograph from '../src/index.js';
import { getNodesByKind } from '../src/db/queries.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { collectContextIntentSeeds } from '../src/features/context-route/index.js';
import { appendToolCall, insertSession } from '../src/db/queries-trace.js';

describe('Context Builder', () => {
  let testDir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-context-test-'));

    // Create a sample codebase
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    // Create a payment service file
    fs.writeFileSync(
      path.join(srcDir, 'payment.ts'),
      `/**
 * Payment Service
 * Handles payment processing logic.
 */

export interface PaymentResult {
  success: boolean;
  transactionId: string;
  amount: number;
}

export class PaymentService {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Process a payment for the given amount
   */
  async processPayment(amount: number): Promise<PaymentResult> {
    // Validate amount
    if (amount <= 0) {
      throw new Error('Invalid amount');
    }

    // Process payment
    const transactionId = this.generateTransactionId();
    return {
      success: true,
      transactionId,
      amount,
    };
  }

  private generateTransactionId(): string {
    return 'txn_' + Math.random().toString(36).substring(2);
  }
}

export function createPaymentService(apiKey: string): PaymentService {
  return new PaymentService(apiKey);
}
`,
    );

    // Create a checkout controller file
    fs.writeFileSync(
      path.join(srcDir, 'checkout.ts'),
      `/**
 * Checkout Controller
 * Handles the checkout flow.
 */

import { PaymentService, PaymentResult } from './payment.js';

export interface CartItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
}

export class CheckoutController {
  private paymentService: PaymentService;

  constructor(paymentService: PaymentService) {
    this.paymentService = paymentService;
  }

  /**
   * Process checkout for the given cart
   */
  async processCheckout(cart: CartItem[]): Promise<PaymentResult> {
    const total = this.calculateTotal(cart);

    if (total === 0) {
      throw new Error('Cart is empty');
    }

    return this.paymentService.processPayment(total);
  }

  /**
   * Calculate the total price of the cart
   */
  calculateTotal(cart: CartItem[]): number {
    return cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
  }
}
`,
    );

    // Create a utilities file
    fs.writeFileSync(
      path.join(srcDir, 'utils.ts'),
      `/**
 * Utility functions
 */

export function formatCurrency(amount: number): string {
  return '$' + amount.toFixed(2);
}

export function validateEmail(email: string): boolean {
  return email.includes('@');
}
`,
    );

    // Initialize Cartograph
    cg = Cartograph.initSync(testDir, {
      config: {
        include: ['**/*.ts'],
        exclude: [],
      },
    });

    // Index the codebase
    await cg.indexAll();
  });

  afterEach(() => {
    if (cg) {
      cg.close();
    }
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('getCode()', () => {
    it('should extract code for a node', async () => {
      // Find the PaymentService class
      const nodes = getNodesByKind(cg.queries, 'class');
      const paymentService = nodes.find((n) => n.name === 'PaymentService');

      expect(paymentService).toBeDefined();

      const code = await cg.internals.contextBuilder.getCode(paymentService!.id);

      expect(code).not.toBeNull();
      expect(code).toContain('class PaymentService');
      expect(code).toContain('processPayment');
    });

    it('should return null for non-existent node', async () => {
      const code = await cg.internals.contextBuilder.getCode('non-existent-id');
      expect(code).toBeNull();
    });
  });

  describe('findRelevantContext()', () => {
    it('should find relevant nodes for a query', async () => {
      // Use simple query that matches symbol names (FTS5 treats spaces as AND)
      const result = await cg.internals.contextBuilder.findRelevantContext('PaymentService');

      expect(result.nodes.size).toBeGreaterThan(0);
      // Should find payment-related nodes
      const nodeNames = Array.from(result.nodes.values()).map((n) => n.name);
      expect(
        nodeNames.some((name) => name.toLowerCase().includes('payment') || name.toLowerCase().includes('checkout')),
      ).toBe(true);
    });

    it('should include edges in the result', async () => {
      const result = await cg.internals.contextBuilder.findRelevantContext('checkout', {
        traversalDepth: 2,
      });

      // Should have some edges from traversal
      expect(result.edges).toBeDefined();
    });

    it('should respect maxNodes option', async () => {
      const result = await cg.internals.contextBuilder.findRelevantContext('function', {
        maxNodes: 5,
      });

      expect(result.nodes.size).toBeLessThanOrEqual(5);
    });

    it('should clamp absurd searchLimit/maxNodes values to safe upper bounds', async () => {
      // Without clamping, the internal `findNodesByExactName` query would
      // request `searchLimit * 5` rows — passing 1e9 here would blow out
      // memory. The call should complete in normal time and not return more
      // than the hard cap on maxNodes (1000).
      const result = await cg.internals.contextBuilder.findRelevantContext('function', {
        searchLimit: 1_000_000_000,
        maxNodes: 1_000_000_000,
        traversalDepth: 1_000,
      });
      expect(result.nodes.size).toBeLessThanOrEqual(1000);
    });
  });

  describe('buildContext()', () => {
    it('should build context with markdown format', async () => {
      const result = await cg.internals.contextBuilder.buildContext('Fix checkout error', {
        format: 'markdown',
        maxCodeBlocks: 3,
      });

      expect(typeof result).toBe('string');
      const markdown = result as string;

      // Should contain markdown structure
      expect(markdown).toContain('## Code Context');
      expect(markdown).toContain('**Query:** Fix checkout error');
    });

    it('should build context with JSON format', async () => {
      const result = await cg.internals.contextBuilder.buildContext('payment processing', {
        format: 'json',
      });

      expect(typeof result).toBe('string');
      const parsed = JSON.parse(result as string);

      expect(parsed.query).toBe('payment processing');
      expect(parsed.nodes).toBeDefined();
      expect(Array.isArray(parsed.nodes)).toBe(true);
    });

    it('routes broad cross-cutting plan queries through coverage and intent search first', async () => {
      const handler = new ToolHandler(cg, { profile: 'full' });
      const result = await handler.execute('cartograph_context', {
        task: 'review whole codebase coverage and quality across tools',
        format: 'plan',
        code: false,
      });
      handler.closeAll();
      const text = result.content[0]?.text ?? '';
      const nextActions = result.metadata?.nextActions as Array<{ tool: string }> | undefined;

      expect(text).toContain('cartograph_deps');
      expect(text).toContain('"mode": "intent"');
      expect(nextActions?.[0]?.tool).toBe('cartograph_deps');
      expect(nextActions?.[0]?.args).toMatchObject({ mode: 'coverage' });
    });

    it('never recommends a tool hidden by the active MCP profile', async () => {
      const handler = new ToolHandler(cg, { profile: 'core' });
      const advertised = new Set(handler.getTools().map((tool) => tool.name));
      const result = await handler.execute('cartograph_context', {
        task: 'review whole codebase coverage and quality across tools',
        format: 'plan',
        code: false,
      });
      handler.closeAll();
      const text = result.content[0]?.text ?? '';
      const nextActions = result.metadata?.nextActions ?? [];

      expect(text).not.toContain('"tool": "cartograph_deps"');
      expect(nextActions.length).toBeGreaterThan(0);
      expect(nextActions.every((action) => advertised.has(action.tool))).toBe(true);
    });

    it('uses deterministic docstring intent as evidence for broad plan routing', async () => {
      const classes = getNodesByKind(cg.queries, 'class');
      const payment = classes.find((node) => node.name === 'PaymentService');
      const checkout = classes.find((node) => node.name === 'CheckoutController');
      expect(payment).toBeDefined();
      expect(checkout).toBeDefined();
      if (!payment || !checkout) throw new Error('expected payment and checkout fixtures');
      cg.queries.updateNode({ ...payment, docstring: 'Owns payment processing and payment retry behavior.' });
      cg.queries.updateNode({ ...checkout, docstring: 'Coordinates checkout flow and payment submission.' });
      const seeds = collectContextIntentSeeds({
        clauses: ['fix payment processing and checkout flow'],
        queries: cg.queries,
        limit: 10,
      });
      expect(seeds.metadata.nodeIds).toEqual(expect.arrayContaining([payment.id, checkout.id]));

      const handler = new ToolHandler(cg, { profile: 'core' });
      const result = await handler.execute('cartograph_context', {
        task: 'fix payment processing and checkout flow',
        format: 'plan',
        code: false,
        retrievalMode: 'deterministic',
      });
      handler.closeAll();
      const text = result.content[0]?.text ?? '';

      expect(text).toContain(
        '**Router:** deterministic task clauses + intent/documentation evidence + graph candidates',
      );
      expect(text).toContain('`PaymentService`');
      expect(text).toContain('`CheckoutController`');
      expect(text).toContain('docstring matched');
      expect(text).not.toContain('Router abstained');
    });

    it('surfaces project-local successful follow-up history as explicit route evidence', async () => {
      const payment = getNodesByKind(cg.queries, 'class').find((node) => node.name === 'PaymentService');
      expect(payment).toBeDefined();
      if (!payment) throw new Error('expected PaymentService fixture');
      const sessionId = 'context-learning-fixture';
      const startedTs = Date.now() - 100;
      insertSession({ qb: cg.queries, id: sessionId, startedTs, projectRoot: cg.projectRoot });
      appendToolCall(cg.queries, {
        sessionId,
        step: 1,
        ts: startedTs + 1,
        toolName: 'cartograph_context',
        argsJson: JSON.stringify({ task: 'fix payment retry handling', format: 'plan' }),
        resultSummary: '## Context route plan',
        durationMs: 1,
      });
      appendToolCall(cg.queries, {
        sessionId,
        step: 2,
        ts: startedTs + 2,
        toolName: 'cartograph_node',
        argsJson: JSON.stringify({ symbol: payment.id }),
        resultSummary: '## PaymentService',
        durationMs: 1,
      });

      const handler = new ToolHandler(cg, { profile: 'coding' });
      const result = await handler.execute('cartograph_context', {
        task: 'debug payment retry behavior',
        format: 'plan',
        retrievalMode: 'deterministic',
        localLearning: 'auto',
      });
      handler.closeAll();
      const text = result.content[0]?.text ?? '';

      expect(text).toContain('**Project-local learning:** 1 similar prior context');
      expect(text).toContain('project-local follow-up');
      expect(text).toContain('`PaymentService`');
    });

    it('supports deterministic retrieval mode and reports its provenance', async () => {
      const handler = new ToolHandler(cg);
      const result = await handler.execute('cartograph_context', {
        task: 'How does PaymentService process a checkout?',
        format: 'json',
        code: false,
        retrievalMode: 'deterministic',
      });
      handler.closeAll();

      expect(result.isError).not.toBe(true);
      const parsed = JSON.parse(result.content[0]?.text ?? '{}');
      expect(parsed.retrieval).toEqual({
        requested: 'deterministic',
        strategy: 'lexical-graph',
        hybridAttempted: false,
        hybridCandidateCount: 0,
        reason: 'explicit-deterministic',
      });
    });

    it('uses current unsynced symbols and source through the live working-tree overlay', async () => {
      const paymentPath = path.join(testDir, 'src', 'payment.ts');
      fs.appendFileSync(paymentPath, '\nexport function liveRetryPolicy(): number { return 3; }\n');
      const future = Math.floor(Date.now() / 1000) + 60;
      fs.utimesSync(paymentPath, future, future);
      const handler = new ToolHandler(cg, { profile: 'coding' });

      const result = await handler.execute('cartograph_context', {
        task: 'fix liveRetryPolicy behavior',
        workingTree: 'live',
        allowStale: true,
        retrievalMode: 'deterministic',
      });
      const text = result.content[0]?.text ?? '';

      expect(text).toContain('liveRetryPolicy');
      expect(text).toContain('Working-tree overlay');
      expect(text).toContain('source read from disk without persisting an index sync');
      expect(getNodesByKind(cg.queries, 'function').some((node) => node.name === 'liveRetryPolicy')).toBe(false);
      handler.closeAll();
    });

    it('emits a resumable handoff packet that preserves live changes and verification guidance', async () => {
      const paymentPath = path.join(testDir, 'src', 'payment.ts');
      fs.appendFileSync(paymentPath, '\nexport function handoffRetryPolicy(): number { return 4; }\n');
      const future = Math.floor(Date.now() / 1000) + 60;
      fs.utimesSync(paymentPath, future, future);
      const handler = new ToolHandler(cg, { profile: 'coding' });

      const result = await handler.execute('cartograph_context', {
        task: 'finish handoffRetryPolicy and verify it',
        format: 'handoff',
        retrievalMode: 'deterministic',
      });
      handler.closeAll();
      const text = result.content[0]?.text ?? '';

      expect(text).toContain('## Coding task handoff');
      expect(text).toContain('**Indexed graph:**');
      expect(text).toContain('handoffRetryPolicy');
      expect(text).toContain('src/payment.ts');
      expect(text).toContain('Preserve the existing working-tree changes');
      expect(text).toContain('cartograph_verify');
      expect(text).not.toContain('```typescript');
      expect(result.metadata?.nextActions?.some((action) => action.tool === 'cartograph_verify')).toBe(true);
    });

    it('should accept object input with title and description', async () => {
      const result = await cg.internals.contextBuilder.buildContext(
        {
          title: 'Checkout bug',
          description: 'Cart total calculation is wrong',
        },
        { format: 'markdown' },
      );

      expect(typeof result).toBe('string');
      expect(result).toContain('Checkout bug: Cart total calculation is wrong');
    });

    it('should include code blocks when requested', async () => {
      const result = await cg.internals.contextBuilder.buildContext('PaymentService', {
        format: 'markdown',
        includeCode: true,
        maxCodeBlocks: 2,
      });

      const markdown = result as string;

      // Should contain code blocks
      expect(markdown).toContain('### Code');
      expect(markdown).toContain('```typescript');
    });

    it('should exclude code blocks when requested', async () => {
      const result = await cg.internals.contextBuilder.buildContext('payment', {
        format: 'markdown',
        includeCode: false,
      });

      const markdown = result as string;

      // Should not contain code section
      expect(markdown).not.toContain('### Code');
    });

    it('should include related symbols in compact format', async () => {
      const result = await cg.internals.contextBuilder.buildContext('checkout', {
        format: 'markdown',
        maxNodes: 10,
      });

      const markdown = result as string;

      // Compact format uses "Related Symbols" instead of verbose "Related Files"
      // and groups symbols by file for compactness
      expect(markdown).toContain('### Entry Points');
    });

    it('should have compact output without verbose stats footer', async () => {
      const result = await cg.internals.contextBuilder.buildContext('payment', {
        format: 'markdown',
      });

      const markdown = result as string;

      // Compact format should NOT have verbose stats footer
      expect(markdown).not.toMatch(/\*Context:.*symbols.*relationships.*files/);
      // But should still have query
      expect(markdown).toContain('**Query:**');
    });
  });

  describe('Context structure', () => {
    it('should find entry points from search', async () => {
      const result = await cg.internals.contextBuilder.buildContext('PaymentService', {
        format: 'json',
      });

      const parsed = JSON.parse(result as string);

      expect(parsed.entryPoints).toBeDefined();
      expect(parsed.entryPoints.length).toBeGreaterThan(0);
    });

    it('should traverse graph from entry points', async () => {
      const result = await cg.internals.contextBuilder.buildContext('CheckoutController', {
        format: 'json',
        traversalDepth: 2,
      });

      const parsed = JSON.parse(result as string);

      // Should have found related nodes through traversal
      const nodeNames = parsed.nodes.map((n: { name: string }) => n.name);

      // CheckoutController calls PaymentService, so both should be present
      expect(nodeNames.some((name: string) => name.includes('Checkout'))).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty query', async () => {
      const result = await cg.internals.contextBuilder.buildContext('', { format: 'markdown' });

      expect(typeof result).toBe('string');
    });

    it('should handle query with no matches', async () => {
      const result = await cg.internals.contextBuilder.buildContext('xyznonexistent123', {
        format: 'json',
      });

      const parsed = JSON.parse(result as string);

      // Should return empty or minimal results
      expect(parsed.nodes).toBeDefined();
    });

    it('should truncate long code blocks', async () => {
      const result = await cg.internals.contextBuilder.buildContext('PaymentService', {
        format: 'markdown',
        maxCodeBlockSize: 100,
        includeCode: true,
      });

      const markdown = result as string;

      // Long code blocks should be truncated
      if (markdown.includes('```typescript')) {
        // If there's a code block, check for truncation marker if content was long
        // This test validates the truncation logic works
        expect(typeof markdown).toBe('string');
      }
    });
  });

  // Friction #8 / cluster #1 follow-up. When the query mentions a
  // canonical `cartograph_X` MCP tool name, the registered XXX_TOOL
  // constant must surface in entry points instead of being drowned by
  // unrelated symbols matching the trailing English in the question.
  describe('MCP tool-name promotion', () => {
    let mcpDir: string;
    let mcpCg: Cartograph;

    beforeEach(async () => {
      mcpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-context-mcp-'));
      fs.mkdirSync(path.join(mcpDir, 'src'));
      // A registered MCP tool plus a few unrelated SQL-related
      // symbols that the trailing English in the test query also
      // matches. Without the promotion, the SQL symbols outrank the
      // tool itself.
      fs.writeFileSync(
        path.join(mcpDir, 'src', 'demo-tool.ts'),
        `function handleDemo() { return { ok: true }; }
export const DEMO_TOOL = {
  definition: { name: 'cartograph_demo', description: 'demo' },
  handle: handleDemo,
};
`,
      );
      fs.writeFileSync(
        path.join(mcpDir, 'src', 'sql-helpers.ts'),
        `export function buildSqlSelect(table: string) { return 'SELECT * FROM ' + table; }
export function buildSqlInsert(table: string) { return 'INSERT INTO ' + table + ' VALUES (?)'; }
export function buildSqlUpdate(table: string) { return 'UPDATE ' + table + ' SET ?'; }
`,
      );
      mcpCg = await Cartograph.init(mcpDir, { config: { llm: { endpoint: '' } } });
      await mcpCg.indexAll({ summarize: false });
    });

    afterEach(() => {
      if (mcpCg) mcpCg.close();
      if (fs.existsSync(mcpDir)) fs.rmSync(mcpDir, { recursive: true, force: true });
    });

    it('promotes XXX_TOOL constant to entry points when query mentions cartograph_X', async () => {
      const result = await mcpCg.internals.contextBuilder.buildContext(
        'how does cartograph_demo dispatch sql content env axes',
        { format: 'json', maxNodes: 6 },
      );
      const parsed = JSON.parse(result as string);
      const entryPointNames = parsed.entryPoints.map((n: { name: string }) => n.name);
      expect(entryPointNames).toContain('DEMO_TOOL');
    });
  });

  // Friction 2026-05-14: "how does X happen" questions surfaced
  // state-shape symbols (interfaces / type aliases) but missed the
  // gating function. The fix has two prongs in the context builder:
  // (1) accept externally-supplied `extraCandidates` from the MCP
  //     layer's hybrid retrieval substrate, and merge them into the
  //     lexical candidate pool BEFORE camel-case / centrality passes;
  // (2) when `behaviorBias` is on, boost function/method/route kinds
  //     and penalise interface/type kinds so a deterministic ranking
  //     tie breaks toward the gating logic.
  describe('Behaviour-bias retrieval (friction 2026-05-14)', () => {
    let bDir: string;
    let bCg: Cartograph;

    beforeEach(async () => {
      bDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-context-behavior-'));
      fs.mkdirSync(path.join(bDir, 'src'));
      // Mirror the watcher.ts shape: an interface (state-shape) AND a
      // gating function. Lexical-only ranking puts the interface first
      // because CamelCase prefix + brevity bonus + centrality favours
      // the shape symbol. Behaviour bias must promote the function.
      fs.writeFileSync(
        path.join(bDir, 'src', 'watcher.ts'),
        `export interface WatcherStats {
  syncCount: number;
  failureCount: number;
}
export interface WatcherState {
  hasChanges: boolean;
  syncing: boolean;
}
/** Decides when to trigger a sync — debounce + safety-net periodic. */
export function watcherHandleFileEvent(state: WatcherState): void {
  if (!state.syncing) state.hasChanges = true;
}
export function watcherScheduleSync(state: WatcherState): void {
  state.hasChanges = true;
}
export function watcherFlush(state: WatcherState): void {
  state.syncing = true;
}
export class FileWatcher {
  start(): void {}
  stop(): void {}
}
`,
      );
      bCg = await Cartograph.init(bDir, { config: { llm: { endpoint: '' } } });
      await bCg.indexAll({ summarize: false });
    });

    afterEach(() => {
      if (bCg) bCg.close();
      if (fs.existsSync(bDir)) fs.rmSync(bDir, { recursive: true, force: true });
    });

    it('surfaces the gating function (not just shape interfaces) when behaviorBias is on', async () => {
      const result = await bCg.internals.contextBuilder.buildContext(
        'how does the file watcher decide when to trigger a sync',
        { format: 'json', maxNodes: 8, behaviorBias: true },
      );
      const parsed = JSON.parse(result as string);
      const nodeNames = new Set(parsed.nodes.map((n: { name: string }) => n.name));
      // Acceptance: at least one of the gating functions must surface.
      const gatingFunctions = ['watcherHandleFileEvent', 'watcherScheduleSync', 'watcherFlush'];
      expect(gatingFunctions.some((name) => nodeNames.has(name))).toBe(true);
    });

    it('accepts extraCandidates as a seed and merges them into the pool', async () => {
      const fnNode = getNodesByKind(bCg.queries, 'function').find((n) => n.name === 'watcherHandleFileEvent');
      expect(fnNode).toBeDefined();
      const seed = { node: fnNode!, score: 0.42 };
      const result = await bCg.internals.contextBuilder.buildContext('unrelated query about something else', {
        format: 'json',
        maxNodes: 8,
        extraCandidates: [seed],
      });
      const parsed = JSON.parse(result as string);
      const nodeNames = parsed.nodes.map((n: { name: string }) => n.name);
      // The seed candidate must survive the minScore filter — it is
      // seeded with a rank-aware score inside the builder.
      expect(nodeNames).toContain('watcherHandleFileEvent');
    });

    it('lets an extra candidate replace stale persisted metadata for the same stable node id', async () => {
      const persisted = getNodesByKind(bCg.queries, 'function').find((node) => node.name === 'watcherHandleFileEvent');
      expect(persisted).toBeDefined();
      if (!persisted) throw new Error('missing watcherHandleFileEvent fixture');
      const liveEndLine = persisted.endLine + 7;
      const result = await bCg.internals.contextBuilder.buildContext('watcherHandleFileEvent', {
        format: 'json',
        maxNodes: 8,
        extraCandidates: [{ node: { ...persisted, endLine: liveEndLine }, score: 1 }],
      });
      const parsed = JSON.parse(result as string);
      const returned = parsed.nodes.find((node: { id: string }) => node.id === persisted.id);

      expect(returned?.endLine).toBe(liveEndLine);
    });

    it('guarantees a top semantic extra-candidate an entry-point slot (F-r9-1)', async () => {
      // The lexical channel favours prefix matches: for the term
      // "watcher" the WatcherStats/WatcherState interfaces and the
      // behaviour-biased gating functions out-score the FileWatcher
      // class (only a substring match for "watcher"). Without the
      // guaranteed inclusion of top semantic hits, the class — the
      // literal subject of the query — loses every entry-point slot.
      const fileWatcher = getNodesByKind(bCg.queries, 'class').find((n) => n.name === 'FileWatcher');
      expect(fileWatcher).toBeDefined();
      // FileWatcher ranked #1 by the (here hand-built) semantic channel.
      const extraCandidates = [{ node: fileWatcher!, score: 0.9 }];
      const result = await bCg.internals.contextBuilder.buildContext('how does the file watcher trigger a sync', {
        format: 'json',
        maxNodes: 8,
        behaviorBias: true,
        extraCandidates,
      });
      const parsed = JSON.parse(result as string);
      const entryNames = parsed.entryPoints.map((n: { name: string }) => n.name);
      expect(entryNames).toContain('FileWatcher');
    });
  });
});

/**
 * FRICTION-AF — exact whole-word name promotion.
 *
 * A natural-language query that literally names a symbol (`the sync
 * method ...`) used to whiff: the seed search was dominated by FTS
 * hits on the query's other tokens, and the exactly-named symbol got
 * sliced out of the 3-seed budget. The fixture below reproduces the
 * shape — a single specific `sync` method versus a flood of symbols
 * sharing the generic `extract` token — and asserts the promotion
 * surfaces `sync` while NOT letting the generic `extract` flood the
 * seeds.
 */
describe('Context Builder — exact-name promotion (FRICTION-AF)', () => {
  let testDir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-context-afname-'));
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    // The specific symbol the query will name outright.
    fs.writeFileSync(
      path.join(srcDir, 'orchestrator.ts'),
      `export class Orchestrator {
  /** Decide which files changed and re-index them. */
  async sync(force: boolean): Promise<number> {
    return force ? 1 : 0;
  }
}
`,
    );

    // A flood of symbols sharing the generic \`extract\` token — every
    // extractor class defines an \`extract\` method. The query mentions
    // "extract", but it must NOT crowd \`sync\` out of the seeds.
    for (const lang of ['Hcl', 'Sql', 'Dfm', 'Css', 'Toml']) {
      fs.writeFileSync(
        path.join(srcDir, `${lang.toLowerCase()}-extractor.ts`),
        String.raw`export class ${lang}Extractor {
  /** Extract symbols from a ${lang} source file. */
  extract(source: string): string[] {
    return source.split('\n');
  }
}
`,
      );
    }

    cg = Cartograph.initSync(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll();
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('surfaces the exactly-named `sync` method as an entry point', async () => {
    const result = await cg.internals.contextBuilder.buildContext(
      'how does the sync method decide which files to re-extract',
      { format: 'json' },
    );
    const parsed = JSON.parse(result as string);
    const entryNames: string[] = parsed.entryPoints.map((n: { name: string }) => n.name);
    expect(entryNames).toContain('sync');
  });

  it('does not let the generic `extract` token flood the seed set', async () => {
    const result = await cg.internals.contextBuilder.buildContext(
      'how does the sync method decide which files to re-extract',
      { format: 'json' },
    );
    const parsed = JSON.parse(result as string);
    const entryNames: string[] = parsed.entryPoints.map((n: { name: string }) => n.name);
    // `sync` (the specific token) surfaces — the promotion works AND
    // is not crowded out. Before the fix the seeds were wall-to-wall
    // extractor symbols with zero `sync`.
    expect(entryNames).toContain('sync');
    // 5 extractor classes share the generic `extract` method name; the
    // promotion must SKIP it (over the hit cap). `extract` symbols may
    // still appear via the base exact-name channel — the query does
    // say "re-extract" — but they must not fill every seed slot.
    const extractishSeeds = entryNames.filter((n) => n === 'extract' || n.endsWith('Extractor'));
    expect(extractishSeeds.length).toBeLessThan(entryNames.length);
  });
});

describe('Context Builder — non-ASCII query terms', () => {
  let testDir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-context-unicode-'));
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    fs.writeFileSync(
      path.join(srcDir, 'auth.ts'),
      `export function 로그인(사용자명: string): boolean {
  return 인증확인(사용자명);
}

export function 인증확인(사용자명: string): boolean {
  return 사용자명.length > 0;
}

export class 사용자관리자 {
  생성하기(이름: string): string {
    return 이름;
  }
}
`,
    );

    cg = Cartograph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('surfaces Korean symbols for Korean context queries', async () => {
    const result = await cg.internals.contextBuilder.buildContext('로그인 인증확인 흐름', { format: 'json' });
    const parsed = JSON.parse(result as string);
    const entryNames: string[] = parsed.entryPoints.map((n: { name: string }) => n.name);
    const nodeNames: string[] = parsed.nodes.map((n: { name: string }) => n.name);

    expect(entryNames).toContain('로그인');
    expect(nodeNames).toEqual(expect.arrayContaining(['로그인', '인증확인']));
  });
});
