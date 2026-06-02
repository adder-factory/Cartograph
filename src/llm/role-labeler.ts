/**
 * Universal weak-label role tagger.
 *
 * Snorkel-style labeling pipeline for the 7-class role taxonomy
 * (`business_logic` / `api_endpoint` / `util` / `data_model` /
 * `framework_glue` / `test_helper` / `unknown`). Each weak labeler is
 * a precision-favored rule that fires on a small, recognisable
 * pattern; the first matching rule wins (priority order encoded by
 * the rule list).
 *
 * Why not just `classifyByStructure`? That function only covers the
 * three cleanest classes (`test_helper`, `data_model`, `api_endpoint`)
 * — it returns `null` for the rest. The universal head needs labels
 * for `framework_glue` / `util` / `business_logic` too. This module
 * extends the cleanly-precise rules from `classifyByStructure` (path
 * conventions, kind matches, decorator/handler patterns) with rules
 * that infer the harder three classes from import-graph + name +
 * path heuristics.
 *
 * Rules return a `WeakLabel` with a confidence band:
 *   - `high`: structural certainty (kind/path/route extractor) —
 *     suitable for direct training without supervision.
 *   - `medium`: decorator/import/name-shape inference — solid for
 *     bulk training but worth dropping on a per-class basis if the
 *     class is rare and we have higher-quality signal elsewhere.
 *   - `low`: residue rules (catch-all for everything that didn't
 *     match a more specific rule). Use as background data only;
 *     prefer LLM-relabeling these for the universal head.
 *
 * For the universal head we train on `high` + `medium` only by
 * default; `low` rows are the residue that the offline LLM-labeling
 * pass relabels.
 */

import { classifyByStructure, API_PARAM_DECORATOR_RE } from './classifier.js';
import type { RoleLabel } from './classifier.js';

type LabelConfidence = 'high' | 'medium' | 'low';
type LabelSource =
  | 'structural' // classifyByStructure
  | 'decorator' // framework decorator match
  | 'name' // util-name pattern
  | 'path' // utils/ helpers/ lib/ path
  | 'class-suffix' // *Service / *Manager / *Repository class membership
  | 'residue'; // catch-all

export interface WeakLabel {
  role: RoleLabel;
  confidence: LabelConfidence;
  source: LabelSource;
  /** Free-form short tag — useful when debugging which rule fired. */
  rule: string;
}

/** Inputs every weak labeler can read. The shape is intentionally
 *  minimal so callers can pull the data with one SQL roundtrip per
 *  project. */
export interface LabelerInput {
  /** node_id from the cartograph DB. */
  nodeId: string;
  /** `function` / `method` / `class` / `interface` / `route` etc. */
  kind: string;
  /** Source path — `src/util/format.ts`, `tests/auth.test.py`, … */
  filePath: string;
  /** Display name. */
  name: string;
  /** Raw signature line if extracted. */
  signature: string | null;
  /** Names of decorators applied to this node (incoming `decorates`
   *  edges from decorator nodes). Empty for languages without
   *  decorators. */
  decorators: string[];
  /** Module names imported by the file the node lives in. Used to
   *  detect framework presence. Bare names (e.g. `express`,
   *  `@nestjs/common`, `fastapi`, `gin-gonic/gin`). */
  fileImports: string[];
}

// ─── Framework matching ─────────────────────────────────────────────

/** Module names whose presence in a file's imports strongly
 *  suggests "this file is a thin layer over the framework" (i.e.
 *  framework_glue territory). Match is by prefix to handle
 *  `@nestjs/common`, `@nestjs/core`, `express/router`, etc.
 *
 *  Exported for `getFrameworkImportFiles` in `db/queries-roles.ts`,
 *  which feeds the framework-import signal into the role classifier's
 *  LLM evidence block. */
export const FRAMEWORK_IMPORT_PREFIXES: readonly string[] = [
  // JS/TS web frameworks
  'express',
  'fastify',
  'koa',
  'hapi',
  '@nestjs/',
  'nestjs',
  // Frontend frameworks (component glue)
  'react',
  '@reactjs/',
  'vue',
  '@vue/',
  '@angular/',
  'svelte',
  'next',
  '@next/',
  'nuxt',
  // Python web frameworks
  'flask',
  'fastapi',
  'django',
  'starlette',
  'sanic',
  'tornado',
  // Go web frameworks
  'github.com/gin-gonic/gin',
  'github.com/labstack/echo',
  'github.com/gorilla/mux',
  'github.com/spf13/cobra',
  // Rust
  'actix_web',
  'actix-web',
  'axum',
  'rocket',
  'warp',
  'tide',
  // Ruby
  'sinatra',
  'rails',
  'rack',
  // Java/Kotlin
  'org.springframework',
  'jakarta.',
  'javax.',
  'io.micronaut',
  'io.quarkus',
  // .NET
  'Microsoft.AspNetCore',
];

/** Decorator names that put a symbol unambiguously in `framework_glue`.
 *  Note: route-emitting decorators (@Controller / @Get / @Post / @app.route)
 *  are NOT here — those are already captured as `kind === 'route'` by
 *  the route extractor and become `api_endpoint` via classifyByStructure. */
const FRAMEWORK_GLUE_DECORATORS: ReadonlySet<string> = new Set([
  // NestJS / Angular DI
  '@Injectable',
  '@Module',
  '@Inject',
  '@Component',
  '@Directive',
  '@Pipe',
  // Spring
  '@Service',
  '@Repository',
  '@Configuration',
  '@Bean',
  '@Autowired',
  '@RestController',
  // Django
  '@receiver',
  '@admin.register',
  // FastAPI / Pydantic dependency injection
  '@Depends',
]);

/** Class-method decorator regex matched against the start of the
 *  signature (Spring/NestJS class-level decorators sometimes leak
 *  into the signature when extracted). */
const FRAMEWORK_DECORATOR_SIG_RE =
  /@(?:Injectable|Module|Inject|Component|Directive|Pipe|Service|Repository|Configuration|Bean|Autowired|RestController|Controller|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\b/;

/** Decorator names that put a symbol unambiguously in `data_model`. */
const DATA_MODEL_DECORATORS: ReadonlySet<string> = new Set([
  // ORM / typeorm / Prisma
  '@Entity',
  '@Schema',
  '@Document',
  // Spring data
  '@Table',
  // Pydantic / dataclasses (Python — by convention `@dataclass`,
  // `@pydantic.BaseModel` shows up via inheritance not decorator)
  '@dataclass',
  '@pydantic_dataclass',
]);

// ─── Path patterns ──────────────────────────────────────────────────

/** Path conventions that strongly suggest `util` (cross-cutting code
 *  that exists to be imported, not to drive request flow). Path
 *  segment match — `utils/`, `helpers/`, `lib/`, etc. */
const UTIL_PATH_RE = /(?:^|\/)(?:utils?|helpers?|lib|libs|common|shared|misc)\//;

// ─── Name patterns ──────────────────────────────────────────────────

/** Function / method names that strongly suggest `util` — the verb
 *  describes a pure transform / parse / format / check, not a domain
 *  workflow. Anchored at start so e.g. `parseRequest` matches but
 *  `tryToParse` doesn't (that's a verb-then-verb business operation). */
const UTIL_NAME_PREFIX_PATTERNS: readonly RegExp[] = [
  /^format/,
  /^parse/,
  /^to/,
  /^from/,
  /^build/,
  /^make/,
  /^create/,
  /^new/,
  /^is/,
  /^has/,
  /^can/,
  /^should/,
  /^get/,
  /^extract/,
  /^compute/,
  /^calc/,
  /^calculate/,
  /^normali[sz]e/,
  /^sanitize/,
  /^validate/,
  /^escape/,
  /^encode/,
  /^decode/,
  /^stringify/,
  /^hash/,
  /^fingerprint/,
  /^sort/,
  /^filter/,
  /^map/,
  /^reduce/,
  /^merge/,
  /^clone/,
  /^deep[A-Z]/,
  /^shallow[A-Z]/,
  /^equals/,
  /^equal/,
  /^compare/,
];

function isUtilName(name: string): boolean {
  return UTIL_NAME_PREFIX_PATTERNS.some((pattern) => pattern.test(name));
}

/** Class name suffixes that imply `business_logic`. Caught after the
 *  decorator/structural rules so we don't shadow more-specific
 *  signals. */
const BUSINESS_CLASS_SUFFIX_PATTERNS: readonly RegExp[] = [
  /Service$/,
  /Manager$/,
  /UseCase$/,
  /Workflow$/,
  /Pipeline$/,
  /Handler$/,
  /Controller$/,
  /Processor$/,
  /Engine$/,
  /Coordinator$/,
];

function hasBusinessClassSuffix(name: string): boolean {
  return BUSINESS_CLASS_SUFFIX_PATTERNS.some((pattern) => pattern.test(name));
}

/** Function / method NAME prefixes that imply `business_logic` —
 *  orchestration / self-heal / migration / project-internal verbs
 *  that NLI consistently mislabels as `unknown` because the docstring
 *  alone (without surrounding code) doesn't read as "business logic"
 *  in the abstract.
 *
 *  Each entry matches a camelCase prefix followed by an uppercase
 *  letter — `applyFoo` matches, `applesAndOranges` does not. The
 *  `[A-Z]` anchor is what separates a verb-prefix from a substring
 *  collision (e.g. `eoFoo` matches but `videoEncoder` does not).
 *
 *  Captured prefixes:
 *   - `apply*`   — migration / self-heal applicators
 *                 (e.g. `applyExtractionLogicVersionHeal`, `applyRoleHeadHeal`)
 *   - `heal*`    — staleness self-healers
 *                 (e.g. `healStaleArtifacts`)
 *   - `migrate*` — runtime migration helpers (distinct from numbered
 *                 SQL migrations, which are file-scoped)
 *   - `restore*` — state restorers
 *                 (e.g. `restoreRolesFromAssignments`)
 *   - `cgRun*`   — cartograph-internal orchestration entry points
 *                 (e.g. `cgRunIndexUnderLock`)
 *   - `eo*`      — extraction-orchestrator-internal verbs
 *                 (e.g. `eoRunParseOrCached`, `eoProcessOneFile`)
 *
 *  Closes friction items F-J / F-L (role classifier returning `unknown`
 *  for clear orchestration / self-heal logic). The rule fires on both
 *  `function` and `method` kinds — these prefixes appear on free
 *  functions AND on class methods. */
const BUSINESS_NAME_PREFIX_RE = /^(?:apply|heal|migrate|restore|cgRun|eo|run)[A-Z]/;

// ─── Weak labelers ──────────────────────────────────────────────────

type WeakLabeler = (input: LabelerInput) => WeakLabel | null;

/** Rule order matters — first match wins. High-precision /
 *  high-confidence rules run before low-confidence residue rules. */
const RULES: ReadonlyArray<readonly [string, WeakLabeler]> = [
  // 1. Structural: classifyByStructure already encodes the clean
  //    high-precision wins (test path → test_helper, kind=interface
  //    → data_model, kind=route → api_endpoint, etc.). Lift its
  //    answer with `high` confidence.
  [
    'structural-pre-filter',
    (i) => {
      const r = classifyByStructure({ kind: i.kind, filePath: i.filePath, signature: i.signature });
      if (!r) return null;
      return { role: r, confidence: 'high', source: 'structural', rule: 'classifyByStructure' };
    },
  ],

  // 2. Decorator-driven data_model (must beat decorator-driven
  //    framework_glue since some decorators co-occur).
  [
    'decorator-data-model',
    (i) => {
      if (!i.decorators.length) return null;
      if (i.decorators.some((d) => DATA_MODEL_DECORATORS.has(d))) {
        return { role: 'data_model', confidence: 'high', source: 'decorator', rule: 'data-model decorator' };
      }
      return null;
    },
  ],

  // 3. Decorator-driven framework_glue (DI / lifecycle / config).
  [
    'decorator-framework-glue',
    (i) => {
      if (!i.decorators.length) return null;
      if (i.decorators.some((d) => FRAMEWORK_GLUE_DECORATORS.has(d))) {
        return { role: 'framework_glue', confidence: 'high', source: 'decorator', rule: 'framework-glue decorator' };
      }
      return null;
    },
  ],

  // 4. Path-based util: `src/utils/`, `lib/`, etc. AND a util-name
  //    shape. Either alone is too noisy (e.g. `src/utils/auth.ts`
  //    can hold real business logic; a method `format` on a domain
  //    class is not a util). Both together is high-precision.
  [
    'util-path-and-name',
    (i) => {
      if (!UTIL_PATH_RE.test(i.filePath)) return null;
      if (!isUtilName(i.name)) return null;
      if (i.kind !== 'function' && i.kind !== 'method') return null;
      return { role: 'util', confidence: 'high', source: 'path', rule: 'util path + verb name' };
    },
  ],

  // 5/6. Path-only / name-only util rules deliberately excluded —
  //      either signal alone is too noisy (a `lib/auth.ts` can hold
  //      real business logic; a method `format` on a domain class is
  //      not a util). Both together (rule 4 above) is the only
  //      precision-positive util signal. Residue util cases get
  //      relabeled by the LLM-residue pass when configured.

  // 7. Signature carries parameter decorators (NestJS @Body / @Param,
  //    Spring @RequestParam, FastAPI Depends, etc.) — caller is a
  //    request handler. The route extractor catches the canonical
  //    cases via kind=route; this rule catches the rest where the
  //    handler is a regular method but the signature still carries
  //    handler-shaped decorators.
  [
    'signature-api-decorator',
    (i) => {
      if (i.kind !== 'function' && i.kind !== 'method') return null;
      if (!i.signature) return null;
      if (API_PARAM_DECORATOR_RE.test(i.signature)) {
        return {
          role: 'api_endpoint',
          confidence: 'medium',
          source: 'decorator',
          rule: 'API param decorator in signature',
        };
      }
      return null;
    },
  ],

  // 8. Signature carries framework class-level decorators that the
  //    route extractor wouldn't have caught (DI / lifecycle
  //    annotations). Spring extractor sometimes leaks these into the
  //    signature line; NestJS / Angular ditto.
  [
    'signature-framework-decorator',
    (i) => {
      if (i.kind !== 'class' && i.kind !== 'method' && i.kind !== 'function') return null;
      if (!i.signature) return null;
      if (FRAMEWORK_DECORATOR_SIG_RE.test(i.signature)) {
        return {
          role: 'framework_glue',
          confidence: 'medium',
          source: 'decorator',
          rule: 'framework decorator in signature',
        };
      }
      return null;
    },
  ],

  // 8b. Business-name prefix: function/method names like
  //     `applyExtractionLogicVersionHeal`, `eoRunParseOrCached`,
  //     `healStaleArtifacts`, `restoreRolesFromAssignments`,
  //     `cgRunIndexUnderLock`, etc. These are project-internal
  //     orchestration / self-heal verbs that NLI consistently labels
  //     as `unknown` (the docstring alone reads as too generic to
  //     classify). Fires BEFORE the framework-import-glue rule so a
  //     business-named function in a file that happens to import a
  //     framework still lands in business_logic. Friction F-J / F-L.
  [
    'business-name-prefix',
    (i) => {
      if (i.kind !== 'function' && i.kind !== 'method') return null;
      if (!BUSINESS_NAME_PREFIX_RE.test(i.name)) return null;
      return { role: 'business_logic', confidence: 'medium', source: 'name', rule: 'business name prefix' };
    },
  ],

  // 9. Framework-import-driven framework_glue: top-level functions
  //    and methods in a file that imports a framework, AND that
  //    don't carry a route signature, AND aren't already labeled as
  //    util / data_model. Heuristic: if you're inside a file that
  //    pulls in `express` / `@nestjs/common` etc. and you're not the
  //    handler, you're plumbing. Stays `low` because real repos put
  //    plenty of business logic in framework-importing files.
  [
    'framework-import-glue',
    (i) => {
      if (i.kind !== 'function' && i.kind !== 'method' && i.kind !== 'class') return null;
      if (!hasFrameworkImport(i.fileImports)) return null;
      return { role: 'framework_glue', confidence: 'low', source: 'name', rule: 'framework-import-bearing file' };
    },
  ],

  // 8. Class-suffix business_logic: classes named `*Service`,
  //    `*Manager`, `*UseCase` — domain-driven design conventions.
  //    Methods within don't auto-inherit (we want per-method labels
  //    so e.g. an internal helper method on a Service can be a util).
  [
    'class-suffix-business',
    (i) => {
      if (i.kind !== 'class') return null;
      if (!hasBusinessClassSuffix(i.name)) return null;
      return { role: 'business_logic', confidence: 'medium', source: 'class-suffix', rule: 'DDD class suffix' };
    },
  ],

  // 9. Method on a *Service / *Manager / *UseCase class →
  //    business_logic by association. (We can't tell the parent
  //    class from `LabelerInput` alone — that's a separate edge
  //    join — so this rule is split out and called by the runner
  //    when `parentClassName` is known.) See {@link labelMethodWithParent}
  //    for the runner-side hookup.

  // 10. Residue: anything function / method left unlabeled. Mark
  //     low-confidence business_logic so the LLM-relabel pass has
  //     a default to override.
  [
    'residue-business',
    (i) => {
      if (i.kind !== 'function' && i.kind !== 'method') return null;
      return { role: 'business_logic', confidence: 'low', source: 'residue', rule: 'residue function/method' };
    },
  ],
];

/** Public entry point — apply rules in priority order, return the
 *  first match. Returns `null` only when no rule fires (e.g. for
 *  kinds we never label like `import`, `module`, `parameter`). */
export function labelSymbol(input: LabelerInput): WeakLabel | null {
  for (const [, rule] of RULES) {
    const out = rule(input);
    if (out) return out;
  }
  return null;
}

/** Specialised entry for class-method nodes when the parent class
 *  name is available — boosts coverage on the `business_logic`
 *  class. Order: try {@link labelSymbol} first; if it returns
 *  residue-business, upgrade to medium when the parent class name
 *  matches a DDD suffix. */
export function labelMethodWithParent(input: LabelerInput, parentClassName: string | null): WeakLabel | null {
  const base = labelSymbol(input);
  if (!base) return null;
  if (input.kind !== 'method') return base;
  if (!parentClassName) return base;
  if (base.confidence === 'high') return base; // don't overwrite high-precision signal
  if (hasBusinessClassSuffix(parentClassName)) {
    return {
      role: 'business_logic',
      confidence: 'medium',
      source: 'class-suffix',
      rule: `method of ${parentClassName}`,
    };
  }
  return base;
}

function hasFrameworkImport(fileImports: ReadonlyArray<string>): boolean {
  for (const m of fileImports) {
    for (const prefix of FRAMEWORK_IMPORT_PREFIXES) {
      if (m === prefix || m.startsWith(prefix)) return true;
    }
  }
  return false;
}
