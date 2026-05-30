/**
 * Rule-registry composition tests — structural fix #29.
 *
 * Three heuristic detectors expose typed rule registries:
 *   - `USED_SIGNAL_RULES` + `UNDECLARED_SUPPRESSION_RULES` in `src/deps/unused.ts`
 *   - `HEDGE_SIGNALS` in `src/llm/dead-code.ts`
 *
 * The shape contract for each: every rule carries a stable `name`,
 * a non-empty `description`, and the right predicate / mutator
 * signature. These tests pin the contract so adding a new rule is
 * mechanically one entry — drift would fail here loudly.
 */
import { describe, it, expect } from 'vitest';
import {
  USED_SIGNAL_RULES,
  UNDECLARED_SUPPRESSION_RULES,
  type UsedSignalRule,
  type UndeclaredSuppressionRule,
} from '../src/deps/unused.js';
import { HEDGE_SIGNALS, type HedgeSignal, INTERFACE_DISPATCH_CONFIDENCE_CAP } from '../src/llm/dead-code.js';

describe('deps RuleRegistry — USED_SIGNAL_RULES contract', () => {
  it('every rule has a stable kebab-case name + non-empty description', () => {
    expect(USED_SIGNAL_RULES.length).toBeGreaterThan(0);
    for (const rule of USED_SIGNAL_RULES) {
      expect(rule.name).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(rule.description.length).toBeGreaterThan(10);
    }
  });

  it('rule names are unique', () => {
    const names = USED_SIGNAL_RULES.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every rule exposes an `apply` callable', () => {
    for (const rule of USED_SIGNAL_RULES) {
      expect(typeof rule.apply).toBe('function');
    }
  });

  it('registry contains the four canonical signals (regression guard)', () => {
    const names = USED_SIGNAL_RULES.map((r) => r.name);
    // Adding a new rule is fine — these four must STAY because the
    // bug fixes #8 (vitest), #9 (tree-sitter-cli), and the original
    // deps heuristics depend on them. Removing one would silently
    // regress those bugs; the test fails before that lands.
    expect(names).toContain('source-scan-dynamic-imports');
    expect(names).toContain('package-json-scripts-and-allowlist');
    expect(names).toContain('script-files-bin-invocations');
    expect(names).toContain('test-runner-coverage-provider');
  });

  it('adding a new rule entry is mechanically one operation (smoke)', () => {
    // Smoke the structural pattern by composing a synthetic rule and
    // exercising it against the registry shape. Doesn't add the rule
    // to the production registry — just verifies the type contract.
    const syntheticRule: UsedSignalRule = {
      name: 'synthetic-test-rule',
      description: 'A synthetic rule added in a test — should never appear in production output.',
      apply: ({ usedSet }) => usedSet.add('synthetic-package'),
    };
    const composed = [...USED_SIGNAL_RULES, syntheticRule];
    expect(composed.length).toBe(USED_SIGNAL_RULES.length + 1);
    expect(composed.at(-1)?.name).toBe('synthetic-test-rule');
  });
});

describe('deps RuleRegistry — UNDECLARED_SUPPRESSION_RULES contract', () => {
  it('every rule has a stable name + non-empty description + predicate', () => {
    expect(UNDECLARED_SUPPRESSION_RULES.length).toBeGreaterThan(0);
    for (const rule of UNDECLARED_SUPPRESSION_RULES) {
      expect(rule.name).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(rule.description.length).toBeGreaterThan(10);
      expect(typeof rule.shouldSuppress).toBe('function');
    }
  });

  it('rule names are unique', () => {
    const names = UNDECLARED_SUPPRESSION_RULES.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('registry includes the two regression-tied rules (#8 vitest + the long-standing @types/X)', () => {
    const names = UNDECLARED_SUPPRESSION_RULES.map((r) => r.name);
    expect(names).toContain('typed-upstream-declared');
    expect(names).toContain('runtime-shimmed-specifier');
  });

  it('typed-upstream-declared suppresses iff the upstream is in typedUpstreams', () => {
    const rule = UNDECLARED_SUPPRESSION_RULES.find((r) => r.name === 'typed-upstream-declared')!;
    const ctx = {
      projectRoot: '/tmp/x',
      packageJson: {},
      typedUpstreams: new Set(['react']),
      shimmedSpecifiers: new Set<string>(),
    };
    expect(rule.shouldSuppress('react', ctx)).toBe(true);
    expect(rule.shouldSuppress('vue', ctx)).toBe(false);
  });

  it('runtime-shimmed-specifier suppresses iff the spec is in shimmedSpecifiers', () => {
    const rule = UNDECLARED_SUPPRESSION_RULES.find((r) => r.name === 'runtime-shimmed-specifier')!;
    const ctx = {
      projectRoot: '/tmp/x',
      packageJson: {},
      typedUpstreams: new Set<string>(),
      shimmedSpecifiers: new Set(['vitest']),
    };
    expect(rule.shouldSuppress('vitest', ctx)).toBe(true);
    expect(rule.shouldSuppress('mocha', ctx)).toBe(false);
  });

  it('adding a new suppression rule is mechanically one operation (smoke)', () => {
    const syntheticRule: UndeclaredSuppressionRule = {
      name: 'synthetic-suppression',
      description: 'A synthetic suppression rule added in a test — should never reach production.',
      shouldSuppress: () => false,
    };
    const composed = [...UNDECLARED_SUPPRESSION_RULES, syntheticRule];
    expect(composed.length).toBe(UNDECLARED_SUPPRESSION_RULES.length + 1);
  });
});

describe('dead-code RuleRegistry — HEDGE_SIGNALS contract', () => {
  it('every signal has the full {name, description, detect, promptAnnotation, confidenceCap} shape', () => {
    expect(HEDGE_SIGNALS.length).toBeGreaterThan(0);
    for (const sig of HEDGE_SIGNALS) {
      expect(sig.name).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(sig.description.length).toBeGreaterThan(10);
      expect(typeof sig.detect).toBe('function');
      expect(sig.promptAnnotation).toMatch(/^\[WARN: /);
      expect(sig.confidenceCap).toBeGreaterThan(0);
      expect(sig.confidenceCap).toBeLessThan(1);
    }
  });

  it('signal names are unique', () => {
    const names = HEDGE_SIGNALS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("includes the regression-tied 'interface-dispatch' signal at cap === INTERFACE_DISPATCH_CONFIDENCE_CAP", () => {
    const iface = HEDGE_SIGNALS.find((s) => s.name === 'interface-dispatch');
    expect(iface).toBeDefined();
    expect(iface!.confidenceCap).toBe(INTERFACE_DISPATCH_CONFIDENCE_CAP);
    // Prompt-annotation contract: must mention the dispatch mechanism
    // so the LLM has a concrete structural reason to hedge.
    expect(iface!.promptAnnotation).toMatch(/interface/i);
  });

  it('adding a new hedge signal is mechanically one operation (smoke)', () => {
    const syntheticSignal: HedgeSignal = {
      name: 'synthetic-hedge',
      description: 'A synthetic hedge signal added in a test — should never reach production.',
      detect: () => false,
      promptAnnotation: '[WARN: synthetic — never fires in production]',
      confidenceCap: 0.7,
    };
    const composed = [...HEDGE_SIGNALS, syntheticSignal];
    expect(composed.length).toBe(HEDGE_SIGNALS.length + 1);
  });
});
