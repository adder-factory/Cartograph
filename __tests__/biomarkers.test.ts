/**
 * Biomarker engine + end-to-end orchestration tests.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  appendFindings,
  countFindingsRanked,
  getFindingsForNode,
  getFindingsRanked,
  getFindingsStats,
} from '../src/db/queries-findings.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars.js';
import { getNodesByKind } from '../src/db/queries.js';
import {
  computeMetrics,
  evaluateRules,
  findNodeAt,
  codeHealthScore,
  _internalForTests,
} from '../src/biomarkers/index.js';

const { isMagicNumber } = _internalForTests;

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-biomarkers-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

describe('engine: computeMetrics', () => {
  it('counts cyclomatic complexity from branches', () => {
    const src = `function f(x: number): number {
  if (x > 0) return 1;
  if (x < 0) return -1;
  for (let i = 0; i < 10; i++) {
    if (i === x) return i;
  }
  return 0;
}`;
    const node = findNodeAt({ source: src, language: 'typescript', line: 1, column: 0 });
    expect(node).not.toBeNull();
    const m = computeMetrics({ bodyNode: node!, language: 'typescript', startLine: 1, endLine: 7 });
    // Base 1 + 3 if + 1 for + 1 if-inside-for = 6. Expect close to that.
    expect(m.cyclomatic).toBeGreaterThanOrEqual(5);
  });

  it('tracks max nesting depth', () => {
    const src = `function f(): number {
  if (true) {
    while (true) {
      for (;;) {
        if (false) {
          return 1;
        }
      }
    }
  }
  return 0;
}`;
    const node = findNodeAt({ source: src, language: 'typescript', line: 1, column: 0 });
    expect(node).not.toBeNull();
    const m = computeMetrics({ bodyNode: node!, language: 'typescript', startLine: 1, endLine: 11 });
    expect(m.maxNesting).toBeGreaterThanOrEqual(4);
  });

  it('reports loc as inclusive line span', () => {
    const src = `function tiny() { return 1; }`;
    const node = findNodeAt({ source: src, language: 'typescript', line: 1, column: 0 });
    expect(node).not.toBeNull();
    const m = computeMetrics({ bodyNode: node!, language: 'typescript', startLine: 1, endLine: 1 });
    expect(m.loc).toBe(1);
  });

  // F#31 (2026-05-26) — Rust per-symbol biomarkers never fired because
  // the language MAPS table lacked a `rust` key, so the biomarker
  // engine short-circuited at the `getLangMap(language)` check. Helix's
  // 438-LOC `handle_debugger_message` reported Code Health 10/10 until
  // the RUST LangMap landed.
  it('Rust: cyclomatic counts if/for/while/loop/match_arm branches', () => {
    const src = `fn classify(x: i32, y: i32) -> i32 {
    if x > 0 {
        for i in 0..x {
            if i == y { return i; }
        }
    } else if x < 0 {
        while y > 0 { return -1; }
    }
    match x {
        0 => 0,
        n if n > 0 => 1,
        _ => -1,
    }
}`;
    const node = findNodeAt({ source: src, language: 'rust', line: 1, column: 0 });
    expect(node).not.toBeNull();
    const m = computeMetrics({ bodyNode: node!, language: 'rust', startLine: 1, endLine: 14 });
    // Base 1 + outer if + inner for + inner if + else-if + while + 3 match_arms = 9. Expect ≥ 7.
    expect(m.cyclomatic).toBeGreaterThanOrEqual(7);
  });

  it('Rust: tracks max nesting depth across if / for / while / loop / match', () => {
    const src = `fn deep() -> i32 {
    if true {
        for i in 0..10 {
            while i > 0 {
                loop {
                    match i {
                        0 => return 1,
                        _ => return 2,
                    }
                }
            }
        }
    }
    0
}`;
    const node = findNodeAt({ source: src, language: 'rust', line: 1, column: 0 });
    expect(node).not.toBeNull();
    const m = computeMetrics({ bodyNode: node!, language: 'rust', startLine: 1, endLine: 15 });
    expect(m.maxNesting).toBeGreaterThanOrEqual(4);
  });

  it('Rust: counts declaration-site parameters via the `parameters` AST node', () => {
    const src = `fn many(a: i32, b: i32, c: i32, d: i32, e: i32) -> i32 { a + b + c + d + e }`;
    const node = findNodeAt({ source: src, language: 'rust', line: 1, column: 0 });
    expect(node).not.toBeNull();
    const m = computeMetrics({ bodyNode: node!, language: 'rust', startLine: 1, endLine: 1 });
    expect(m.paramCount).toBe(5);
  });

  // LangMap audit batch (2026-05-26) — smoke tests that each newly-registered
  // language's LangMap produces non-zero cyclomatic on a control-flow-heavy
  // sample. These lock in that the per-language metric biomarkers
  // (`complex_method`, `large_method`, `nested_complexity`, etc.) won't
  // silently regress to zero coverage for those languages.

  it('Kotlin: cyclomatic counts if/for/while/when_entry branches', () => {
    const src = `fun classify(x: Int, y: Int): Int {
    if (x > 0) {
        for (i in 0..x) {
            if (i == y) return i
        }
    }
    return when (x) {
        0 -> 0
        1 -> 1
        else -> -1
    }
}`;
    const node = findNodeAt({ source: src, language: 'kotlin', line: 1, column: 0 });
    expect(node).not.toBeNull();
    const m = computeMetrics({ bodyNode: node!, language: 'kotlin', startLine: 1, endLine: 12 });
    expect(m.cyclomatic).toBeGreaterThanOrEqual(5);
  });

  it('Swift: cyclomatic counts if/for/while/switch_entry branches', () => {
    const src = `func classify(x: Int, y: Int) -> Int {
    if x > 0 {
        for i in 0..<x {
            if i == y { return i }
        }
    }
    switch x {
        case 0: return 0
        case 1: return 1
        default: return -1
    }
}`;
    const node = findNodeAt({ source: src, language: 'swift', line: 1, column: 0 });
    expect(node).not.toBeNull();
    const m = computeMetrics({ bodyNode: node!, language: 'swift', startLine: 1, endLine: 12 });
    expect(m.cyclomatic).toBeGreaterThanOrEqual(5);
  });

  it('C#: cyclomatic counts if/for/while/switch_section branches', () => {
    const src = `class Foo {
    int classify(int x, int y) {
        if (x > 0) {
            for (int i = 0; i < x; i++) {
                if (i == y) return i;
            }
        }
        switch (x) {
            case 0: return 0;
            case 1: return 1;
            default: return -1;
        }
    }
}`;
    const node = findNodeAt({ source: src, language: 'csharp', line: 2, column: 4 });
    expect(node).not.toBeNull();
    const m = computeMetrics({ bodyNode: node!, language: 'csharp', startLine: 2, endLine: 13 });
    expect(m.cyclomatic).toBeGreaterThanOrEqual(5);
  });

  it('C: cyclomatic counts if/for/while/case branches', () => {
    const src = `int classify(int x, int y) {
    if (x > 0) {
        for (int i = 0; i < x; i++) {
            if (i == y) return i;
        }
    }
    switch (x) {
        case 0: return 0;
        case 1: return 1;
        default: return -1;
    }
    return 0;
}`;
    const node = findNodeAt({ source: src, language: 'c', line: 1, column: 0 });
    expect(node).not.toBeNull();
    const m = computeMetrics({ bodyNode: node!, language: 'c', startLine: 1, endLine: 13 });
    expect(m.cyclomatic).toBeGreaterThanOrEqual(5);
  });

  it('C++: cyclomatic counts if/for/while/case/catch branches', () => {
    const src = `int classify(int x, int y) {
    if (x > 0) {
        for (int i = 0; i < x; ++i) {
            if (i == y) return i;
        }
    }
    try {
        switch (x) {
            case 0: return 0;
            case 1: return 1;
            default: return -1;
        }
    } catch (...) {
        return -2;
    }
    return 0;
}`;
    const node = findNodeAt({ source: src, language: 'cpp', line: 1, column: 0 });
    expect(node).not.toBeNull();
    const m = computeMetrics({ bodyNode: node!, language: 'cpp', startLine: 1, endLine: 17 });
    expect(m.cyclomatic).toBeGreaterThanOrEqual(6);
  });

  it('PHP: cyclomatic counts if/for/foreach/while/case/catch branches', () => {
    const src = `<?php
function classify(int $x, int $y): int {
    if ($x > 0) {
        for ($i = 0; $i < $x; $i++) {
            if ($i == $y) return $i;
        }
    }
    try {
        switch ($x) {
            case 0: return 0;
            case 1: return 1;
            default: return -1;
        }
    } catch (Exception $e) {
        return -2;
    }
    return 0;
}`;
    const node = findNodeAt({ source: src, language: 'php', line: 2, column: 0 });
    expect(node).not.toBeNull();
    const m = computeMetrics({ bodyNode: node!, language: 'php', startLine: 2, endLine: 18 });
    expect(m.cyclomatic).toBeGreaterThanOrEqual(5);
  });

  it('Scala: cyclomatic counts if/for/while/case_clause/catch branches', () => {
    const src = `def classify(x: Int, y: Int): Int = {
    if (x > 0) {
        for (i <- 0 until x) {
            if (i == y) return i
        }
    }
    try {
        x match {
            case 0 => 0
            case 1 => 1
            case _ => -1
        }
    } catch {
        case e: Exception => -2
    }
}`;
    const node = findNodeAt({ source: src, language: 'scala', line: 1, column: 0 });
    expect(node).not.toBeNull();
    const m = computeMetrics({ bodyNode: node!, language: 'scala', startLine: 1, endLine: 16 });
    expect(m.cyclomatic).toBeGreaterThanOrEqual(5);
  });

  it('Dart: cyclomatic counts if/for/while branches', () => {
    // Dart grammar splits switch into label-per-case (`switch_label`)
    // rather than a `case_statement`-per-case; the LangMap covers it
    // via `switch_label` in `branching`. Test uses if + for + while
    // alone to be robust against findNodeAt offset issues on
    // class-less top-level functions.
    const src = `int classify(int x, int y) {
    if (x > 0) {
        for (var i = 0; i < x; i++) {
            if (i == y) return i;
        }
        while (y > 0) return -1;
    }
    return 0;
}`;
    // Dart's grammar puts `function_signature` and `function_body` as
    // SIBLINGS (not parent/child), so anchoring findNodeAt at (1,0)
    // hits the signature subtree. Point at the body's first interior
    // statement so computeMetrics walks the actual control flow.
    const node = findNodeAt({ source: src, language: 'dart', line: 2, column: 4 });
    expect(node).not.toBeNull();
    const m = computeMetrics({ bodyNode: node!, language: 'dart', startLine: 1, endLine: 9 });
    expect(m.cyclomatic).toBeGreaterThanOrEqual(3);
  });

  it('Ruby: cyclomatic counts BOTH block-form (`if`/`while`/`case-when`/`rescue`) AND modifier-form (`if_modifier`/`while_modifier`/`unless_modifier`) branches', () => {
    // Ruby's grammar splits each control construct into a block-form
    // AND a postfix-modifier form — `expr if cond` is `if_modifier`,
    // a separate node from block-form `if cond ... end`. Both add a
    // McCabe branch, so RUBY.branching enumerates both shapes.
    const src = `def classify(x, y)
  return -1 unless x > 0
  return 1 if x == y
  for i in 0..x
    next if i == 0
    return i while i > 0
  end
  begin
    case x
    when 0 then 0
    when 1 then 1
    else -1
    end
  rescue StandardError => e
    -2
  end
end`;
    const node = findNodeAt({ source: src, language: 'ruby', line: 1, column: 0 });
    expect(node).not.toBeNull();
    const m = computeMetrics({ bodyNode: node!, language: 'ruby', startLine: 1, endLine: 17 });
    // base 1 + unless_modifier + if_modifier + for + if_modifier(next) +
    // while_modifier + 2 when + rescue = 9. Conservative ≥ 7.
    expect(m.cyclomatic).toBeGreaterThanOrEqual(7);
  });

  it('Go: does NOT count `if err != nil` as a cyclomatic branch (gocyclo parity)', () => {
    // ollama bug-hunt threshold suggestion: Go's mandatory `if err !=
    // nil { return err }` boilerplate added +1 cyclomatic per error
    // path, pushing routine Go code into complex_method warning/error
    // tiers for nothing more than careful error handling.
    const src = `package p

func run() error {
    a, err := step1()
    if err != nil {
        return err
    }
    b, err := step2(a)
    if err != nil {
        return err
    }
    c, err := step3(b)
    if err != nil {
        return err
    }
    _ = c
    return nil
}`;
    const node = findNodeAt({ source: src, language: 'go', line: 3, column: 0 });
    expect(node).not.toBeNull();
    const m = computeMetrics({ bodyNode: node!, language: 'go', startLine: 3, endLine: 17 });
    // Base 1 cyclomatic (no real branches survive the err-nil deduction).
    expect(m.cyclomatic).toBe(1);
  });

  it('Go: still counts non-err-nil `if` statements as cyclomatic branches', () => {
    // Negative case: real branching logic still increments.
    const src = `package p

func tier(x int) string {
    if x > 100 {
        return "big"
    }
    if x > 10 {
        return "medium"
    }
    return "small"
}`;
    const node = findNodeAt({ source: src, language: 'go', line: 3, column: 0 });
    expect(node).not.toBeNull();
    const m = computeMetrics({ bodyNode: node!, language: 'go', startLine: 3, endLine: 11 });
    // Base 1 + 2 real if-branches = 3.
    expect(m.cyclomatic).toBe(3);
  });

  it('Go: counts `if x == nil` as a nil-check (deducted), not a real branch', () => {
    // The `== nil` form is the happy-path twin of `!= nil` — same
    // boilerplate-noise category; both are skipped.
    const src = `package p

func init0(x *int) int {
    if x == nil {
        return 0
    }
    return *x
}`;
    const node = findNodeAt({ source: src, language: 'go', line: 3, column: 0 });
    expect(node).not.toBeNull();
    const m = computeMetrics({ bodyNode: node!, language: 'go', startLine: 3, endLine: 8 });
    expect(m.cyclomatic).toBe(1);
  });

  it('TS: same `if x == null` shape does NOT trigger the Go deduction', () => {
    // Gated on language === 'go' so other langs' nil-check idioms
    // stay as branches (TypeScript / JS don't have the same gocyclo
    // convention).
    const src = `function init0(x: number | null): number {
  if (x === null) {
    return 0;
  }
  return x;
}`;
    const node = findNodeAt({ source: src, language: 'typescript', line: 1, column: 0 });
    expect(node).not.toBeNull();
    const m = computeMetrics({ bodyNode: node!, language: 'typescript', startLine: 1, endLine: 6 });
    // Base 1 + 1 if = 2 (TS doesn't get the deduction).
    expect(m.cyclomatic).toBeGreaterThanOrEqual(2);
  });

  it('counts hardcoded URL literals but skips format-string templates', () => {
    // ollama bug-hunt FP: `fmt.Sprintf("http://%s", origin)` was tallied
    // as a hardcoded URL because URL_LITERAL_RE matched up to `%`.
    // Tightened to exclude `%`/`{`/`$` as the first path char after `://`.
    const src = `function f(): void {
  const a = "https://example.com/api";
  const b = "http://%s";
  const c = \`http://\${host}\`;
  const d = "wss://example.com/socket";
}`;
    const node = findNodeAt({ source: src, language: 'typescript', line: 1, column: 0 });
    expect(node).not.toBeNull();
    const m = computeMetrics({ bodyNode: node!, language: 'typescript', startLine: 1, endLine: 6 });
    // Should count only `a` and `d` — the two real URLs. `b` (`%s` template)
    // and `c` (`${host}` template) are URL builders, not literal endpoints.
    expect(m.hardcodedUrlCount).toBe(2);
  });

  it('returns base metrics for an unsupported language', () => {
    // No real AST node — pass a stub. The function should bail before
    // touching the node when no LangMap exists.
    const stub = { type: 'fake', childCount: 0, child: () => null } as any;
    const m = computeMetrics({ bodyNode: stub, language: 'unknown' as any, startLine: 1, endLine: 10 });
    expect(m.loc).toBe(10);
    expect(m.cyclomatic).toBe(1);
    expect(m.maxNesting).toBe(0);
  });
});

describe('engine: isMagicNumber', () => {
  it('rejects the kind-overload case (TS `number` type identifier)', () => {
    // Tree-sitter typescript reuses node kind `number` for both numeric
    // literals AND the type identifier `number` (in `count: number`).
    // Without the leading-digit guard the engine flagged every type
    // annotation as a magic literal.
    expect(isMagicNumber('number')).toBe(false);
    expect(isMagicNumber('string')).toBe(false);
    expect(isMagicNumber('boolean')).toBe(false);
  });

  it('keeps allow-listed trivial constants out of the count', () => {
    expect(isMagicNumber('0')).toBe(false);
    expect(isMagicNumber('1')).toBe(false);
    expect(isMagicNumber('-1')).toBe(false);
    expect(isMagicNumber('2')).toBe(false);
    expect(isMagicNumber('0.0')).toBe(false);
    expect(isMagicNumber('1.0')).toBe(false);
  });

  it('flags real magic literals', () => {
    expect(isMagicNumber('42')).toBe(true);
    expect(isMagicNumber('100')).toBe(true);
    expect(isMagicNumber('3.14')).toBe(true);
    expect(isMagicNumber('-7')).toBe(true);
    expect(isMagicNumber('1_000_000')).toBe(true); // underscore separators stripped
  });

  it('flags hex / binary / octal literals unconditionally', () => {
    expect(isMagicNumber('0xff')).toBe(true);
    expect(isMagicNumber('0b1010')).toBe(true);
    expect(isMagicNumber('0o755')).toBe(true);
  });

  it('flags leading-dot floats (regression guard)', () => {
    expect(isMagicNumber('.5')).toBe(true);
    expect(isMagicNumber('-.5')).toBe(true);
  });

  // ollama bug-hunt threshold-tuning: Go time/scaling constants are
  // well-known scale factors, not project-specific values. Without the
  // allow-list, every `humanDuration` / `humanBytes`-style helper trips
  // magic_number at error severity.
  it('Go: allow-lists time/scaling constants (60/24/7/30/365/1000/1024/86400)', () => {
    for (const n of ['60', '24', '7', '30', '365', '1000', '1024', '86400']) {
      expect(isMagicNumber(n, 'go')).toBe(false);
    }
  });

  it('Go allow-list does NOT bleed into other languages', () => {
    // Same numbers in TS / Python should still flag — only Go has the
    // standing convention that these are scale factors.
    expect(isMagicNumber('60', 'typescript')).toBe(true);
    expect(isMagicNumber('1024', 'python')).toBe(true);
  });

  it('Go: numbers OUTSIDE the allow-list still flag', () => {
    expect(isMagicNumber('42', 'go')).toBe(true);
    expect(isMagicNumber('3.14', 'go')).toBe(true);
    expect(isMagicNumber('500', 'go')).toBe(true);
  });
});

// Helper: build a SymbolMetrics with the new fields defaulted so each
// test only needs to specify the field it's exercising. Keeps the
// inline object literals readable as the metric set grows.
function metrics(
  overrides: Partial<{
    loc: number;
    cyclomatic: number;
    maxNesting: number;
    maxConditionalOperands: number;
    paramCount: number;
    magicNumberCount: number;
    hardcodedUrlCount: number;
    accidentalQuadraticCount: number;
    emptyCatchCount: number;
    syncIoInAsyncCount: number;
    forofAwaitCount: number;
    tsAnyCastCount: number;
    tsIgnoreSuppressionCount: number;
    agentDebugLogCount: number;
    incompleteMarkerCount: number;
    dynamicEvalCount: number;
    insecureHashCount: number;
    randomForSecurityCount: number;
    httpNoTimeoutCount: number;
    sqlStringConcatCount: number;
    unsafeJsonParseCount: number;
    envNoValidationCount: number;
    emptyFunctionBodyCount: number;
  }> = {},
) {
  return {
    loc: 20,
    cyclomatic: 3,
    maxNesting: 1,
    maxConditionalOperands: 1,
    paramCount: 0,
    magicNumberCount: 0,
    hardcodedUrlCount: 0,
    accidentalQuadraticCount: 0,
    emptyCatchCount: 0,
    syncIoInAsyncCount: 0,
    forofAwaitCount: 0,
    tsAnyCastCount: 0,
    tsIgnoreSuppressionCount: 0,
    agentDebugLogCount: 0,
    incompleteMarkerCount: 0,
    dynamicEvalCount: 0,
    insecureHashCount: 0,
    randomForSecurityCount: 0,
    httpNoTimeoutCount: 0,
    sqlStringConcatCount: 0,
    unsafeJsonParseCount: 0,
    envNoValidationCount: 0,
    emptyFunctionBodyCount: 0,
    ...overrides,
  };
}

describe('engine: evaluateRules', () => {
  it('emits no findings for healthy metrics', () => {
    const findings = evaluateRules({
      nodeId: 'a',
      language: 'typescript',
      metrics: metrics(),
    });
    expect(findings).toEqual([]);
  });

  it('emits Large Method when loc exceeds threshold', () => {
    const findings = evaluateRules({
      nodeId: 'a',
      language: 'typescript',
      metrics: metrics({ loc: 250 }),
    });
    const lm = findings.find((f) => f.biomarker === 'large_method');
    expect(lm).toBeDefined();
    expect(lm!.severity).toBe('error');
    expect(lm!.metric).toBe(250);
  });

  it('emits Brain Method on a high-composite-score method', () => {
    // 150 LOC, cyc=20, nest=5, cond=3 → score = 1.5 × 2.0 × 1.67 × 1.0 = 5.0
    // → info severity (T_BRAIN.info threshold reached).
    const findings = evaluateRules({
      nodeId: 'a',
      language: 'typescript',
      metrics: metrics({ loc: 150, cyclomatic: 20, maxNesting: 5, maxConditionalOperands: 3 }),
    });
    const brain = findings.find((f) => f.biomarker === 'brain_method');
    expect(brain).toBeDefined();
    expect(brain!.severity).toBeDefined();
    const detail = brain!.detail as { loc: number; cyclomatic: number; maxNesting: number; score: number };
    expect(detail.loc).toBe(150);
    expect(detail.cyclomatic).toBe(20);
    expect(detail.score).toBeGreaterThan(0);
  });

  it('discriminates flat-LOC from nested-LOC at the same size (the new composite headline)', () => {
    // Two 200-LOC methods: a flat dispatch (low cyc/nest/cond) vs a
    // nested-loop monstrosity. Old metric = LOC (both look identical
    // at 200); new composite separates them with very different scores.
    const flat = evaluateRules({
      nodeId: 'flat',
      language: 'typescript',
      // 2.0 × 1.5 × 1.0 × 1.0 = 3.0 → below info gate; should NOT fire
      metrics: metrics({ loc: 200, cyclomatic: 15, maxNesting: 2, maxConditionalOperands: 3 }),
    });
    const monster = evaluateRules({
      nodeId: 'mon',
      language: 'typescript',
      // 2.0 × 2.5 × 1.67 × 2.0 = 16.7 → warning
      metrics: metrics({ loc: 200, cyclomatic: 25, maxNesting: 5, maxConditionalOperands: 8 }),
    });
    expect(flat.find((f) => f.biomarker === 'brain_method')).toBeUndefined();
    const monsterBrain = monster.find((f) => f.biomarker === 'brain_method');
    expect(monsterBrain).toBeDefined();
    expect(['warning', 'error']).toContain(monsterBrain!.severity);
  });

  it('does NOT emit Brain Method below the LOC gate even with high density', () => {
    // 30 LOC but extremely dense (cyc=20, nest=8, cond=10):
    // would score 0.3 × 2.0 × 2.67 × 2.5 = 4.0 (almost passes info)
    // — but LOC gate (50) blocks it regardless. Tiny code is rarely
    // a brain method even when dense; size + complexity is the smell.
    const findings = evaluateRules({
      nodeId: 'a',
      language: 'typescript',
      metrics: metrics({ loc: 30, cyclomatic: 20, maxNesting: 8, maxConditionalOperands: 10 }),
    });
    expect(findings.some((f) => f.biomarker === 'brain_method')).toBe(false);
  });

  it('does NOT emit Brain Method below the cyclomatic gate even at high LOC', () => {
    // 500 LOC but cyclomatic 5 — could be a long config object or
    // sequential comment-heavy code. Length without branchiness isn't
    // brainy; large_method already covers raw size.
    const findings = evaluateRules({
      nodeId: 'a',
      language: 'typescript',
      metrics: metrics({ loc: 500, cyclomatic: 5, maxNesting: 1, maxConditionalOperands: 1 }),
    });
    expect(findings.some((f) => f.biomarker === 'brain_method')).toBe(false);
  });

  it('emits long_parameter_list at warning when paramCount=5', () => {
    const findings = evaluateRules({
      nodeId: 'a',
      language: 'typescript',
      metrics: metrics({ paramCount: 5 }),
    });
    const f = findings.find((x) => x.biomarker === 'long_parameter_list');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('warning');
    expect(f!.metric).toBe(5);
  });

  it('does NOT emit long_parameter_list when paramCount=3', () => {
    const findings = evaluateRules({
      nodeId: 'a',
      language: 'typescript',
      metrics: metrics({ paramCount: 3 }),
    });
    expect(findings.some((f) => f.biomarker === 'long_parameter_list')).toBe(false);
  });

  it('emits magic_number at error when count is 8', () => {
    const findings = evaluateRules({
      nodeId: 'a',
      language: 'typescript',
      metrics: metrics({ magicNumberCount: 8 }),
    });
    const f = findings.find((x) => x.biomarker === 'magic_number');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('error');
    expect(f!.metric).toBe(8);
  });

  it('does NOT emit magic_number below threshold (count=2)', () => {
    const findings = evaluateRules({
      nodeId: 'a',
      language: 'typescript',
      metrics: metrics({ magicNumberCount: 2 }),
    });
    expect(findings.some((f) => f.biomarker === 'magic_number')).toBe(false);
  });

  it('emits hardcoded_url at info on first occurrence, warning at 2, error at 3', () => {
    const one = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics({ hardcodedUrlCount: 1 }) });
    expect(one.find((f) => f.biomarker === 'hardcoded_url')!.severity).toBe('info');

    const two = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics({ hardcodedUrlCount: 2 }) });
    expect(two.find((f) => f.biomarker === 'hardcoded_url')!.severity).toBe('warning');

    const three = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics({ hardcodedUrlCount: 3 }) });
    expect(three.find((f) => f.biomarker === 'hardcoded_url')!.severity).toBe('error');
  });

  it('does NOT emit hardcoded_url when count is 0', () => {
    const findings = evaluateRules({
      nodeId: 'a',
      language: 'typescript',
      metrics: metrics({ hardcodedUrlCount: 0 }),
    });
    expect(findings.some((f) => f.biomarker === 'hardcoded_url')).toBe(false);
  });

  // B17 (2026-05-23) — accidental_quadratic SIMPLE_RULES wiring.
  // Pins the threshold contract: warning fires on the FIRST occurrence
  // (Schlemiel patterns are real perf bugs; surface them immediately so
  // they don't get reintroduced silently), escalates to error only when
  // 5+ pile up in one symbol.
  it('emits accidental_quadratic at warning on the first occurrence, error at 5', () => {
    const one = evaluateRules({
      nodeId: 'a',
      language: 'typescript',
      metrics: metrics({ accidentalQuadraticCount: 1 }),
    });
    expect(one.find((f) => f.biomarker === 'accidental_quadratic')!.severity).toBe('warning');

    const four = evaluateRules({
      nodeId: 'a',
      language: 'typescript',
      metrics: metrics({ accidentalQuadraticCount: 4 }),
    });
    expect(four.find((f) => f.biomarker === 'accidental_quadratic')!.severity).toBe('warning');

    const five = evaluateRules({
      nodeId: 'a',
      language: 'typescript',
      metrics: metrics({ accidentalQuadraticCount: 5 }),
    });
    expect(five.find((f) => f.biomarker === 'accidental_quadratic')!.severity).toBe('error');
  });

  it('does NOT emit accidental_quadratic when count is 0', () => {
    const findings = evaluateRules({
      nodeId: 'a',
      language: 'typescript',
      metrics: metrics({ accidentalQuadraticCount: 0 }),
    });
    expect(findings.some((f) => f.biomarker === 'accidental_quadratic')).toBe(false);
  });
});

describe('codeHealthScore', () => {
  it('returns 10 for no findings', () => {
    expect(codeHealthScore([])).toBe(10);
  });

  it('drops by 2 per error', () => {
    expect(codeHealthScore([{ severity: 'error' }])).toBe(8);
    expect(codeHealthScore([{ severity: 'error' }, { severity: 'error' }])).toBe(6);
  });

  it('drops by 1 per warning, 0.5 per info', () => {
    expect(codeHealthScore([{ severity: 'warning' }])).toBe(9);
    expect(codeHealthScore([{ severity: 'info' }])).toBe(9.5);
  });

  it('floors at 1', () => {
    const many = new Array(20).fill({ severity: 'error' as const });
    expect(codeHealthScore(many)).toBe(1);
  });
});

describe('end-to-end through Cartograph', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => cleanup(dir));

  it('runs the biomarker hook on indexAll and persists findings', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    // Deliberately gnarly: long, deeply nested, branchy.
    const gnarly = [
      'export function bigUgly(x: number, y: number): number {',
      '  let result = 0;',
      ...Array.from({ length: 80 }, (_, i) => `  if (x === ${i} && y === ${i}) result += ${i};`),
      '  if (x > 0) {',
      '    if (y > 0) {',
      '      for (let i = 0; i < 10; i++) {',
      '        if (i % 2 === 0) {',
      '          while (i < 5) {',
      '            if (result === 42) {',
      '              return i;',
      '            }',
      '            break;',
      '          }',
      '        }',
      '      }',
      '    }',
      '  }',
      '  return result;',
      '}',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'src', 'gnarly.ts'), gnarly);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'biomarker-e2e', version: '0.0.0' }));

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      const idx = await cg.indexAll({ summarize: false });
      expect(idx.success).toBe(true);

      const stats = getFindingsStats(cg.queries);
      expect(stats.totalFindings).toBeGreaterThan(0);
      expect(stats.nodesWithFindings).toBeGreaterThan(0);

      const ranked = getFindingsRanked(cg.queries, { minSeverity: 'warning', limit: 50 });
      expect(ranked.length).toBeGreaterThan(0);

      const onBigUgly = ranked.filter((r) => r.name === 'bigUgly');
      expect(onBigUgly.length).toBeGreaterThan(0);
      // Should hit at least one of: large_method, complex_method, brain_method.
      const expectedBiomarkers = new Set(['large_method', 'complex_method', 'brain_method']);
      expect(onBigUgly.some((f) => expectedBiomarkers.has(f.biomarker))).toBe(true);

      // minMetric / maxMetric filter coverage — the bigUgly function
      // hits multiple biomarkers with different metric values. Slicing
      // by metric returns only findings inside the band; outside the
      // band returns empty.
      const allInfo = getFindingsRanked(cg.queries, { minSeverity: 'info', limit: 100 });
      expect(allInfo.length).toBeGreaterThan(0);
      const minMetric = Math.min(...allInfo.map((r) => r.metric));
      const maxMetric = Math.max(...allInfo.map((r) => r.metric));
      // minMetric floor at the highest metric — only findings at-or-above the max survive.
      const aboveMax = getFindingsRanked(cg.queries, {
        minSeverity: 'info',
        minMetric: maxMetric,
        limit: 100,
      });
      expect(aboveMax.every((r) => r.metric >= maxMetric)).toBe(true);
      // maxMetric just below the highest — that finding gets clipped.
      const belowMax = getFindingsRanked(cg.queries, {
        minSeverity: 'info',
        maxMetric: maxMetric - 1,
        limit: 100,
      });
      expect(belowMax.every((r) => r.metric <= maxMetric - 1)).toBe(true);
      // Banded — only findings inside the inclusive [min, max] band.
      if (maxMetric > minMetric) {
        const banded = getFindingsRanked(cg.queries, {
          minSeverity: 'info',
          minMetric: minMetric,
          maxMetric: maxMetric,
          limit: 100,
        });
        expect(banded.every((r) => r.metric >= minMetric && r.metric <= maxMetric)).toBe(true);
      }

      // format: 'json' (field report #2 items 10/11) — machine-readable
      // rows including the detail payload + the honesty counts, so
      // agents stop parsing markdown tables or the DB schema. Runs
      // BEFORE the orphan exercise below (which destroys the fixture
      // node and with it the joined ranked rows).
      // NOTE: no handler.closeAll() — it tears down the SHARED cg
      // (watcher + caches), poisoning the direct-query assertions
      // below; the test's own cg.close() finally is the cleanup.
      const handler = new ToolHandler(cg, { profile: 'full' });
      {
        const rankedJson = await handler.execute('cartograph_biomarkers', {
          mode: 'ranked',
          format: 'json',
          minSeverity: 'info',
          limit: 50,
        });
        const rankedPayload = JSON.parse(rankedJson.content[0]?.text ?? '') as {
          mode: string;
          shown: number;
          total: number;
          orphaned: number;
          findings: Array<{ biomarker: string; detail: unknown }>;
        };
        expect(rankedPayload.mode).toBe('ranked');
        expect(rankedPayload.findings.length).toBe(rankedPayload.shown);
        expect(rankedPayload.total).toBeGreaterThanOrEqual(rankedPayload.shown);
        expect(rankedPayload.orphaned).toBe(0);
        expect(rankedPayload.findings.length).toBeGreaterThan(0);
        expect(Object.keys(rankedPayload.findings[0]!)).toContain('detail');

        // Zero rows must STAY JSON (reviewer catch): an impossible
        // filter combination returns the same shape with shown 0 and
        // a hint, never the markdown empty-state prose.
        const emptyJson = await handler.execute('cartograph_biomarkers', {
          mode: 'ranked',
          format: 'json',
          biomarker: 'magic_number',
          minSeverity: 'error',
          minMetric: 999_999,
        });
        const emptyPayload = JSON.parse(emptyJson.content[0]?.text ?? '') as {
          mode: string;
          shown: number;
          hint?: string;
          findings: unknown[];
        };
        expect(emptyPayload.mode).toBe('ranked');
        expect(emptyPayload.shown).toBe(0);
        expect(emptyPayload.findings).toEqual([]);
        expect(typeof emptyPayload.hint).toBe('string');

        const statsJson = await handler.execute('cartograph_biomarkers', { mode: 'stats', format: 'json' });
        const statsPayload = JSON.parse(statsJson.content[0]?.text ?? '') as {
          mode: string;
          totalFindings: number;
          byBiomarker: Record<string, number>;
        };
        expect(statsPayload.mode).toBe('stats');
        expect(statsPayload.totalFindings).toBeGreaterThan(0);
        expect(Object.keys(statsPayload.byBiomarker).length).toBeGreaterThan(0);
      }

      // Honesty counter: agrees with ranked when nothing is orphaned,
      // and counts findings whose node id no longer resolves (ranked's
      // INNER JOIN hides them; stats counts them — the field-report
      // "105 of 133" mismatch). Orphans arise in the wild when a node
      // row is removed through a connection without `PRAGMA
      // foreign_keys` (raw worker connections) — the CASCADE never
      // fires. Reproduce exactly that, LAST: it destroys the fixture.
      const before = countFindingsRanked(cg.queries, { minSeverity: 'warning' });
      expect(before.total).toBeGreaterThanOrEqual(ranked.length);
      expect(before.orphaned).toBe(0);
      const victim = ranked[0]!.nodeId;
      const { Database } = await import('bun:sqlite');
      const raw = new Database(path.join(dir, '.cartograph', 'cartograph.db'));
      try {
        // bun:sqlite defaults foreign_keys OFF — the delete strands
        // the victim's findings rather than cascading them.
        raw.run('DELETE FROM nodes WHERE id = ?', [victim]);
      } finally {
        raw.close();
      }
      const after = countFindingsRanked(cg.queries, { minSeverity: 'warning' });
      expect(after.total).toBe(before.total);
      expect(after.orphaned).toBeGreaterThan(0);
      const rankedOrphaned = getFindingsRanked(cg.queries, { minSeverity: 'warning', limit: 200 });
      expect(rankedOrphaned.some((r) => r.nodeId === victim)).toBe(false);
      expect(after.total - rankedOrphaned.length).toBeGreaterThanOrEqual(after.orphaned);
    } finally {
      cg.close();
    }
  });

  it('skips diagnostic paths (scripts/) so a gnarly script produces zero findings', async () => {
    // Same gnarly body as the previous test — proves that the
    // shape itself triggers warnings when placed under src/, but
    // the diagnostic-path skip drops it to zero when placed under
    // scripts/. This pins the policy: diagnostic / one-off code
    // is held to a different bar than production code.
    fs.mkdirSync(path.join(dir, 'scripts'));
    const gnarly = [
      'export function bigUgly(x: number, y: number): number {',
      '  let result = 0;',
      ...Array.from({ length: 80 }, (_, i) => `  if (x === ${i} && y === ${i}) result += ${i};`),
      '  if (x > 0) {',
      '    if (y > 0) {',
      '      for (let i = 0; i < 10; i++) {',
      '        if (i % 2 === 0) {',
      '          while (i < 5) {',
      '            if (result === 42) return i;',
      '            break;',
      '          }',
      '        }',
      '      }',
      '    }',
      '  }',
      '  return result;',
      '}',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'scripts', 'gnarly-bench.ts'), gnarly);
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'biomarker-diagnostic-skip', version: '0.0.0' }),
    );

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      const idx = await cg.indexAll({ summarize: false });
      expect(idx.success).toBe(true);

      const ranked = getFindingsRanked(cg.queries, { minSeverity: 'info', limit: 50 });
      const onScriptFile = ranked.filter((r) => r.filePath === 'scripts/gnarly-bench.ts');
      expect(onScriptFile).toEqual([]);
    } finally {
      cg.close();
    }
  });

  it('clean code produces no findings', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    // Non-exported helpers in a single file — the test asserts that
    // per-symbol complexity rules don't fire on simple code. Avoiding
    // `export` keeps the cross-file `unused_export` rule out of scope
    // (which is exercised by its own test).
    fs.writeFileSync(
      path.join(dir, 'src', 'clean.ts'),
      `function add(a: number, b: number): number {
  return a + b;
}

function double(n: number): number {
  return n * 2;
}

function compute(): number { return add(double(1), 2); }
compute();
`,
    );
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'biomarker-clean', version: '0.0.0' }));

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      const stats = getFindingsStats(cg.queries);
      expect(stats.totalFindings).toBe(0);
    } finally {
      cg.close();
    }
  });

  it('clears stale findings when a function is refactored clean', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    const filePath = path.join(dir, 'src', 'fixme.ts');
    // Non-exported so the cross-file unused_export rule can't fire and
    // mask the per-file replace behaviour we're testing here.
    const branchLines = Array.from({ length: 250 }, (_, i) => `  if (x === ${i}) return ${i};`).join('\n');
    fs.writeFileSync(filePath, `function ugly(x: number): number {\n${branchLines}\n  return -1;\n}\nugly(0);\n`);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'biomarker-stale', version: '0.0.0' }));

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      const before = getFindingsStats(cg.queries);
      expect(before.totalFindings).toBeGreaterThan(0);

      // Refactor the function to be clean. Re-sync.
      fs.writeFileSync(filePath, `function ugly(x: number): number {\n  return x;\n}\nugly(0);\n`);
      await cg.sync({ summarize: false });

      const after = getFindingsStats(cg.queries);
      // The previously-flagged function is now clean: zero findings on
      // its node. (Other nodes in the same file would also have been
      // re-evaluated.)
      expect(after.totalFindings).toBeLessThanOrEqual(before.totalFindings);
      const ranked = getFindingsRanked(cg.queries, { minSeverity: 'info', limit: 100 });
      expect(ranked.find((r) => r.name === 'ugly')).toBeUndefined();
    } finally {
      cg.close();
    }
  });

  it('does not inflate conditional operand count from inner callbacks', async () => {
    // The outer `if`'s condition is a single call expression. Without
    // the FUNCTION_CONTAINER_KINDS guard in countConditionalOperands,
    // the `&&` and operands inside the lambda would inflate the count.
    const src = `function f(arr: Array<{a: number; b: number}>): boolean {
  if (arr.find(x => x.a > 0 && x.b > 0 && x.a !== x.b)) {
    return true;
  }
  return false;
}`;
    const node = findNodeAt({ source: src, language: 'typescript', line: 1, column: 0 });
    expect(node).not.toBeNull();
    const m = computeMetrics({ bodyNode: node!, language: 'typescript', startLine: 1, endLine: 6 });
    // The OUTER conditional has roughly 1-2 operands (arr.find call).
    // Inner lambda has 5+. We want the outer count, not the inner.
    expect(m.maxConditionalOperands).toBeLessThan(5);
  });

  it('respects enableBiomarkers: false', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    const gnarly = Array.from({ length: 250 }, (_, i) => `  if (x === ${i}) return ${i};`);
    fs.writeFileSync(
      path.join(dir, 'src', 'gnarly.ts'),
      `export function ugly(x: number): number {\n${gnarly.join('\n')}\n  return -1;\n}`,
    );
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'biomarker-disabled', version: '0.0.0' }));

    const cg = await Cartograph.init(dir, {
      config: { llm: { endpoint: '' }, enableBiomarkers: false },
    });
    try {
      await cg.indexAll({ summarize: false });
      const stats = getFindingsStats(cg.queries);
      expect(stats.totalFindings).toBe(0);
    } finally {
      cg.close();
    }
  });

  it('emits god_class for a class with many members', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    // 16 trivial methods → exceeds the info threshold (15) but not the
    // warning threshold (25). Each method body is short to keep
    // per-symbol rules out of the way.
    const methods = Array.from({ length: 16 }, (_, i) => `  m${i}() { return ${i}; }`).join('\n');
    fs.writeFileSync(path.join(dir, 'src', 'god.ts'), `export class GodClass {\n${methods}\n}\n`);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'biomarker-god', version: '0.0.0' }));

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      // Pull findings for any node named 'GodClass'.
      const all = getNodesByKind(cg.queries, 'class').filter((n) => n.name === 'GodClass');
      expect(all.length).toBe(1);
      const findings = getFindingsForNode(cg.queries, all[0]!.id);
      const god = findings.find((f) => f.biomarker === 'god_class');
      expect(god).toBeDefined();
      expect(god!.metric).toBe(16);
    } finally {
      cg.close();
    }
  });

  it('emits feature_envy when a method reads many foreign fields with low locality (ATFD/LAA)', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    // Foreign data provider: a class with many fields the envious
    // method will reach into.
    fs.writeFileSync(
      path.join(dir, 'src', 'order.ts'),
      `export class Order {
  total: number = 0;
  discount: number = 0;
  tax: number = 0;
  shipping: number = 0;
  itemCount: number = 0;
  currency: string = 'USD';
}
`,
    );
    // Customer.envious reads 6 distinct foreign fields off Order and
    // 0 own fields → ATFD=6 (>5), FDP=1 (≤2), LAA=0 (<1/3) → fires.
    fs.writeFileSync(
      path.join(dir, 'src', 'customer.ts'),
      `import { Order } from './order.js';
export class Customer {
  name: string = '';
  email: string = '';
  envious(order: Order): number {
    return order.total + order.discount + order.tax +
           order.shipping + order.itemCount + order.currency.length;
  }
}
`,
    );
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'biomarker-envy', version: '0.0.0' }));

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      const envious = getNodesByKind(cg.queries, 'method').find((n) => n.name === 'envious');
      expect(envious).toBeDefined();
      const findings = getFindingsForNode(cg.queries, envious!.id);
      const fe = findings.find((f) => f.biomarker === 'feature_envy');
      expect(fe).toBeDefined();
      // ATFD = 6 distinct foreign fields.
      expect(fe!.metric).toBeGreaterThanOrEqual(6);
      const detail = fe!.detail as {
        atfd: number;
        fdp: number;
        laa: number;
        foreignAccesses: number;
        ownAccesses: number;
      };
      expect(detail.fdp).toBe(1); // all foreign accesses on one provider
      expect(detail.laa).toBeLessThan(1 / 3); // own/total below threshold
      expect(detail.ownAccesses).toBe(0);
      expect(detail.foreignAccesses).toBeGreaterThanOrEqual(6);
    } finally {
      cg.close();
    }
  });

  it('does NOT emit feature_envy when locality favours own class (high LAA)', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'order.ts'),
      `export class Order {
  tax: number = 0;
}
`,
    );
    // Cart.total reads its own fields heavily and reaches Order once
    // → ATFD=1 (≤5) AND LAA = 5/6 > 1/3 → does NOT fire.
    fs.writeFileSync(
      path.join(dir, 'src', 'cart.ts'),
      `import { Order } from './order.js';
export class Cart {
  items: number = 0;
  subtotal: number = 0;
  fees: number = 0;
  total(order: Order): number {
    return this.items + this.subtotal + this.fees +
           this.items + this.subtotal + order.tax;
  }
}
`,
    );
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'biomarker-envy-healthy', version: '0.0.0' }),
    );

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      const total = getNodesByKind(cg.queries, 'method').find((n) => n.name === 'total');
      expect(total).toBeDefined();
      const findings = getFindingsForNode(cg.queries, total!.id);
      expect(findings.some((f) => f.biomarker === 'feature_envy')).toBe(false);
    } finally {
      cg.close();
    }
  });

  it('does NOT emit feature_envy when foreign access is diffuse (FDP > 2)', async () => {
    // ATFD high but spread across 3 distinct provider classes, each
    // accessed twice. Per L/M, that's not envy — the method is
    // coordinating across multiple data sources, not pining for a
    // single class. FDP > maxFDP (2) suppresses the finding.
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'providers.ts'),
      `export class A { x: number = 0; y: number = 0; }
export class B { x: number = 0; y: number = 0; }
export class C { x: number = 0; y: number = 0; }
`,
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'orchestrator.ts'),
      `import { A, B, C } from './providers.js';
export class Orchestrator {
  coordinate(a: A, b: B, c: C): number {
    return a.x + a.y + b.x + b.y + c.x + c.y;
  }
}
`,
    );
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'biomarker-envy-diffuse', version: '0.0.0' }),
    );

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      const coordinate = getNodesByKind(cg.queries, 'method').find((n) => n.name === 'coordinate');
      expect(coordinate).toBeDefined();
      const findings = getFindingsForNode(cg.queries, coordinate!.id);
      expect(findings.some((f) => f.biomarker === 'feature_envy')).toBe(false);
    } finally {
      cg.close();
    }
  });

  it('does NOT emit feature_envy on a free function (no enclosing class)', async () => {
    // Free functions have no "own class" — LAA is undefined; the OO
    // smell doesn't apply. Important regression guard: the prior
    // call-edge metric DID fire on free functions, leading to many
    // false positives on cross-domain orchestrators. The new metric
    // explicitly skips them.
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'order.ts'),
      `export class Order {
  total: number = 0;
  discount: number = 0;
  tax: number = 0;
  shipping: number = 0;
  itemCount: number = 0;
  currency: string = 'USD';
}
`,
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'free.ts'),
      `import { Order } from './order.js';
export function aggregate(order: Order): number {
  return order.total + order.discount + order.tax +
         order.shipping + order.itemCount + order.currency.length;
}
`,
    );
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'biomarker-envy-free', version: '0.0.0' }));

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      const agg = getNodesByKind(cg.queries, 'function').find((n) => n.name === 'aggregate');
      expect(agg).toBeDefined();
      const findings = getFindingsForNode(cg.queries, agg!.id);
      expect(findings.some((f) => f.biomarker === 'feature_envy')).toBe(false);
    } finally {
      cg.close();
    }
  });

  it('does NOT recompute cross-file findings on partial sync (G1: prevents false-positive storm)', async () => {
    // Guard for G1: cross-file biomarkers (unused_export / god_class /
    // feature_envy) now ONLY run on a full project pass. A partial sync
    // (one or a few files changed) does NOT recompute them because a
    // partial rescan only has a subset of the ref-edge graph — running
    // unused_export against a 1-file view produced 717 false positives
    // in the original bug report (every exported symbol looked unused).
    // The last full-pass result is preserved instead.
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'lib.ts'), `export function unusedAfterEdit() { return 42; }\n`);
    fs.writeFileSync(
      path.join(dir, 'src', 'consumer.ts'),
      `import { unusedAfterEdit } from './lib.js';\nexport function callIt() { return unusedAfterEdit(); }\n`,
    );
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'biomarker-partial-sync', version: '0.0.0' }),
    );

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      const before = getFindingsRanked(cg.queries, {
        biomarker: 'unused_export',
        minSeverity: 'info',
        limit: 100,
      });
      expect(before.find((r) => r.name === 'unusedAfterEdit')).toBeUndefined();

      // Drop the consumer's reference and do a partial sync.
      // The cross-file pass is suppressed on partial sync, so the
      // prior full-pass result (no unused_export) is preserved.
      fs.writeFileSync(path.join(dir, 'src', 'consumer.ts'), `export function callIt() { return 0; }\n`);
      await cg.sync({ summarize: false });

      const afterPartialSync = getFindingsRanked(cg.queries, {
        biomarker: 'unused_export',
        minSeverity: 'info',
        limit: 100,
      });
      // Should still NOT appear — cross-file rules don't run on partial sync.
      expect(afterPartialSync.find((r) => r.name === 'unusedAfterEdit')).toBeUndefined();

      // After a full pass the real state is reflected.
      await cg.indexAll({ summarize: false });
      const afterFullPass = getFindingsRanked(cg.queries, {
        biomarker: 'unused_export',
        minSeverity: 'info',
        limit: 100,
      });
      expect(afterFullPass.find((r) => r.name === 'unusedAfterEdit')).toBeDefined();
    } finally {
      cg.close();
    }
  });

  it('does not flag workspace package exports consumed through package subpath imports', async () => {
    fs.mkdirSync(path.join(dir, 'packages/shared/src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'apps/client/src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'workspace-unused-export', workspaces: ['apps/*', 'packages/*'] }),
    );
    fs.writeFileSync(
      path.join(dir, 'packages/shared/package.json'),
      JSON.stringify({
        name: '@workspace/shared',
        exports: {
          './schema': './src/schema.ts',
        },
      }),
    );
    fs.writeFileSync(
      path.join(dir, 'packages/shared/src/schema.ts'),
      `export const UsedSchema = { parse(value: unknown): unknown { return value; } };\n`,
    );
    fs.writeFileSync(
      path.join(dir, 'apps/client/src/main.ts'),
      `import { UsedSchema } from '@workspace/shared/schema';\nexport const parsed = UsedSchema.parse('ok');\n`,
    );

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      const findings = getFindingsRanked(cg.queries, {
        biomarker: 'unused_export',
        minSeverity: 'info',
        limit: 100,
      });
      expect(findings.find((r) => r.name === 'UsedSchema')).toBeUndefined();
    } finally {
      cg.close();
    }
  });

  it('does not flag local handlers inside exported TSX components as unused exports', async () => {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src/component.tsx'),
      `export const SearchBox = () => {\n` +
        `  const onKeyDown = (event: { key: string }): void => {\n` +
        `    if (event.key === 'Enter') console.log('search');\n` +
        `  };\n` +
        `  return <input onKeyDown={onKeyDown} />;\n` +
        `};\n`,
    );

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      const findings = getFindingsRanked(cg.queries, {
        biomarker: 'unused_export',
        minSeverity: 'info',
        limit: 100,
      });
      expect(findings.find((r) => r.name === 'onKeyDown')).toBeUndefined();
    } finally {
      cg.close();
    }
  });

  it('does not merge module header comments into a constant docstring across a blank line', async () => {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src/config.ts'),
      `// Module header mentions phase 2 and 33 preferences.\n` +
        `// Those numbers describe the file, not the constant below.\n` +
        `\n` +
        `// DEBOUNCE_MS batches writes before persistence.\n` +
        `export const DEBOUNCE_MS = 400;\n`,
    );

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      const findings = getFindingsRanked(cg.queries, {
        biomarker: 'stale_doc',
        minSeverity: 'info',
        limit: 100,
      });
      expect(findings.find((r) => r.name === 'DEBOUNCE_MS')).toBeUndefined();
    } finally {
      cg.close();
    }
  });

  it('annotates findings with surfaceReason — full-pass after indexAll, stats+ranked agree (G3 fix)', async () => {
    // Pin migration 061 + the G3 fix: after a full pass, both mode=stats
    // and mode=ranked should report consistent surface-reason labels.
    // Before the fix: stats showed full-pass: N for cross-file findings
    // but ranked showed cached for per-file findings (whose content-hash
    // was unchanged), even though both sets were validated by the same
    // full-project scan. After the fix, all rows are promoted to
    // 'full-pass' at the end of a full pass.
    //
    // G1 pin: cross-file rules do NOT run on a partial sync. After a
    // partial sync the per-file findings for the changed file may flip to
    // 'partial-rescan', but cross-file findings stay at their last
    // full-pass value — they are NOT re-emitted as 'partial-rescan'.
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'lib.ts'), `export function latentExport() { return 7; }\n`);
    fs.writeFileSync(
      path.join(dir, 'src', 'consumer.ts'),
      `import { latentExport } from './lib.js';\nexport function callIt() { return latentExport(); }\n`,
    );
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'biomarker-surface-reason', version: '0.0.0' }),
    );

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      // After a full pass: every emitted row should be 'full-pass' (G3 fix:
      // content-hash-cached rows are promoted from 'cached' to 'full-pass').
      const afterFullPass = getFindingsRanked(cg.queries, {
        minSeverity: 'info',
        limit: 200,
      });
      expect(afterFullPass.length).toBeGreaterThan(0);
      expect(afterFullPass.every((r) => r.surfaceReason === 'full-pass')).toBe(true);

      // stats and ranked agree: no 'cached' rows after a full pass.
      const fullPassStats = getFindingsStats(cg.queries);
      expect(fullPassStats.bySurfaceReason['full-pass']).toBe(fullPassStats.totalFindings);
      expect(fullPassStats.bySurfaceReason['partial-rescan']).toBe(0);
      expect(fullPassStats.bySurfaceReason['cached']).toBe(0);

      // Partial sync: only per-file rules run for changed files.
      // Cross-file findings are NOT re-emitted (G1 fix).
      fs.writeFileSync(path.join(dir, 'src', 'consumer.ts'), `export function callIt() { return 0; }\n`);
      await cg.sync({ summarize: false });

      // latentExport is still NOT a unused_export finding after partial sync —
      // cross-file rules didn't run.
      const unusedAfterSync = getFindingsRanked(cg.queries, {
        biomarker: 'unused_export',
        minSeverity: 'info',
        limit: 100,
      }).find((r) => r.name === 'latentExport');
      expect(unusedAfterSync).toBeUndefined();

      // After another full pass the real state is reflected.
      await cg.indexAll({ summarize: false });
      const unusedRow = getFindingsRanked(cg.queries, {
        biomarker: 'unused_export',
        minSeverity: 'info',
        limit: 100,
      }).find((r) => r.name === 'latentExport');
      expect(unusedRow).toBeDefined();
      expect(unusedRow!.surfaceReason).toBe('full-pass');
    } finally {
      cg.close();
    }
  });

  it('respects excludeFile to drop findings under a path prefix', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    const gnarly = (name: string): string =>
      [
        `export function ${name}(x: number): number {`,
        '  let result = 0;',
        ...Array.from({ length: 80 }, (_, i) => `  if (x === ${i}) result += ${i};`),
        '  return result;',
        '}',
      ].join('\n');
    fs.mkdirSync(path.join(dir, 'src', 'keep'));
    fs.mkdirSync(path.join(dir, 'src', 'legacy'));
    fs.writeFileSync(path.join(dir, 'src', 'keep', 'one.ts'), gnarly('keepOne'));
    fs.writeFileSync(path.join(dir, 'src', 'legacy', 'two.ts'), gnarly('legacyTwo'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'biomarker-exclude', version: '0.0.0' }));

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });

      const baseline = getFindingsRanked(cg.queries, { minSeverity: 'info', limit: 100 });
      expect(baseline.some((r) => r.name === 'keepOne')).toBe(true);
      expect(baseline.some((r) => r.name === 'legacyTwo')).toBe(true);

      // Directory exclusion via trailing-slash prefix.
      const filtered = getFindingsRanked(cg.queries, {
        minSeverity: 'info',
        limit: 100,
        excludeFile: 'src/legacy/',
      });
      expect(filtered.some((r) => r.name === 'keepOne')).toBe(true);
      expect(filtered.some((r) => r.name === 'legacyTwo')).toBe(false);

      // Single-file exclusion.
      const filteredOne = getFindingsRanked(cg.queries, {
        minSeverity: 'info',
        limit: 100,
        excludeFile: 'src/keep/one.ts',
      });
      expect(filteredOne.some((r) => r.name === 'keepOne')).toBe(false);
      expect(filteredOne.some((r) => r.name === 'legacyTwo')).toBe(true);

      // GLOB-metachar inputs are treated literally — `*` doesn't
      // collapse to "match everything" the way it would under GLOB.
      // No path starts with `*`, so the result equals the unfiltered
      // baseline (i.e. both functions still surface).
      const starInput = getFindingsRanked(cg.queries, {
        minSeverity: 'info',
        limit: 100,
        excludeFile: '*',
      });
      expect(starInput.some((r) => r.name === 'keepOne')).toBe(true);
      expect(starInput.some((r) => r.name === 'legacyTwo')).toBe(true);

      // LIKE-metachar inputs are escaped — `_` matches itself, not
      // "any single character". A literal underscore-bearing prefix
      // that doesn't actually exist in the index leaves the result
      // unchanged from the baseline.
      const underscoreInput = getFindingsRanked(cg.queries, {
        minSeverity: 'info',
        limit: 100,
        excludeFile: 'src/k_ep/',
      });
      expect(underscoreInput.some((r) => r.name === 'keepOne')).toBe(true);
    } finally {
      cg.close();
    }
  });

  // Friction F-C: error-severity findings must surface even when their
  // host node's centrality is below `minCentrality`. The "killer"
  // pre-refactor query (minSeverity='warning', minCentrality=0.001)
  // previously dropped error rows whose centrality sat below the floor
  // — common for MCP-tool dispatchers whose binding-table emits
  // `references` edges instead of `calls`, leaving their structural
  // reach near-zero. An error is by definition worth surfacing.
  it('surfaces error-severity findings even when centrality is below minCentrality (F-C)', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    // A small helper that won't independently trip a biomarker so the
    // synthetic error finding we attach below is the only error row.
    fs.writeFileSync(
      path.join(dir, 'src', 'lib.ts'),
      `export function lowReachHelper(x: number): number { return x + 1; }\n`,
    );
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'biomarker-f-c', version: '0.0.0' }));

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });

      // Find the helper and clamp its centrality to a value well below
      // the killer-query threshold. The post-index hook may leave it
      // at NULL or some computed value; pin it explicitly so the test
      // doesn't depend on centrality propagation.
      const rawDb = (
        cg as unknown as {
          queries: {
            db: {
              prepare: (sql: string) => {
                get: (params?: unknown) => unknown;
                all: () => unknown[];
                run: (params?: unknown) => unknown;
              };
            };
          };
        }
      ).queries.db;
      const nodeRow = rawDb
        .prepare("SELECT id FROM nodes WHERE name = 'lowReachHelper' AND kind = 'function' LIMIT 1")
        .get() as { id: string } | undefined;
      expect(nodeRow).toBeDefined();
      rawDb.prepare('UPDATE nodes SET centrality = 0.0001 WHERE id = @id').run({ id: nodeRow!.id });

      // Attach a synthetic error-severity finding to that low-centrality
      // node. Mirrors the real-world shape (e.g. `complex_conditional`
      // metric=10) without depending on the engine to trip an error
      // tier from source — keeps the test focused on the surfacing
      // semantics.
      appendFindings(cg.queries, [
        { nodeId: nodeRow!.id, biomarker: 'complex_conditional', severity: 'error', metric: 10 },
      ]);

      // The killer pre-refactor query — must surface the error row even
      // though centrality (0.0001) is below the floor (0.001).
      const ranked = getFindingsRanked(cg.queries, {
        minSeverity: 'warning',
        minCentrality: 0.001,
        limit: 30,
      });
      const errorRow = ranked.find((r) => r.name === 'lowReachHelper' && r.severity === 'error');
      expect(errorRow).toBeDefined();
      expect(errorRow!.biomarker).toBe('complex_conditional');

      // Warnings on low-centrality nodes still get filtered out — the
      // bypass is severity-specific. Insert a warning finding on the
      // same low-centrality node and confirm it's excluded.
      appendFindings(cg.queries, [
        { nodeId: nodeRow!.id, biomarker: 'large_method', severity: 'warning', metric: 100 },
      ]);
      const ranked2 = getFindingsRanked(cg.queries, {
        minSeverity: 'warning',
        minCentrality: 0.001,
        limit: 30,
      });
      const warningRow = ranked2.find((r) => r.name === 'lowReachHelper' && r.severity === 'warning');
      expect(warningRow).toBeUndefined();
      // Error row is still surfaced.
      expect(ranked2.some((r) => r.name === 'lowReachHelper' && r.severity === 'error')).toBe(true);
    } finally {
      cg.close();
    }
  });
});

/**
 * F-D: when the agent passes a `minCentrality` filter that excludes
 * every finding, the empty-result hint should point at the lowest
 * observed centrality value so they can drop the filter to exactly
 * the cutoff that surfaces those findings — not misdirect toward
 * "re-run index" which is the much rarer "centrality genuinely NULL"
 * case.
 */
describe('cartograph_biomarkers: F-D — minCentrality empty hint', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-biomarkers-fd-'));
    fs.mkdirSync(path.join(dir, 'src'));
    // A function deliberately tuned to trip ONLY warning-tier findings
    // (large_method warning at 100 LOC, well below the 200-LOC error
    // floor; cyclomatic in the warning band but below the 25-cyclomatic
    // error floor; comparisons to allow-listed constants so magic_number
    // doesn't fire). This shape keeps the F-D empty-hint behaviour
    // testable now that error rows bypass `minCentrality` (F-C).
    const lines: string[] = [`export function gnarlyOne(x: number): number {`, '  let result = 0;'];
    // 20 if-branches against allow-listed constants → cyclomatic ~21
    // (warning tier, below 25 = error). All comparison values are
    // `0` or `1` — both in the magic_number allow-list.
    for (let i = 0; i < 20; i++) {
      lines.push('  if (x === 0) result += 1;');
    }
    // Pad to >= 100 LOC so large_method (warning at 100) fires.
    for (let i = 0; i < 90; i++) {
      lines.push('  result += result;');
    }
    lines.push('  return result;', '}');
    fs.writeFileSync(path.join(dir, 'src', 'gnarly.ts'), lines.join('\n'));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'biomarker-empty-hint', version: '0.0.0' }),
    );
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('points at the lowest observed centrality when minCentrality filters out every row', async () => {
    // Findings WITH centrality exist; we set a threshold so high that
    // none survive. The hint must NOT misdirect toward "re-index" and
    // SHOULD include a specific lowest-observed value the agent can
    // copy-paste back into the call.
    const result = await handler.execute('cartograph_biomarkers', {
      mode: 'ranked',
      minSeverity: 'info',
      minCentrality: 0.99,
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/No findings match those filters/);
    // The new case-1 message:
    expect(text).toMatch(/finding(s)? exist(s)? with centrality < 0\.99/);
    expect(text).toMatch(/lowest observed/);
    // The old misleading wording must NOT fire when centrality WAS
    // computed but findings simply fell below the threshold.
    expect(text).not.toMatch(/no centrality computed yet/);
  });

  it('surfaces a generic severity-lowering hint at the bottom', async () => {
    const result = await handler.execute('cartograph_biomarkers', {
      mode: 'ranked',
      minSeverity: 'info',
      minCentrality: 0.99,
    });
    const text = result.content[0]?.text ?? '';
    // The first hint already proposes the specific minCentrality
    // value to drop to; the bottom hint covers the other axes
    // (severity / metric range / etc.) without restating the
    // already-given minCentrality advice.
    expect(text).toMatch(/Drop minSeverity to "info" or lower other filters/);
  });

  // Friction #8 regression — `n_xxxxxxxx` UIDs minted by `cartograph_find`
  // must round-trip into `cartograph_biomarkers mode=symbol`. Previously
  // only `cartograph_node` honored the UID format.
  it('accepts an `n_xxxxxxxx` UID minted by cartograph_find in mode=symbol', async () => {
    const findResult = await handler.execute('cartograph_find', {
      by: 'name',
      query: 'gnarlyOne',
      mode: 'exact',
      compact: true,
      fields: ['name', 'id'],
    });
    const findText = findResult.content[0]?.text ?? '';
    const match = /id:(n_[0-9a-f]{8})/.exec(findText);
    expect(match).not.toBeNull();
    const uid = match![1]!;

    const result = await handler.execute('cartograph_biomarkers', {
      mode: 'symbol',
      symbol: uid,
    });
    const text = result.content[0]?.text ?? '';
    // Either renders findings + Code Health for the symbol, or the
    // "no findings — 10/10" path. Both prove the UID resolved; what
    // we're checking is that the "no symbol matched" path does NOT fire.
    expect(text).not.toMatch(/No symbol matched/);
  });

  // audit Group 2 #6 — mode=symbol must NOT present a non-existent
  // symbol as a clean "Code Health 10/10". `gnarlyTwo` is not a real
  // symbol; the FTS fallback resolves it to `gnarlyOne`, so the
  // response must carry a visible "Fuzzy fallback" banner.
  it('mode=symbol surfaces a fuzzy-fallback banner for a non-existent name', async () => {
    const result = await handler.execute('cartograph_biomarkers', {
      mode: 'symbol',
      symbol: 'gnarlyTwo',
    });
    const text = result.content[0]?.text ?? '';
    // Either it didn't resolve at all (not-found) OR it resolved
    // fuzzily — in which case the banner is mandatory. What it must
    // NOT do is render a bare clean-health line with no signal.
    const isNotFound = /not found/i.test(text);
    const hasBanner = /Fuzzy fallback/.test(text);
    expect(isNotFound || hasBanner).toBe(true);
    if (hasBanner) expect(text).toMatch(/gnarlyTwo/);
  });

  it('mode=symbol does NOT add a fuzzy banner for an exact symbol', async () => {
    const result = await handler.execute('cartograph_biomarkers', {
      mode: 'symbol',
      symbol: 'gnarlyOne',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).not.toMatch(/Fuzzy fallback/);
  });

  // Batched mode-symbol — a non-existent name in the batch must carry
  // the banner on its own section, not a silent 10/10.
  it('mode=symbol batched flags a fuzzy match without affecting real symbols', async () => {
    const result = await handler.execute('cartograph_biomarkers', {
      mode: 'symbol',
      symbols: ['gnarlyOne', 'gnarlyTwo'],
    });
    const text = result.content[0]?.text ?? '';
    // The real symbol's section carries no banner; the fuzzy one does
    // (or it reported no match — both acceptable, never a silent 10/10).
    const bannerCount = (text.match(/Fuzzy fallback/g) ?? []).length;
    const noMatchCount = (text.match(/no symbol matched/g) ?? []).length;
    expect(bannerCount + noMatchCount).toBeGreaterThanOrEqual(1);
  });

  it('mode=symbol errors when both symbol and symbols are supplied', async () => {
    const result = await handler.execute('cartograph_biomarkers', {
      mode: 'symbol',
      symbol: 'gnarlyOne',
      symbols: ['gnarlyOne'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/either `symbol` or `symbols`/);
  });

  // Friction #16 regression: pre-structural-fix-A, mode='symbol' silently
  // truncated `symbols: [...22 entries]` to the first 20 with no warning.
  // The shared `batchedSymbols` field locks `.max(20)` at the Zod
  // boundary, so over-cap inputs error consistently across every batched
  // tool (cartograph_node, cartograph_role, cartograph_graph, etc.).
  it('rejects over-cap symbols at the Zod boundary', async () => {
    const overflow = Array.from({ length: 22 }, (_, i) => `s${i}`);
    const result = await handler.execute('cartograph_biomarkers', {
      mode: 'symbol',
      symbols: overflow,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/at most 20 item/);
  });

  it('rejects empty symbols array at the Zod boundary', async () => {
    const result = await handler.execute('cartograph_biomarkers', {
      mode: 'symbol',
      symbols: [],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/at least 1 item/);
  });
});
