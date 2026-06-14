/**
 * B19/B20/B21 (2026-05-23) — anti-pattern detectors.
 *
 * Same shape as B17's `accidental_quadratic` test (textual detector +
 * SIMPLE_RULES integration). Each detector gets its own describe block
 * with positive-match cases, false-positive guards, and the
 * `evaluateRules` round-trip pinning the threshold contract.
 */
import { describe, it, expect, beforeAll } from 'vitest';
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
  computeMetrics,
  findNodeAt,
  evaluateRules,
  _internalForTests,
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
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars.js';
import type { Language } from '../src/types.js';

const { isMagicNumber } = _internalForTests;

// The structural-detector tests below drive computeMetrics, which parses
// real source via tree-sitter — grammars must be loaded first.
beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

/** Parse `src`, anchor the symbol at (line,col), and compute its metrics.
 *  Keeps each structural test to one expressive line. */
function metricsFor(
  src: string,
  language: Language,
  startLine: number,
  endLine: number,
  line = 1,
  column = 0,
): ReturnType<typeof computeMetrics> {
  const node = findNodeAt({ source: src, language, line, column });
  if (!node) throw new Error('findNodeAt returned null');
  return computeMetrics({ bodyNode: node, language, startLine, endLine });
}

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
    const body = String.raw`async function build() {
      const cfg = readFileSync('config');
      const list = readdirSync('./src');
      writeFileSync('out', list.join('\n'));
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

  it('SKIPS when the flag keyword sits inside a SCREAMING_SNAKE compound (Workers/Deno env bindings)', () => {
    const workersSink = 'const silent = env.DEBUG_DIAGNOSTICS === "silent"; if (!silent) console.error(msg);';
    expect(countAgentDebugLog(workersSink, workersSink, 'typescript')).toBe(0);
    const appDebug = 'if (settings.APP_DEBUG) console.log("x");';
    expect(countAgentDebugLog(appDebug, appDebug, 'typescript')).toBe(0);
    const logVerbose = 'if (env.LOG_VERBOSE) console.info("x");';
    expect(countAgentDebugLog(logVerbose, logVerbose, 'typescript')).toBe(0);
  });

  it('still COUNTS when the keyword is merely embedded in a longer word', () => {
    const embedded = 'if (DEBUGGER) console.log("x");';
    expect(countAgentDebugLog(embedded, embedded, 'typescript')).toBe(1);
    const lowercase = 'const debug = true; console.log("x");';
    expect(countAgentDebugLog(lowercase, lowercase, 'typescript')).toBe(1);
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

  it('does NOT count a fetch-named DECLARATION (Durable Object / service-worker handler)', () => {
    const doHandler = 'async fetch(request: Request): Promise<Response> { return handle(request); }';
    expect(countHttpNoTimeout(doHandler, doHandler, 'typescript')).toBe(0);
    const fnDecl = 'function fetch(resource: string) { return resource; }';
    expect(countHttpNoTimeout(fnDecl, fnDecl, 'typescript')).toBe(0);
    const staticDecl = 'static async fetch(req: Request) { return route(req); }';
    expect(countHttpNoTimeout(staticDecl, staticDecl, 'typescript')).toBe(0);
  });

  it('still counts a real ungated call next to a fetch-named declaration', () => {
    const mixed = 'async fetch(request: Request) { const r = await fetch(API_URL); return r; }';
    expect(countHttpNoTimeout(mixed, mixed, 'typescript')).toBe(1);
  });

  it('does NOT count override / generator declarations either', () => {
    const overrideDecl = 'override fetch(req: Request) { return route(req); }';
    expect(countHttpNoTimeout(overrideDecl, overrideDecl, 'typescript')).toBe(0);
    const generatorDecl = 'function* fetch(resource: string) { yield resource; }';
    expect(countHttpNoTimeout(generatorDecl, generatorDecl, 'typescript')).toBe(0);
  });

  it('a comment mentioning timeout does NOT mute the finding (gate reads code only)', () => {
    const raw = '// TODO: add timeout\nfetch(url);';
    const code = '\nfetch(url);'; // comment stripped by the code-only pass
    expect(countHttpNoTimeout(raw, code, 'typescript')).toBe(1);
  });

  it('a real signal/timeout in code still gates', () => {
    const body = 'const c = new AbortController(); fetch(url, { signal: c.signal });';
    expect(countHttpNoTimeout(body, body, 'typescript')).toBe(0);
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

// ──────────────────────────────────────────────────────────────────────
// STRUCTURAL complexity detectors — the per-symbol AST-metric tier.
// These drive computeMetrics (AST walk) + evaluateRules (threshold map)
// for large_method / complex_method / nested_complexity /
// complex_conditional / long_parameter_list / magic_number /
// brain_method, plus the engine helpers (isMagicNumber, isCountedBranch,
// the Go nil-comparison deduction, countParameters, countConditional-
// Operands, severityFor). Values below were probed against the live
// detector, not guessed.
// ──────────────────────────────────────────────────────────────────────

describe('computeMetrics: cyclomatic / nesting (AST walk)', () => {
  it('counts cyclomatic EXACTLY: base 1 + 2 if + 1 for + 1 nested-if = 5', () => {
    const src = `function f(x: number): number {
  if (x > 0) return 1;
  if (x < 0) return -1;
  for (let i = 0; i < 10; i++) {
    if (i === x) return i;
  }
  return 0;
}`;
    expect(metricsFor(src, 'typescript', 1, 8).cyclomatic).toBe(5);
  });

  it('tracks max nesting EXACTLY: if > while > for > if = 4', () => {
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
    expect(metricsFor(src, 'typescript', 1, 12).maxNesting).toBe(4);
  });

  it('a branch-free body has cyclomatic 1 (CYCLOMATIC_BASE) and nesting 0', () => {
    const src = `function flat(a: number, b: number): number {
  const c = a + b;
  return c;
}`;
    const m = metricsFor(src, 'typescript', 1, 4);
    expect(m.cyclomatic).toBe(1);
    expect(m.maxNesting).toBe(0);
  });

  it('keeps the DEEPEST nesting even when a shallower block follows it (max, not last)', () => {
    // A naive `maxNesting = newDepth` (always-assign) mutant would report
    // the trailing shallow `if (d)` depth (1) instead of the peak (3).
    const src = `function f(a: boolean, b: boolean, c: boolean, d: boolean): number {
  if (a) {
    if (b) {
      if (c) { return 1; }
    }
  }
  if (d) { return 2; }
  return 0;
}`;
    expect(metricsFor(src, 'typescript', 1, 9).maxNesting).toBe(3);
  });

  it('reports loc as the inclusive 1-based line span (endLine - startLine + 1)', () => {
    const src = `function tiny() { return 1; }`;
    expect(metricsFor(src, 'typescript', 10, 19).loc).toBe(10);
  });

  it('clamps loc to >= 0 when endLine precedes startLine', () => {
    const src = `function tiny() { return 1; }`;
    expect(metricsFor(src, 'typescript', 5, 1).loc).toBe(0);
  });

  it('returns base metrics (loc only) for an unsupported language with no LangMap', () => {
    const stub = { type: 'fake', childCount: 0, children: [], text: '' } as never;
    const m = computeMetrics({ bodyNode: stub, language: 'unknown' as Language, startLine: 1, endLine: 10 });
    expect(m.loc).toBe(10);
    expect(m.cyclomatic).toBe(1);
    expect(m.maxNesting).toBe(0);
    expect(m.maxConditionalOperands).toBe(0);
    expect(m.magicNumberCount).toBe(0);
  });
});

describe('isCountedBranch + Go nil-comparison deduction', () => {
  it('Go: a lone `if err != nil` body has cyclomatic 1 (deduction fires)', () => {
    const src = `package p
func run() error {
    a, err := step1()
    if err != nil {
        return err
    }
    return nil
}`;
    expect(metricsFor(src, 'go', 2, 8, 2, 0).cyclomatic).toBe(1);
  });

  it('Go: an err-nil check + a REAL `if` counts only the real branch (cyclomatic 2)', () => {
    // Pins the `&&` chain in isCountedBranch: the err-nil if is deducted,
    // the value-comparison if is not.
    const src = `package p
func tier(x int) (string, error) {
    a, err := step1()
    if err != nil {
        return "", err
    }
    if x > 100 {
        return "big", nil
    }
    return "small", nil
}`;
    expect(metricsFor(src, 'go', 2, 10, 2, 0).cyclomatic).toBe(2);
  });

  it('Go: an `if` whose condition is a binary comparison (not nil) is a real branch (cyclomatic 2)', () => {
    // isGoNilComparisonIfStatement sees a binary_expression first child
    // but no `nil` operand → returns false → the if IS counted.
    const src = `package p
func f(x int, y int) int {
    if x > y {
        return 1
    }
    return 0
}`;
    expect(metricsFor(src, 'go', 2, 7, 2, 0).cyclomatic).toBe(2);
  });

  it('Go: an `if` whose condition is NOT a binary_expression (a call) is a real branch (cyclomatic 2)', () => {
    // isGoNilComparisonIfStatement bails at the `firstChild?.type !==
    // "binary_expression"` guard → the if IS counted.
    const src = `package p
func f(x int) int {
    if g(x) {
        return 1
    }
    return 0
}`;
    expect(metricsFor(src, 'go', 2, 7, 2, 0).cyclomatic).toBe(2);
  });

  it('TS: the same `if (x === null)` shape is NOT deducted (Go-only convention)', () => {
    // The deduction is gated on language === "go"; TS keeps the branch.
    const src = `function init0(x: number | null): number {
  if (x === null) {
    return 0;
  }
  return x;
}`;
    expect(metricsFor(src, 'typescript', 1, 6).cyclomatic).toBe(2);
  });

  it('Go: a `for x != nil` loop (for-as-while) IS counted — the deduction is if-only', () => {
    // The deduction is gated on `nodeType === "if_statement"`. Dropping
    // that guard would route the for-loop's `x != nil` condition through
    // the nil check and wrongly deduct it, leaving cyclomatic 1 instead
    // of 2.
    const src = `package p
func walk(x *Node) int {
    n := 0
    for x != nil {
        n++
        x = x.next
    }
    return n
}`;
    expect(metricsFor(src, 'go', 2, 9, 2, 0).cyclomatic).toBe(2);
  });
});

describe('countConditionalOperands (complex_conditional metric)', () => {
  // In TS, `if_statement` is in BOTH `nesting` and `conditional`; the AST
  // walk hits the nesting branch first and `continue`s, so the only TS
  // conditional that reaches countConditionalOperands is the ternary.
  it('counts a 3-clause boolean chain `(a && b && c) ? :` as 3 operands', () => {
    const src = `function f(a: boolean, b: boolean, c: boolean): number {
  return (a && b && c) ? 1 : 0;
}`;
    expect(metricsFor(src, 'typescript', 1, 3).maxConditionalOperands).toBe(3);
  });

  it('counts mixed comparisons `(x > 0 && y > 0 && x < 10) ? :` as 3 operands', () => {
    const src = `function f(x: number, y: number): number {
  return (x > 0 && y > 0 && x < 10) ? 1 : 0;
}`;
    expect(metricsFor(src, 'typescript', 1, 3).maxConditionalOperands).toBe(3);
  });

  it('a trivial ternary `a ? :` floors at 1 operand (Math.max(count, 1))', () => {
    const src = `function f(a: boolean): number {
  return a ? 1 : 0;
}`;
    expect(metricsFor(src, 'typescript', 1, 3).maxConditionalOperands).toBe(1);
  });

  it('does NOT descend into a nested lambda — the inner `&&` belongs to the lambda', () => {
    // FUNCTION_CONTAINER_KINDS guard: the outer ternary test is just the
    // `.find(...)` call (1 operand), NOT the `x.a && x.b` inside the arrow.
    const src = `function f(arr: number[]): number {
  return arr.find((x) => x && x) ? 1 : 0;
}`;
    expect(metricsFor(src, 'typescript', 1, 3).maxConditionalOperands).toBe(1);
  });

  it('keeps the MOST-complex conditional even when a trivial one follows (max, not last)', () => {
    // A naive `maxConditionalOperands = ops` (always-assign) mutant would
    // report the trailing trivial ternary (1) instead of the peak (3).
    const src = `function f(a: boolean, b: boolean, c: boolean): number {
  const x = (a && b && c) ? 1 : 0;
  const y = a ? 2 : 3;
  return x + y;
}`;
    expect(metricsFor(src, 'typescript', 1, 5).maxConditionalOperands).toBe(3);
  });
});

describe('countParameters (long_parameter_list metric)', () => {
  it('counts declaration-site formal parameters', () => {
    const src = `function f(a: number, b: number, c: number, d: number) { return a; }`;
    expect(metricsFor(src, 'typescript', 1, 1).paramCount).toBe(4);
  });

  it('a zero-parameter function reports paramCount 0', () => {
    const src = `function f() { return 1; }`;
    expect(metricsFor(src, 'typescript', 1, 1).paramCount).toBe(0);
  });

  it('a single-identifier arrow `x => ...` counts as 1 parameter', () => {
    // Pins the arrow_function single-identifier shortcut branch.
    const node = findNodeAt({ source: 'const f = x => x * 2;', language: 'typescript', line: 1, column: 10 });
    const m = computeMetrics({ bodyNode: node!, language: 'typescript', startLine: 1, endLine: 1 });
    expect(m.paramCount).toBe(1);
  });

  it('a parenthesised multi-param arrow `(a, b, c) => ...` counts the WHOLE list, not 1', () => {
    // The single-identifier shortcut must only fire when the arrow's
    // first child is a bare `identifier`; a `(a, b, c) =>` arrow has a
    // `formal_parameters` first child and must fall through to the list
    // counter. A `first?.type === "identifier"` → always-true mutant
    // would short-circuit to 1.
    const node = findNodeAt({
      source: 'const f = (a: number, b: number, c: number) => a + b + c;',
      language: 'typescript',
      line: 1,
      column: 10,
    });
    const m = computeMetrics({ bodyNode: node!, language: 'typescript', startLine: 1, endLine: 1 });
    expect(m.paramCount).toBe(3);
  });

  it('counts declaration-site parameters across languages (parameters / parameter_list kinds)', () => {
    // Pins the non-TS entries in PARAM_LIST_KINDS: Rust/Python use
    // `parameters`, Go uses `parameter_list`.
    const rust = `fn f(a: i32, b: i32, c: i32) -> i32 { a + b + c }`;
    expect(metricsFor(rust, 'rust', 1, 1).paramCount).toBe(3);
    const py = `def f(a, b, c):\n    return a`;
    expect(metricsFor(py, 'python', 1, 2).paramCount).toBe(3);
    const go = `package p\n\nfunc f(a int, b int, c int) int { return a }`;
    expect(metricsFor(go, 'go', 3, 3, 3, 0).paramCount).toBe(3);
  });

  it('skips `comment` nodes interleaved in the parameter list', () => {
    // Pins countNonCommentNamedChildren — the `/* x */` comment is a
    // named child of the parameter list but must not inflate the count.
    const src = `function f(
  a: number,
  /* x */ b: number
) { return a + b; }`;
    expect(metricsFor(src, 'typescript', 1, 4).paramCount).toBe(2);
  });

  it('does NOT count a CALL argument list inside the body as parameters', () => {
    // argument_list is deliberately excluded from PARAM_LIST_KINDS: the
    // 7-arg call must not make a 1-param function look like 7 params.
    const src = `function f(a: number) { return g(1, 2, 3, 4, 5, 6, 7); }`;
    expect(metricsFor(src, 'typescript', 1, 1).paramCount).toBe(1);
  });
});

describe('isMagicNumber (magic_number classifier)', () => {
  it('flags real magic literals', () => {
    expect(isMagicNumber('42')).toBe(true);
    expect(isMagicNumber('100')).toBe(true);
    expect(isMagicNumber('3.14')).toBe(true);
    expect(isMagicNumber('-7')).toBe(true);
  });

  it('strips underscore separators before classifying', () => {
    expect(isMagicNumber('1_000_000')).toBe(true);
  });

  it('keeps the universal trivial allow-list (0, 1, -1, 2) out of the count', () => {
    expect(isMagicNumber('0')).toBe(false);
    expect(isMagicNumber('1')).toBe(false);
    expect(isMagicNumber('-1')).toBe(false);
    expect(isMagicNumber('2')).toBe(false);
  });

  it('keeps the float forms of the trivial allow-list out (0.0, 1.0, -1.0)', () => {
    expect(isMagicNumber('0.0')).toBe(false);
    expect(isMagicNumber('1.0')).toBe(false);
    expect(isMagicNumber('-1.0')).toBe(false);
  });

  it('rejects the kind-overload case (TS `number` type identifier)', () => {
    expect(isMagicNumber('number')).toBe(false);
    expect(isMagicNumber('string')).toBe(false);
  });

  it('flags hex / binary / octal literals unconditionally', () => {
    expect(isMagicNumber('0xff')).toBe(true);
    expect(isMagicNumber('0b1010')).toBe(true);
    expect(isMagicNumber('0o755')).toBe(true);
  });

  it('flags UPPERCASE-prefixed hex / binary / octal (lowercased before matching)', () => {
    // `toLowerCase()` normalises the radix prefix; a `toUpperCase()`
    // mutant would leave `0X` unmatched by the `0[xbo]` class → false.
    expect(isMagicNumber('0XFF')).toBe(true);
    expect(isMagicNumber('0B1010')).toBe(true);
    expect(isMagicNumber('0O755')).toBe(true);
  });

  it('rejects identifier text with a digit NOT at the start (the `^` anchor guards kind-overload)', () => {
    // The leading `^` in the digit-prefix regex is load-bearing: an
    // un-anchored mutant would match the digit anywhere and flag these
    // identifier-shaped node texts as magic literals.
    expect(isMagicNumber('utf8')).toBe(false);
    expect(isMagicNumber('base64')).toBe(false);
    expect(isMagicNumber('sha256')).toBe(false);
    expect(isMagicNumber('count2')).toBe(false);
  });

  it('flags leading-dot floats (`.5`, `-.5`)', () => {
    expect(isMagicNumber('.5')).toBe(true);
    expect(isMagicNumber('-.5')).toBe(true);
  });

  it('Go allow-lists scale-factor constants but NOT in other languages', () => {
    expect(isMagicNumber('60', 'go')).toBe(false);
    expect(isMagicNumber('1024', 'go')).toBe(false);
    expect(isMagicNumber('86400', 'go')).toBe(false);
    expect(isMagicNumber('60', 'typescript')).toBe(true);
    expect(isMagicNumber('1024', 'python')).toBe(true);
  });

  it('Go: numbers outside the allow-list still flag', () => {
    expect(isMagicNumber('42', 'go')).toBe(true);
    expect(isMagicNumber('500', 'go')).toBe(true);
  });
});

describe('computeMetrics: literal tally (magic_number / hardcoded_url)', () => {
  it('counts body magic numbers, honouring the trivial allow-list', () => {
    // 42 and 100 flag; the literal 1 is allow-listed.
    const src = `function f(): number {
  const a = 42;
  const b = 100;
  const c = 1;
  return a + b + c;
}`;
    expect(metricsFor(src, 'typescript', 1, 6).magicNumberCount).toBe(2);
  });

  it('Go: applies the per-language scale-factor allow-list in the tally', () => {
    // 60 and 24 are Go-allow-listed; 42 is not → count 1.
    const src = `package p
func human(n int) int {
    a := n * 60
    b := n * 24
    c := n * 42
    return a + b + c
}`;
    expect(metricsFor(src, 'go', 2, 7, 2, 0).magicNumberCount).toBe(1);
  });

  it('TS: the same numbers all flag (no Go allow-list bleed)', () => {
    const src = `function human(n: number): number {
  const a = n * 60;
  const b = n * 24;
  const c = n * 42;
  return a + b + c;
}`;
    expect(metricsFor(src, 'typescript', 1, 6).magicNumberCount).toBe(3);
  });

  it('counts literal URLs but skips format-string templates', () => {
    const src = `function f(): void {
  const a = "https://example.com/api";
  const b = "http://%s";
}`;
    expect(metricsFor(src, 'typescript', 1, 4).hardcodedUrlCount).toBe(1);
  });
});

describe('evaluateRules: structural metric severity boundaries', () => {
  function sev(overrides: Record<string, number>, biomarker: string): string {
    const f = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics(overrides) }).find(
      (x) => x.biomarker === biomarker,
    );
    return f ? f.severity : 'NONE';
  }

  it('large_method: <100 none, 100-199 warning, >=200 error', () => {
    expect(sev({ loc: 99 }, 'large_method')).toBe('NONE');
    expect(sev({ loc: 100 }, 'large_method')).toBe('warning');
    expect(sev({ loc: 199 }, 'large_method')).toBe('warning');
    expect(sev({ loc: 200 }, 'large_method')).toBe('error');
  });

  it('complex_method: <15 none, 15-24 warning, >=25 error', () => {
    expect(sev({ cyclomatic: 14 }, 'complex_method')).toBe('NONE');
    expect(sev({ cyclomatic: 15 }, 'complex_method')).toBe('warning');
    expect(sev({ cyclomatic: 24 }, 'complex_method')).toBe('warning');
    expect(sev({ cyclomatic: 25 }, 'complex_method')).toBe('error');
  });

  it('nested_complexity: <5 none, 5-6 warning, >=7 error', () => {
    expect(sev({ maxNesting: 4 }, 'nested_complexity')).toBe('NONE');
    expect(sev({ maxNesting: 5 }, 'nested_complexity')).toBe('warning');
    expect(sev({ maxNesting: 6 }, 'nested_complexity')).toBe('warning');
    expect(sev({ maxNesting: 7 }, 'nested_complexity')).toBe('error');
  });

  it('complex_conditional: <6 none, 6-7 warning, >=8 error', () => {
    expect(sev({ maxConditionalOperands: 5 }, 'complex_conditional')).toBe('NONE');
    expect(sev({ maxConditionalOperands: 6 }, 'complex_conditional')).toBe('warning');
    expect(sev({ maxConditionalOperands: 7 }, 'complex_conditional')).toBe('warning');
    expect(sev({ maxConditionalOperands: 8 }, 'complex_conditional')).toBe('error');
  });

  it('long_parameter_list: <4 none, 4 info, 5-6 warning, >=7 error (info tier active)', () => {
    expect(sev({ paramCount: 3 }, 'long_parameter_list')).toBe('NONE');
    expect(sev({ paramCount: 4 }, 'long_parameter_list')).toBe('info');
    expect(sev({ paramCount: 5 }, 'long_parameter_list')).toBe('warning');
    expect(sev({ paramCount: 6 }, 'long_parameter_list')).toBe('warning');
    expect(sev({ paramCount: 7 }, 'long_parameter_list')).toBe('error');
  });

  it('magic_number: <3 none, 3-4 info, 5-7 warning, >=8 error (info tier active)', () => {
    expect(sev({ magicNumberCount: 2 }, 'magic_number')).toBe('NONE');
    expect(sev({ magicNumberCount: 3 }, 'magic_number')).toBe('info');
    expect(sev({ magicNumberCount: 4 }, 'magic_number')).toBe('info');
    expect(sev({ magicNumberCount: 5 }, 'magic_number')).toBe('warning');
    expect(sev({ magicNumberCount: 7 }, 'magic_number')).toBe('warning');
    expect(sev({ magicNumberCount: 8 }, 'magic_number')).toBe('error');
  });

  it('emits the raw metric value on the finding', () => {
    const f = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics({ loc: 250 }) }).find(
      (x) => x.biomarker === 'large_method',
    );
    expect(f!.metric).toBe(250);
  });

  it('emits hardcoded_url through evaluateRules when the URL count is non-zero', () => {
    // Pins the `if (url) out.push(url)` composite branch in evaluateRules.
    const f = evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics({ hardcodedUrlCount: 1 }) }).find(
      (x) => x.biomarker === 'hardcoded_url',
    );
    expect(f).toBeDefined();
    expect(f!.severity).toBe('info');
    expect(f!.metric).toBe(1);
  });
});

describe('evaluateRules: brain_method composite', () => {
  function brain(overrides: Record<string, number>): ReturnType<typeof evaluateRules>[number] | undefined {
    return evaluateRules({ nodeId: 'a', language: 'typescript', metrics: metrics(overrides) }).find(
      (x) => x.biomarker === 'brain_method',
    );
  }

  it('does NOT fire below the LOC gate (49) but fires at the gate (50) with enough density', () => {
    const dense = { cyclomatic: 25, maxNesting: 7, maxConditionalOperands: 8 };
    expect(brain({ loc: 49, ...dense })).toBeUndefined();
    expect(brain({ loc: 50, ...dense })!.severity).toBe('info');
  });

  it('does NOT fire below the cyclomatic gate (7) but fires at the gate (8)', () => {
    const big = { loc: 500, maxNesting: 5, maxConditionalOperands: 8 };
    expect(brain({ cyclomatic: 7, ...big })).toBeUndefined();
    expect(brain({ cyclomatic: 8, ...big })!.severity).toBe('warning');
  });

  it('score tiers: info >=5, warning >=10, error >=20', () => {
    // floor case (nest=1, cond=1): 2.0 × 2.5 × max(1,..) × max(1,..) = 5.0 → info
    const info = brain({ loc: 200, cyclomatic: 25, maxNesting: 1, maxConditionalOperands: 1 });
    expect(info!.severity).toBe('info');
    expect((info!.detail as { score: number }).score).toBe(5);
    // 2.0 × 2.5 × 1.667 × 2.0 = 16.7 → warning
    const warn = brain({ loc: 200, cyclomatic: 25, maxNesting: 5, maxConditionalOperands: 8 });
    expect(warn!.severity).toBe('warning');
    // 3.0 × 2.5 × 2.333 × 2.0 = 35 → error
    const err = brain({ loc: 300, cyclomatic: 25, maxNesting: 7, maxConditionalOperands: 8 });
    expect(err!.severity).toBe('error');
  });

  it('tier thresholds are inclusive (>=): a score EXACTLY at the boundary takes the higher tier', () => {
    // Pins the `>=` comparisons in brainMethodSeverity. Each combo is
    // tuned to land the composite score on an exact integer boundary.
    // 1.0 × 5.0 × 1 × 1 = 5.0  → info  (loc100, cyc50)
    expect(brain({ loc: 100, cyclomatic: 50, maxNesting: 1, maxConditionalOperands: 1 })!.severity).toBe('info');
    // 1.0 × 10.0 × 1 × 1 = 10.0 → warning (loc100, cyc100)
    expect(brain({ loc: 100, cyclomatic: 100, maxNesting: 1, maxConditionalOperands: 1 })!.severity).toBe('warning');
    // 1.0 × 20.0 × 1 × 1 = 20.0 → error (loc100, cyc200)
    expect(brain({ loc: 100, cyclomatic: 200, maxNesting: 1, maxConditionalOperands: 1 })!.severity).toBe('error');
  });

  it('emits NOTHING for a gated symbol whose composite score is below the info floor', () => {
    // loc50 + cyc8 pass BOTH gates, but 0.5 × 0.8 × 1 × 1 = 0.4 < 5.
    // brainMethodSeverity returns null → evaluateBrainMethod returns null.
    // A `severity` always-truthy or always-info mutant would wrongly emit.
    expect(brain({ loc: 50, cyclomatic: 8, maxNesting: 1, maxConditionalOperands: 1 })).toBeUndefined();
  });

  it('rounds the composite score to one decimal place on metric + detail', () => {
    const warn = brain({ loc: 200, cyclomatic: 25, maxNesting: 5, maxConditionalOperands: 8 });
    expect(warn!.metric).toBe(16.7);
    expect((warn!.detail as { score: number; loc: number; cyclomatic: number }).score).toBe(16.7);
    expect((warn!.detail as { loc: number }).loc).toBe(200);
    expect((warn!.detail as { cyclomatic: number }).cyclomatic).toBe(25);
  });

  it('the max(1,...) floors keep low nesting/conditional from depressing the LOC×CYC product', () => {
    // With nest=1, cond=1 both factors floor to 1.0; score = locFactor ×
    // cycFactor = 2.0 × 2.5 = 5.0 exactly. A multiplied (not floored)
    // form would shrink to ~0.4.
    const f = brain({ loc: 200, cyclomatic: 25, maxNesting: 1, maxConditionalOperands: 1 });
    expect((f!.detail as { score: number }).score).toBe(5);
  });

  it('inserts brain_method directly BEFORE long_parameter_list in the finding order', () => {
    const out = evaluateRules({
      nodeId: 'a',
      language: 'typescript',
      metrics: metrics({
        loc: 200,
        cyclomatic: 25,
        maxNesting: 5,
        maxConditionalOperands: 8,
        paramCount: 6,
        magicNumberCount: 8,
      }),
    }).map((f) => f.biomarker);
    expect(out).toEqual([
      'large_method',
      'complex_method',
      'nested_complexity',
      'complex_conditional',
      'brain_method',
      'long_parameter_list',
      'magic_number',
    ]);
  });

  it('appends brain_method at the end when there is no long_parameter_list anchor', () => {
    // insertAt === -1 path: only loc/cyc fire, no params → brain pushed last.
    const out = evaluateRules({
      nodeId: 'a',
      language: 'typescript',
      metrics: metrics({ loc: 200, cyclomatic: 25, maxNesting: 1, maxConditionalOperands: 1 }),
    }).map((f) => f.biomarker);
    expect(out).toContain('brain_method');
    expect(out.indexOf('brain_method')).toBe(out.length - 1);
    expect(out.includes('long_parameter_list')).toBe(false);
  });
});
