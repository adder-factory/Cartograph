/**
 * B19/B20/B21 (2026-05-23) — anti-pattern detectors.
 *
 * Same shape as B17's `accidental_quadratic` test (textual detector +
 * SIMPLE_RULES integration). Each detector gets its own describe block
 * with positive-match cases, false-positive guards, and the
 * `evaluateRules` round-trip pinning the threshold contract.
 */
import { describe, it, expect } from 'vitest';
import {
  countEmptyCatch,
  countSyncIoInAsync,
  countForofAwait,
  countTsAnyCast,
  countTsIgnoreSuppression,
  countAgentDebugLog,
  countIncompleteMarker,
  countDynamicEval,
  countInsecureHash,
  countRandomForSecurity,
  countHttpNoTimeout,
  countSqlStringConcat,
  countUnsafeJsonParse,
  countEnvNoValidation,
  countEmptyFunctionBody,
  evaluateRules,
  EMPTY_CATCH_RE,
  SYNC_IO_CALLS,
  FOROF_AWAIT_RE,
  TS_ANY_CAST_RE,
  TS_IGNORE_SUPPRESSION_RE,
  AGENT_DEBUG_LOG_RE,
  INCOMPLETE_MARKER_RE,
  NOT_IMPLEMENTED_RE,
  DYNAMIC_EVAL_RE,
  INSECURE_HASH_RE,
  MATH_RANDOM_RE,
  SECURITY_KEYWORD_RE,
  HTTP_CALL_RE,
  SQL_TEMPLATE_INTERPOLATION_RE,
  SQL_STRING_CONCAT_RE,
  JSON_PARSE_RE,
  PROCESS_ENV_DOT_RE,
} from '../src/biomarkers/engine.js';
import type { Language } from '../src/types.js';

function metrics(overrides: Record<string, number> = {}): {
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
} {
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

// ──────────────────────────────────────────────────────────────────────
// B19 — empty_catch
// ──────────────────────────────────────────────────────────────────────
describe('empty_catch detector (B19)', () => {
  it('catches `catch (e) {}` with empty body', () => {
    expect(countEmptyCatch('try { foo(); } catch (e) {}')).toBe(1);
  });

  it('catches `catch {}` (bindingless catch, ES2019+)', () => {
    expect(countEmptyCatch('try { foo(); } catch {}')).toBe(1);
  });

  it('catches multiple empty catches in one body', () => {
    const body = `
      try { a(); } catch (e) {}
      try { b(); } catch {}
      try { c(); } catch (err) {}
    `;
    expect(countEmptyCatch(body)).toBe(3);
  });

  it('SKIPS catches with a comment inside (documented intentional swallow)', () => {
    expect(countEmptyCatch('try { foo(); } catch (e) { /* intentional: see #123 */ }')).toBe(0);
    expect(countEmptyCatch('try { foo(); } catch (e) {\n  // ignore\n}')).toBe(0);
  });

  it('SKIPS catches with any statement', () => {
    expect(countEmptyCatch('try { foo(); } catch (e) { log(e); }')).toBe(0);
    expect(countEmptyCatch('try { foo(); } catch (e) { throw e; }')).toBe(0);
  });

  it('returns 0 for a body with no catch', () => {
    expect(countEmptyCatch('function f() { return 42; }')).toBe(0);
  });

  it('exports the regex constant for the wording-lint to walk', () => {
    expect(EMPTY_CATCH_RE).toBeInstanceOf(RegExp);
    EMPTY_CATCH_RE.lastIndex = 0;
    expect(EMPTY_CATCH_RE.test('catch (e) {}')).toBe(true);
  });

  it('evaluateRules: emits empty_catch at warning on first occurrence, error at 3', () => {
    const one = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics({ emptyCatchCount: 1 }) });
    expect(one.find((f) => f.biomarker === 'empty_catch')!.severity).toBe('warning');

    const two = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics({ emptyCatchCount: 2 }) });
    expect(two.find((f) => f.biomarker === 'empty_catch')!.severity).toBe('warning');

    const three = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics({ emptyCatchCount: 3 }) });
    expect(three.find((f) => f.biomarker === 'empty_catch')!.severity).toBe('error');
  });

  it('evaluateRules: does NOT emit empty_catch when count is 0', () => {
    const findings = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics({ emptyCatchCount: 0 }) });
    expect(findings.some((f) => f.biomarker === 'empty_catch')).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// B20 — sync_io_in_async
// ──────────────────────────────────────────────────────────────────────
describe('sync_io_in_async detector (B20)', () => {
  it('catches `readFileSync` inside an `async function`', () => {
    const body = `async function loadConfig() {
      const data = fs.readFileSync('/etc/config.json', 'utf-8');
      return JSON.parse(data);
    }`;
    expect(countSyncIoInAsync(body, 'typescript')).toBe(1);
  });

  it('catches `execSync` inside an async arrow', () => {
    const body = `const run = async (cmd) => {
      const out = execSync(cmd);
      return out.toString();
    };`;
    expect(countSyncIoInAsync(body, 'typescript')).toBe(1);
  });

  it('catches multiple sync calls in one async body', () => {
    const body = `async function build() {
      const cfg = readFileSync('config');
      const list = readdirSync('./src');
      writeFileSync('out', list.join('\\n'));
    }`;
    expect(countSyncIoInAsync(body, 'typescript')).toBe(3);
  });

  it('SKIPS sync calls in a NON-async function (legitimate use)', () => {
    const body = `function loadSync() {
      return fs.readFileSync('./config.json', 'utf-8');
    }`;
    expect(countSyncIoInAsync(body, 'typescript')).toBe(0);
  });

  it('SKIPS non-JS/TS languages', () => {
    const body = `async function f() { readFileSync('foo'); }`;
    expect(countSyncIoInAsync(body, 'java' as Language)).toBe(0);
    expect(countSyncIoInAsync(body, 'go' as Language)).toBe(0);
  });

  it('exports SYNC_IO_CALLS allowlist for transparency', () => {
    expect(SYNC_IO_CALLS).toContain('readFileSync');
    expect(SYNC_IO_CALLS).toContain('execSync');
    expect(SYNC_IO_CALLS).toContain('writeFileSync');
  });

  it('evaluateRules: emits sync_io_in_async at warning on first, error at 3', () => {
    const one = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics({ syncIoInAsyncCount: 1 }) });
    expect(one.find((f) => f.biomarker === 'sync_io_in_async')!.severity).toBe('warning');

    const three = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics({ syncIoInAsyncCount: 3 }) });
    expect(three.find((f) => f.biomarker === 'sync_io_in_async')!.severity).toBe('error');
  });

  it('evaluateRules: does NOT emit sync_io_in_async when count is 0', () => {
    const findings = evaluateRules({
      nodeId: 'a',
      language: 'typescript',
      metrics: metrics({ syncIoInAsyncCount: 0 }),
    });
    expect(findings.some((f) => f.biomarker === 'sync_io_in_async')).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// B21 — forof_await
// ──────────────────────────────────────────────────────────────────────
describe('forof_await detector (B21)', () => {
  it('catches `for (const x of items) { await foo(x); }`', () => {
    const body = `async function process(items) {
      for (const x of items) {
        await foo(x);
      }
    }`;
    expect(countForofAwait(body, 'typescript')).toBe(1);
  });

  it('catches `for (let item of arr)` shape', () => {
    const body = `for (let item of arr) { await save(item); }`;
    expect(countForofAwait(body, 'typescript')).toBe(1);
  });

  it('catches multiple sequential-await loops', () => {
    const body = `
      for (const a of A) { await one(a); }
      for (const b of B) { await two(b); }
    `;
    expect(countForofAwait(body, 'typescript')).toBe(2);
  });

  it('SKIPS `for await (...)` (intentional async iteration)', () => {
    const body = `for await (const chunk of stream) { process(chunk); }`;
    expect(countForofAwait(body, 'typescript')).toBe(0);
  });

  it('SKIPS for-of loops without await (no anti-pattern)', () => {
    const body = `for (const x of items) { process(x); }`;
    expect(countForofAwait(body, 'typescript')).toBe(0);
  });

  it('SKIPS non-JS/TS languages', () => {
    const body = `for (const x of items) { await foo(x); }`;
    expect(countForofAwait(body, 'java' as Language)).toBe(0);
  });

  it('exports the regex constant', () => {
    expect(FOROF_AWAIT_RE).toBeInstanceOf(RegExp);
  });

  it('evaluateRules: emits forof_await at info on 1, warning on 2, error on 5', () => {
    const one = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics({ forofAwaitCount: 1 }) });
    expect(one.find((f) => f.biomarker === 'forof_await')!.severity).toBe('info');

    const two = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics({ forofAwaitCount: 2 }) });
    expect(two.find((f) => f.biomarker === 'forof_await')!.severity).toBe('warning');

    const five = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics({ forofAwaitCount: 5 }) });
    expect(five.find((f) => f.biomarker === 'forof_await')!.severity).toBe('error');
  });

  it('evaluateRules: does NOT emit forof_await when count is 0', () => {
    const findings = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics({ forofAwaitCount: 0 }) });
    expect(findings.some((f) => f.biomarker === 'forof_await')).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// G26 — agent-prone tier, Phase 1 (7 detectors)
// ──────────────────────────────────────────────────────────────────────

describe('ts_any_cast detector (G26)', () => {
  it('counts `as any` casts', () => {
    expect(countTsAnyCast('const x = foo as any;', 'typescript')).toBe(1);
    expect(countTsAnyCast('return (x as any).bar;', 'typescript')).toBe(1);
  });

  it('counts `as unknown as X` double casts', () => {
    expect(countTsAnyCast('const x = foo as unknown as MyType;', 'typescript')).toBe(1);
  });

  it('counts multiple casts in one body', () => {
    expect(countTsAnyCast('(a as any) + (b as any) + (c as unknown as D)', 'typescript')).toBe(3);
  });

  it('does NOT match `asbestos` or `asyncFoo` (word boundary)', () => {
    expect(countTsAnyCast('const asbestos = 1; const asyncFn = 2;', 'typescript')).toBe(0);
  });

  it('TS-only — returns 0 for JavaScript', () => {
    expect(countTsAnyCast('const x = foo as any;', 'javascript')).toBe(0);
  });

  it('also works for TSX', () => {
    expect(countTsAnyCast('const el = props as any;', 'tsx')).toBe(1);
  });

  it('evaluateRules: silent on 1 (FFI-boundary tolerance), info on 2, warning on 3, error on 5', () => {
    const one = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics({ tsAnyCastCount: 1 }) });
    expect(one.some((f) => f.biomarker === 'ts_any_cast')).toBe(false);
    const two = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics({ tsAnyCastCount: 2 }) });
    expect(two.find((f) => f.biomarker === 'ts_any_cast')!.severity).toBe('info');
    const three = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics({ tsAnyCastCount: 3 }) });
    expect(three.find((f) => f.biomarker === 'ts_any_cast')!.severity).toBe('warning');
    const five = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics({ tsAnyCastCount: 5 }) });
    expect(five.find((f) => f.biomarker === 'ts_any_cast')!.severity).toBe('error');
  });

  it('exports the regex constant', () => {
    expect(TS_ANY_CAST_RE).toBeInstanceOf(RegExp);
  });
});

describe('ts_ignore_suppression detector (G26)', () => {
  it('counts `// @ts-ignore`', () => {
    expect(countTsIgnoreSuppression('// @ts-ignore\nfoo();', 'typescript')).toBe(1);
  });

  it('counts `// @ts-expect-error`', () => {
    expect(countTsIgnoreSuppression('// @ts-expect-error\nfoo();', 'typescript')).toBe(1);
  });

  it('counts multiple suppressions in one body', () => {
    const body = `
      // @ts-ignore
      const a = foo();
      // @ts-expect-error
      const b = bar();
    `;
    expect(countTsIgnoreSuppression(body, 'typescript')).toBe(2);
  });

  it('TS-only — returns 0 for JavaScript', () => {
    expect(countTsIgnoreSuppression('// @ts-ignore\nfoo();', 'javascript')).toBe(0);
  });

  it('evaluateRules: warning on 1, error on 3', () => {
    const one = evaluateRules({
      nodeId: 'a',
      language: 'typescript',
      metrics: metrics({ tsIgnoreSuppressionCount: 1 }),
    });
    expect(one.find((f) => f.biomarker === 'ts_ignore_suppression')!.severity).toBe('warning');
    const three = evaluateRules({
      nodeId: 'a',
      language: 'typescript',
      metrics: metrics({ tsIgnoreSuppressionCount: 3 }),
    });
    expect(three.find((f) => f.biomarker === 'ts_ignore_suppression')!.severity).toBe('error');
  });

  it('exports the regex', () => {
    expect(TS_IGNORE_SUPPRESSION_RE).toBeInstanceOf(RegExp);
  });
});

describe('agent_debug_log detector (G26)', () => {
  it('counts ungated console.log/error/warn/info/debug', () => {
    expect(countAgentDebugLog('console.log("a");', 'console.log("a");', 'typescript')).toBe(1);
    expect(countAgentDebugLog('console.error("e");', 'console.error("e");', 'typescript')).toBe(1);
    expect(countAgentDebugLog('console.warn("w");', 'console.warn("w");', 'typescript')).toBe(1);
    expect(countAgentDebugLog('console.info("i");', 'console.info("i");', 'typescript')).toBe(1);
    expect(countAgentDebugLog('console.debug("d");', 'console.debug("d");', 'typescript')).toBe(1);
  });

  it('SKIPS when body references process.env (gated)', () => {
    expect(
      countAgentDebugLog(
        'if (process.env.DEBUG) console.log("x");',
        'if (process.env.DEBUG) console.log("x");',
        'typescript',
      ),
    ).toBe(0);
  });

  it('SKIPS when body mentions a DEBUG / VERBOSE / TRACE keyword', () => {
    expect(countAgentDebugLog('if (DEBUG) console.log("x");', 'if (DEBUG) console.log("x");', 'typescript')).toBe(0);
    expect(countAgentDebugLog('if (VERBOSE) console.log("x");', 'if (VERBOSE) console.log("x");', 'typescript')).toBe(
      0,
    );
    expect(countAgentDebugLog('if (TRACE) console.log("x");', 'if (TRACE) console.log("x");', 'typescript')).toBe(0);
  });

  it('counts multiple ungated console calls', () => {
    expect(
      countAgentDebugLog(
        'console.log("a"); console.error("b"); console.warn("c");',
        'console.log("a"); console.error("b"); console.warn("c");',
        'typescript',
      ),
    ).toBe(3);
  });

  it('TS+JS+TSX+JSX gate; other langs return 0', () => {
    expect(countAgentDebugLog('console.log("a");', 'console.log("a");', 'go')).toBe(0);
    expect(countAgentDebugLog('console.log("a");', 'console.log("a");', 'python')).toBe(0);
  });

  it('evaluateRules: warning on 1, error on 5', () => {
    const one = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics({ agentDebugLogCount: 1 }) });
    expect(one.find((f) => f.biomarker === 'agent_debug_log')!.severity).toBe('warning');
    const five = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics({ agentDebugLogCount: 5 }) });
    expect(five.find((f) => f.biomarker === 'agent_debug_log')!.severity).toBe('error');
  });

  it('exports the regex', () => {
    expect(AGENT_DEBUG_LOG_RE).toBeInstanceOf(RegExp);
  });
});

describe('incomplete_marker detector (G26)', () => {
  it('counts TODO / FIXME / XXX / HACK markers', () => {
    expect(countIncompleteMarker('// TODO: fix this')).toBe(1);
    expect(countIncompleteMarker('// FIXME: broken')).toBe(1);
    expect(countIncompleteMarker('/* XXX dangerous */')).toBe(1);
    expect(countIncompleteMarker('// HACK temporary')).toBe(1);
  });

  it('counts the `throw new Error("not implemented")` shape', () => {
    expect(countIncompleteMarker("throw new Error('not implemented');")).toBe(1);
    expect(countIncompleteMarker('throw new Error("Not Implemented");')).toBe(1);
  });

  it('counts Python `NotImplementedError` raises', () => {
    expect(countIncompleteMarker('raise NotImplementedError()')).toBe(1);
  });

  it('counts multiple markers + stub shapes', () => {
    const body = `
      // TODO refactor
      // FIXME race condition
      throw new Error('not implemented');
    `;
    expect(countIncompleteMarker(body)).toBe(3);
  });

  it('does NOT match substring `TODOLIST` or `FIXMER`', () => {
    expect(countIncompleteMarker('const TODOLIST = 1; const FIXMER = 2;')).toBe(0);
  });

  it('returns 0 for clean code', () => {
    expect(countIncompleteMarker('function foo() { return 42; }')).toBe(0);
  });

  it('evaluateRules: info on 1, warning on 5', () => {
    const one = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics({ incompleteMarkerCount: 1 }) });
    expect(one.find((f) => f.biomarker === 'incomplete_marker')!.severity).toBe('info');
    const five = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics({ incompleteMarkerCount: 5 }) });
    expect(five.find((f) => f.biomarker === 'incomplete_marker')!.severity).toBe('warning');
  });

  it('exports regex constants', () => {
    expect(INCOMPLETE_MARKER_RE).toBeInstanceOf(RegExp);
    expect(NOT_IMPLEMENTED_RE).toBeInstanceOf(RegExp);
  });
});

describe('dynamic_eval detector (G26)', () => {
  it('counts eval() calls', () => {
    expect(countDynamicEval('eval(userInput);', 'typescript')).toBe(1);
  });

  it('counts new Function() calls', () => {
    expect(countDynamicEval('const fn = new Function("a", "return a + 1");', 'typescript')).toBe(1);
  });

  it('counts both shapes in one body', () => {
    expect(countDynamicEval('eval(a); new Function(b);', 'typescript')).toBe(2);
  });

  it('JS/TS-gated; other langs return 0', () => {
    expect(countDynamicEval('eval(x)', 'python')).toBe(0);
  });

  it('evaluateRules: error on first occurrence (warn = error = 1)', () => {
    const one = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics({ dynamicEvalCount: 1 }) });
    expect(one.find((f) => f.biomarker === 'dynamic_eval')!.severity).toBe('error');
  });

  it('exports the regex', () => {
    expect(DYNAMIC_EVAL_RE).toBeInstanceOf(RegExp);
  });
});

describe('insecure_hash detector (G26)', () => {
  it("counts createHash('md5')", () => {
    expect(countInsecureHash("createHash('md5')", 'typescript')).toBe(1);
  });

  it("counts createHash('sha1')", () => {
    expect(countInsecureHash('createHash("sha1")', 'typescript')).toBe(1);
  });

  it('case-insensitive on the algorithm name', () => {
    expect(countInsecureHash("createHash('MD5')", 'typescript')).toBe(1);
    expect(countInsecureHash('createHash("Sha1")', 'typescript')).toBe(1);
  });

  it('does NOT match sha256+', () => {
    expect(countInsecureHash("createHash('sha256')", 'typescript')).toBe(0);
    expect(countInsecureHash("createHash('sha512')", 'typescript')).toBe(0);
  });

  it('JS/TS-gated', () => {
    expect(countInsecureHash("createHash('md5')", 'python')).toBe(0);
  });

  it('evaluateRules: warning on 1, error on 3', () => {
    const one = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics({ insecureHashCount: 1 }) });
    expect(one.find((f) => f.biomarker === 'insecure_hash')!.severity).toBe('warning');
    const three = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics({ insecureHashCount: 3 }) });
    expect(three.find((f) => f.biomarker === 'insecure_hash')!.severity).toBe('error');
  });

  it('exports the regex', () => {
    expect(INSECURE_HASH_RE).toBeInstanceOf(RegExp);
  });
});

describe('random_for_security detector (G26)', () => {
  it('counts Math.random() when body contains "token"', () => {
    expect(
      countRandomForSecurity(
        'const token = Math.random().toString();',
        'const token = Math.random().toString();',
        'typescript',
      ),
    ).toBe(1);
  });

  it('counts Math.random() when body contains "password"', () => {
    expect(
      countRandomForSecurity('const password = Math.random();', 'const password = Math.random();', 'typescript'),
    ).toBe(1);
  });

  it('counts Math.random() when body contains "apiKey"', () => {
    expect(
      countRandomForSecurity(
        'const apiKey = `key-${Math.random()}`;',
        'const apiKey = `key-${Math.random()}`;',
        'typescript',
      ),
    ).toBe(1);
  });

  it('SKIPS when body has no security keyword', () => {
    expect(countRandomForSecurity('const jitter = Math.random();', 'const jitter = Math.random();', 'typescript')).toBe(
      0,
    );
    expect(
      countRandomForSecurity(
        'const sample = Math.random() * 100;',
        'const sample = Math.random() * 100;',
        'typescript',
      ),
    ).toBe(0);
  });

  it('counts multiple Math.random() calls in a security body', () => {
    // Realistic shape — variable named `token`/`secret` triggers the
    // gate; multiple Math.random() inside count.
    const body = `
      const token = '';
      const secret = '';
      const a = Math.random();
      const b = Math.random();
    `;
    expect(countRandomForSecurity(body, body, 'typescript')).toBe(2);
  });

  it('does NOT trigger on lone `key` / `id` (deliberately omitted)', () => {
    // The brief suggested these keywords but they generate too many
    // false positives (`Map.get(key)`, `array[id]`); we use phrases
    // like `apiKey` / `sessionId` instead.
    expect(
      countRandomForSecurity('const x = arr[key]; Math.random();', 'const x = arr[key]; Math.random();', 'typescript'),
    ).toBe(0);
    expect(countRandomForSecurity('const id = i; Math.random();', 'const id = i; Math.random();', 'typescript')).toBe(
      0,
    );
  });

  it('JS/TS-gated', () => {
    expect(countRandomForSecurity('const token = Math.random();', 'const token = Math.random();', 'python')).toBe(0);
  });

  it('evaluateRules: error on first occurrence (warn = error = 1)', () => {
    const one = evaluateRules({
      nodeId: 'a',
      language: 'typescript',
      metrics: metrics({ randomForSecurityCount: 1 }),
    });
    expect(one.find((f) => f.biomarker === 'random_for_security')!.severity).toBe('error');
  });

  it('exports regex constants', () => {
    expect(MATH_RANDOM_RE).toBeInstanceOf(RegExp);
    expect(SECURITY_KEYWORD_RE).toBeInstanceOf(RegExp);
  });
});

// ──────────────────────────────────────────────────────────────────────
// G26 Phase 2 — Tier-2 agent-prone tier (5 detectors)
// ──────────────────────────────────────────────────────────────────────

describe('http_no_timeout detector (G26-P2)', () => {
  it('counts fetch() and axios.{get,post,...}( calls when body has no timeout/signal', () => {
    expect(countHttpNoTimeout('fetch(url)', 'fetch(url)', 'typescript')).toBe(1);
    expect(countHttpNoTimeout('axios.get(url)', 'axios.get(url)', 'typescript')).toBe(1);
    expect(countHttpNoTimeout('axios.post(url, data)', 'axios.post(url, data)', 'typescript')).toBe(1);
  });

  it('SKIPS when body mentions `signal` (AbortController usage)', () => {
    const body = 'const c = new AbortController(); fetch(url, { signal: c.signal });';
    expect(countHttpNoTimeout(body, body, 'typescript')).toBe(0);
  });

  it('SKIPS when body mentions `timeout` (axios-style)', () => {
    const body = 'axios.get(url, { timeout: 5000 });';
    expect(countHttpNoTimeout(body, body, 'typescript')).toBe(0);
  });

  it('counts multiple calls in one un-gated body', () => {
    const body = 'fetch(a); fetch(b); axios.get(c);';
    expect(countHttpNoTimeout(body, body, 'typescript')).toBe(3);
  });

  it('returns 0 for non-JS/TS languages', () => {
    expect(countHttpNoTimeout('fetch(x)', 'fetch(x)', 'python' as Language)).toBe(0);
  });

  it('evaluateRules: warning on 1, error on 3', () => {
    const one = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics({ httpNoTimeoutCount: 1 }) });
    expect(one.find((f) => f.biomarker === 'http_no_timeout')!.severity).toBe('warning');
    const three = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics({ httpNoTimeoutCount: 3 }) });
    expect(three.find((f) => f.biomarker === 'http_no_timeout')!.severity).toBe('error');
  });

  it('exports the regex constant', () => {
    expect(HTTP_CALL_RE).toBeInstanceOf(RegExp);
  });
});

describe('sql_string_concat detector (G26-P2)', () => {
  it('counts template-literal SQL with ${} interpolation that includes member access (real injection shape)', () => {
    // Bare-identifier interpolations (`${table}`, `${id}`) are
    // skipped by the bare-identifier gate — see the dedicated test
    // below. Member-access / function-call interpolations fire.
    const body = 'const q = `SELECT * FROM users WHERE id = ${req.body.id}`;';
    expect(countSqlStringConcat(body, 'typescript')).toBeGreaterThanOrEqual(1);
  });

  it('counts string-concat SQL', () => {
    const body = "const q = 'SELECT * FROM users WHERE id = ' + id;";
    expect(countSqlStringConcat(body, 'typescript')).toBe(1);
  });

  it('counts case-insensitively (select / SELECT / Select all match)', () => {
    expect(countSqlStringConcat("const q = 'select * from t WHERE id = ' + id;", 'typescript')).toBe(1);
  });

  it('does NOT match parameterized queries (no interpolation/concat near the verb)', () => {
    expect(countSqlStringConcat('db.prepare(`SELECT * FROM nodes WHERE id = @id`).all({ id });', 'typescript')).toBe(0);
    expect(countSqlStringConcat("db.prepare('SELECT * FROM nodes WHERE id = ?').all(id);", 'typescript')).toBe(0);
  });

  it('does NOT match SQL keywords in non-SQL contexts', () => {
    expect(countSqlStringConcat('function selectItems() { return items; }', 'typescript')).toBe(0);
  });

  it('SKIPS when every ${…} interpolation is a bare identifier (table/column-name pattern)', () => {
    // SQL forbids parameterizing table or column names — dynamic
    // table-name interpolation is unavoidable for migrations / vec0.
    // Call sites that need to interpolate a member-access value
    // (e.g. row.tableName) copy to a local first: `const t = row.tableName; … ${t}`.
    expect(countSqlStringConcat('const q = `SELECT * FROM ${table} WHERE id = ${id}`;', 'typescript')).toBe(0);
    expect(countSqlStringConcat('const q = `ALTER TABLE ${tableName} ADD COLUMN ${col} INTEGER`;', 'typescript')).toBe(
      0,
    );
  });

  it('STILL fires on member access / function call / arithmetic (real injection shapes)', () => {
    expect(countSqlStringConcat('const q = `SELECT * FROM users WHERE id = ${args.id}`;', 'typescript')).toBe(1);
    expect(countSqlStringConcat('const q = `SELECT * FROM x WHERE name = ${escape(input)}`;', 'typescript')).toBe(1);
    expect(countSqlStringConcat('const q = `SELECT * FROM x WHERE n = ${a + b}`;', 'typescript')).toBe(1);
  });

  it('SKIPS when body has BOTH .prepare( AND a literal `?` placeholder (the codebase dynamic-IN-list idiom)', () => {
    // The most common parameterized pattern is:
    //   db.prepare(`SELECT ... WHERE kind IN (${kinds.map(()=>'?').join(',')})`)
    // The interpolation is a placeholder count, NOT user data — bound
    // params still flow through `.all(...kinds)`. Skip the false alarm.
    const body =
      "const placeholders = kinds.map(() => '?').join(','); const q = db.prepare(`SELECT * FROM nodes WHERE kind IN (${placeholders})`).all(...kinds);";
    expect(countSqlStringConcat(body, 'typescript')).toBe(0);
  });

  it('returns 0 for non-JS/TS', () => {
    expect(countSqlStringConcat('`SELECT * FROM ${t}`', 'python' as Language)).toBe(0);
  });

  it('evaluateRules: warning on 1, error on 2', () => {
    const one = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics({ sqlStringConcatCount: 1 }) });
    expect(one.find((f) => f.biomarker === 'sql_string_concat')!.severity).toBe('warning');
    const two = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics({ sqlStringConcatCount: 2 }) });
    expect(two.find((f) => f.biomarker === 'sql_string_concat')!.severity).toBe('error');
  });

  it('exports the regex constants', () => {
    expect(SQL_TEMPLATE_INTERPOLATION_RE).toBeInstanceOf(RegExp);
    expect(SQL_STRING_CONCAT_RE).toBeInstanceOf(RegExp);
  });
});

describe('unsafe_json_parse detector (G26-P2)', () => {
  it('counts JSON.parse() calls in a body without try/catch', () => {
    expect(countUnsafeJsonParse('return JSON.parse(input);', 'return JSON.parse(input);', 'typescript')).toBe(1);
  });

  it('counts multiple parses in one ungated body', () => {
    const body = 'const a = JSON.parse(x); const b = JSON.parse(y);';
    expect(countUnsafeJsonParse(body, body, 'typescript')).toBe(2);
  });

  it('SKIPS when body has a `catch` clause anywhere', () => {
    const body = 'try { return JSON.parse(input); } catch (e) { return null; }';
    expect(countUnsafeJsonParse(body, body, 'typescript')).toBe(0);
  });

  it('returns 0 for non-JS/TS', () => {
    expect(countUnsafeJsonParse('JSON.parse(x)', 'JSON.parse(x)', 'python' as Language)).toBe(0);
  });

  it('evaluateRules: warning on 1, error on 3', () => {
    const one = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics({ unsafeJsonParseCount: 1 }) });
    expect(one.find((f) => f.biomarker === 'unsafe_json_parse')!.severity).toBe('warning');
    const three = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics({ unsafeJsonParseCount: 3 }) });
    expect(three.find((f) => f.biomarker === 'unsafe_json_parse')!.severity).toBe('error');
  });

  it('exports the regex', () => {
    expect(JSON_PARSE_RE).toBeInstanceOf(RegExp);
  });
});

describe('env_no_validation detector (G26-P2)', () => {
  it('counts dot-access process.env.NAME reads in a non-Zod body', () => {
    const body = 'const url = process.env.API_URL;';
    expect(countEnvNoValidation(body, body, 'typescript')).toBe(1);
  });

  it('counts multiple dot-access reads', () => {
    const body = 'const a = process.env.FOO; const b = process.env.BAR;';
    expect(countEnvNoValidation(body, body, 'typescript')).toBe(2);
  });

  it('SKIPS bracket-access process.env["X"] (codebase opt-in pattern)', () => {
    const body = "const url = process.env['API_URL'];";
    expect(countEnvNoValidation(body, body, 'typescript')).toBe(0);
  });

  it('SKIPS when body uses Zod (z.X reference)', () => {
    const body = 'const schema = z.string(); const url = process.env.API_URL;';
    expect(countEnvNoValidation(body, body, 'typescript')).toBe(0);
  });

  it('returns 0 for non-JS/TS', () => {
    expect(countEnvNoValidation('process.env.X', 'process.env.X', 'python' as Language)).toBe(0);
  });

  it('evaluateRules: warning on 1, error on 3', () => {
    const one = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics({ envNoValidationCount: 1 }) });
    expect(one.find((f) => f.biomarker === 'env_no_validation')!.severity).toBe('warning');
    const three = evaluateRules({
      nodeId: 'a',
      language: 'typescript',
      metrics: metrics({ envNoValidationCount: 3 }),
    });
    expect(three.find((f) => f.biomarker === 'env_no_validation')!.severity).toBe('error');
  });

  it('exports the regex', () => {
    expect(PROCESS_ENV_DOT_RE).toBeInstanceOf(RegExp);
  });
});

describe('empty_function_body detector (G26-P2)', () => {
  it('matches `{}`', () => {
    expect(countEmptyFunctionBody('{}')).toBe(1);
  });

  it('matches `{ return; }`', () => {
    expect(countEmptyFunctionBody('{ return; }')).toBe(1);
  });

  it('matches `{ return undefined; }` and `{ return null; }`', () => {
    expect(countEmptyFunctionBody('{ return undefined; }')).toBe(1);
    expect(countEmptyFunctionBody('{ return null; }')).toBe(1);
  });

  it('returns 0 for a body with real code', () => {
    expect(countEmptyFunctionBody('{ return x + 1; }')).toBe(0);
    expect(countEmptyFunctionBody('{ foo(); }')).toBe(0);
  });

  it('SKIPS bodies that document the no-op via a comment (silentLogger pattern)', () => {
    expect(countEmptyFunctionBody('{ /* intentional no-op for protocol conformance */ }')).toBe(0);
    expect(countEmptyFunctionBody('{ // no-op\n}')).toBe(0);
  });

  it('evaluateRules: info on 1 (warning/error effectively disabled)', () => {
    const one = evaluateRules({
      nodeId: 'a',
      language: 'typescript',
      metrics: metrics({ emptyFunctionBodyCount: 1 }),
    });
    expect(one.find((f) => f.biomarker === 'empty_function_body')!.severity).toBe('info');
  });
});
