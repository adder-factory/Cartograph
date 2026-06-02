/**
 * `defineTool` — the Zod-backed `ToolModule` factory (structural
 * campaign P3).
 *
 * A tool authored through `defineTool` declares ONE Zod object schema.
 * That single schema is the source for:
 *
 *   1. the JSON-Schema `inputSchema` advertised in `tools/list`
 *      (generated via Zod 4's native `z.toJSONSchema`);
 *   2. the handler's argument TYPE (`z.infer<typeof schema>`) — no
 *      hand-written interface, no `args['x'] as string` casts;
 *   3. runtime validation at the dispatch boundary — the dispatcher
 *      `safeParse`s the raw args and only reaches the handler with a
 *      parsed, typed value;
 *   4. (later, P8) the commander CLI option list — see `_zod-to-cli.ts`.
 *
 * THE `__zodSchema` MARKER
 * ------------------------
 * A `defineTool` module is a normal `ToolModule` — same `definition`
 * + `handle` shape — so the registry, `tools/list`, and the freshness
 * gate treat it like any other module. The ONE addition is the
 * non-enumerable `zodSchema` marker (see {@link ZOD_SCHEMA_KEY}); the
 * dispatcher in `../tools.ts` reads it via {@link getZodSchema} to
 * recover the schema and `safeParse` the raw args before the handler
 * runs. Every tool is `defineTool`-backed (structural campaign P4);
 * the marker is what makes the schema discoverable at dispatch time.
 *
 * NUMERIC RANGE POLICY (locked decision)
 * --------------------------------------
 * Out-of-range numeric args are REJECTED, never clamped — both
 * sub-minimum and over-maximum. A tool author expresses the bound
 * with `z.number().int().min(a).max(b)`; `safeParse` enforces it and
 * the dispatcher returns a clean error. Handlers therefore never need
 * a defensive `clampInt()` on a Zod-validated numeric arg.
 */

import { z } from 'zod';
import type { ToolDefinition, ToolResult } from '../tool-types.js';
import type { ToolCtx, ToolModule } from './types.js';
import { type ToolOutcome, outcomeToResult } from './_outcome.js';
import { errorResult } from './_error-result.js';

/**
 * Any Zod object schema. The factory constrains tool schemas to
 * object roots — every MCP tool's `inputSchema` has `type: 'object'`,
 * and `z.toJSONSchema` of a `z.object(...)` produces exactly that.
 */
export type ToolZodSchema = z.ZodObject<z.ZodRawShape>;

/**
 * Property key under which a `defineTool` module stashes its Zod
 * schema. Non-enumerable so it never shows up in `Object.keys` /
 * spreads (the registry's `withAllowStale` spreads the module) — the
 * dispatcher reads it explicitly via {@link getZodSchema}.
 */
const ZOD_SCHEMA_KEY = '__zodSchema' as const;

/** Spec passed to {@link defineTool}. */
export interface DefineToolSpec<S extends ToolZodSchema> {
  /** Canonical tool name, e.g. `cartograph_discover`. */
  readonly name: string;
  /** Human/agent-facing description shown in `tools/list`. */
  readonly description: string;
  /**
   * The single Zod object schema. Generates the JSON inputSchema,
   * types the handler args, and (P8) drives the CLI option list. Use
   * `.describe()` on every field — the text flows straight into the
   * JSON-Schema `description` and the CLI `--help`.
   */
  readonly schema: S;
  /**
   * Handler — receives the PARSED, typed args (`z.infer<S>`), not the
   * raw `Record<string, unknown>`. Defaults applied, numbers coerced
   * to their declared shape, ranges already enforced.
   *
   * RETURN TYPE (structural campaign P6): a handler may return either
   *
   *   - a {@link ToolOutcome} — the typed `Result<Ok, Err>` arm
   *     (`ok(renderToolResponse(spec))` / `err('message')`). This is
   *     the migration target — a P6-converted handler can ONLY signal
   *     an error via the `err` arm because `errorResult` is no longer
   *     exported to handlers (it is adapter-private); or
   *   - a bare {@link ToolResult} — the legacy shape, kept so the P6
   *     wave can convert handlers one file at a time without a flag
   *     day. An unconverted handler keeps calling `errorResult` /
   *     `textResult` directly until its turn in the wave.
   *
   * The `defineTool` wrapper below normalises both: a `ToolOutcome`
   * is mapped through {@link outcomeToResult}; a bare `ToolResult`
   * passes straight through. {@link isToolOutcome} is the
   * discriminator.
   */
  readonly handle: (ctx: ToolCtx, args: z.infer<S>) => Promise<ToolResult | ToolOutcome> | ToolResult | ToolOutcome;
  /** Mirrors {@link ToolModule.bypassFreshnessGate}. */
  readonly bypassFreshnessGate?: boolean;
  /** Mirrors {@link ToolModule.isWriteTool}. */
  readonly isWriteTool?: boolean;
  /** Mirrors {@link ToolModule.readOnlyActions}. */
  readonly readOnlyActions?: ReadonlySet<string>;
  /** Mirrors {@link ToolModule.bypassSchemaGuard}. */
  readonly bypassSchemaGuard?: boolean;
}

/**
 * A `ToolModule` produced by {@link defineTool}. Structurally a plain
 * `ToolModule`; the extra `__zodSchema` key is non-enumerable so the
 * type carries it for `getZodSchema` without polluting iteration.
 */
export interface ZodToolModule extends ToolModule {
  readonly [ZOD_SCHEMA_KEY]: ToolZodSchema;
}

/**
 * Generate the MCP `inputSchema` from a Zod object schema.
 *
 * `z.toJSONSchema` (Zod 4 native) with `target: 'draft-7'` emits a
 * draft-07 document with a `$schema` banner and
 * `additionalProperties: false`. Both are stripped:
 *
 *  - `$schema` is metadata `ToolDefinition['inputSchema']` doesn't
 *    declare and `tools/list` consumers don't read.
 *  - `additionalProperties: false` would, if a strict client honoured
 *    it, reject the tracing / `_meta` keys MCP clients routinely
 *    attach. cartograph is deliberately permissive about unknown keys —
 *    the dispatch boundary only WARNS on them (see
 *    `_unknown-arg-warnings.ts`); dropping the `false` keeps the
 *    advertised schema consistent with that contract.
 *    Unknown-arg rejection is NOT desired at the JSON-Schema layer —
 *    `safeParse` already strips unknown keys for the handler.
 *
 * `z.toJSONSchema` inlines every sub-schema by default (a schema is
 * only `$ref`'d when reused via a registry, which tool schemas never
 * are), so the result is a flat object-root document — no `$ref` /
 * `definitions` block.
 */
export function toJsonSchema(schema: ToolZodSchema): ToolDefinition['inputSchema'] {
  const generated = z.toJSONSchema(schema, {
    target: 'draft-7',
  }) as Record<string, unknown>;
  delete generated['$schema'];
  delete generated['additionalProperties'];
  // `z.toJSONSchema` of a `z.object` always yields `type: 'object'`
  // with a `properties` map. Re-assert the shape for the type system.
  const properties = (generated['properties'] as ToolDefinition['inputSchema']['properties']) ?? {};
  const required = generated['required'] as string[] | undefined;
  return {
    type: 'object',
    properties,
    ...(required && required.length > 0 ? { required } : {}),
  };
}

/**
 * Discriminate a {@link ToolOutcome} from a bare `ToolResult`.
 *
 * A `ToolOutcome` carries a boolean `ok` tag; a `ToolResult` carries
 * a `content` array and no `ok` field. The presence of an `ok`
 * boolean is unambiguous — `ToolResult` has no such property — so a
 * single `typeof` check is a sound discriminator. Kept narrow on
 * purpose: it is the seam that lets converted and unconverted
 * handlers coexist during the P6 wave.
 */
function isToolOutcome(value: ToolResult | ToolOutcome): value is ToolOutcome {
  return typeof (value as { ok?: unknown }).ok === 'boolean';
}

/**
 * Definition-time validation for an MCP tool's input schema. Catches
 * two write-time footguns that would otherwise only surface at first
 * call (or never, when the bug is "agents see no doc and guess"):
 *
 *  1. **Every top-level field must carry a non-empty `.describe(...)`
 *     text.** That description is what calling agents see in the
 *     handshake-published JSON-Schema; a missing one ships a doc-less
 *     param, and the agent guesses the field's purpose from its name
 *     alone — or skips it.
 *  2. **Every top-level field name must be camelCase** (lowercase
 *     letter then letters / digits). A typo like `MaxNodes` would
 *     force callers to use the miscased name forever — there is no
 *     auto-correction at the JSON-Schema layer.
 *
 * Throws at module-load (when `defineTool` is called) so the bug
 * crashes import / tests instead of silently shipping a malformed
 * tool. Walks `inputSchema.properties` rather than `schema.shape` so
 * the check uses the SAME extraction mechanism that publishes the
 * agent-facing JSON-Schema — if validation passes, the published
 * schema is well-formed by construction.
 */
/**
 * Fields excluded from the consumed-args read assertion. These are
 * read by infrastructure outside the handler proper:
 *
 *  - `projectPath` is consumed by `ctx.getCartograph(args.projectPath)`
 *    in many handlers — but it's threaded by a helper, not always
 *    pulled directly from `parsed.data`. Many handlers ignore it
 *    intentionally when defaulting to the server's CWD project.
 *  - `allowStale` is the `withAllowStale` wrapper's freshness-gate
 *    knob (registry.ts), evaluated BEFORE the handler runs. The
 *    wrapper strips it before delegating; the inner handler never
 *    sees it.
 *
 * Trying to assert these would surface a false-positive on every
 * tool that doesn't override the default project / freshness path.
 */
const ARG_TRACKING_INFRASTRUCTURE_FIELDS: ReadonlySet<string> = new Set(['projectPath', 'allowStale']);

/** True when the consumed-args runtime tracker should run for this
 *  process. Default off — tests opt in via CARTOGRAPH_TRACK_CONSUMED_ARGS
 *  (set by every `test*` npm script); production never runs the
 *  tracker. (Was also keyed on VITEST pre-bun-migration; bun:test
 *  sets no equivalent marker so the npm-script env approach replaces
 *  it.) */
function isArgTrackingEnabled(): boolean {
  return process.env['CARTOGRAPH_TRACK_CONSUMED_ARGS'] === '1';
}

/**
 * Strict-mode toggle for the consumed-args tracker. When set, unread
 * provided args THROW (fail-closed); when unset, they emit a warning
 * to stderr (fail-open). The smoke-test framework
 * (`__tests__/tool-surface-smoke.test.ts`) synthesises args from each
 * tool's schema and passes every field with its default value — many
 * action-discriminated tools (cartograph_admin, cartograph_coverage)
 * legitimately read only a subset per action, so a default-mode
 * throw would false-positive on every smoke run. Targeted tests can
 * opt into strict mode by setting the env var before invoking.
 */
function isArgTrackingStrict(): boolean {
  return process.env['CARTOGRAPH_STRICT_UNREAD_ARGS'] === '1';
}

/** Wrap `data` in a Proxy that records every string-key property read
 *  into `tracked`. `has` (`'foo' in args`) and `getOwnPropertyDescriptor`
 *  also count — handlers test field presence both ways. */
function makeTrackedArgs<T extends object>(data: T, tracked: Set<string>): T {
  return new Proxy(data, {
    get(target, prop, receiver) {
      if (typeof prop === 'string') tracked.add(prop);
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      if (typeof prop === 'string') tracked.add(prop);
      return Reflect.has(target, prop);
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === 'string') tracked.add(prop);
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });
}

/**
 * After the handler returns, check every USER-PROVIDED field (one with
 * a non-undefined value in the raw input) was read at least once. If
 * any went unread, throw — that's the "field declared on the schema
 * but silently ignored by the handler" bug class (Friction #12, 2026-
 * 05-19 audit-B). Throwing makes the assertion test-time fatal so an
 * unwitting refactor that drops a `key`/`includeTests` thread-through
 * fails CI instead of shipping silently. Skips registered
 * infrastructure fields (`projectPath`, `allowStale`).
 */
function assertEveryProvidedArgWasRead(
  toolName: string,
  rawArgs: Record<string, unknown>,
  tracked: ReadonlySet<string>,
): void {
  const unread: string[] = [];
  for (const [key, value] of Object.entries(rawArgs)) {
    if (value === undefined) continue;
    if (ARG_TRACKING_INFRASTRUCTURE_FIELDS.has(key)) continue;
    if (tracked.has(key)) continue;
    unread.push(key);
  }
  if (unread.length === 0) return;
  const message =
    `Handler for \`${toolName}\` never read provided arg(s): ${unread.join(', ')}. ` +
    'Either thread them through the relevant code path or remove them from the Zod schema. ' +
    '(Structural fix E — consumed-args runtime tracker.)';
  if (isArgTrackingStrict()) {
    throw new Error(message);
  }
  // Fail-open by default: warn to stderr so the data surfaces in test
  // output and dev consoles without breaking the smoke-test suite,
  // which legitimately passes every field's default to an
  // action-discriminated tool. Opt into the strict throw by setting
  // CARTOGRAPH_STRICT_UNREAD_ARGS=1.
  process.stderr.write(`[consumed-args tracker] ${message}\n`);
}

function validateToolFieldShape(toolName: string, inputSchema: ToolDefinition['inputSchema']): void {
  const props = inputSchema.properties ?? {};
  const undescribed: string[] = [];
  const badCase: string[] = [];
  const CAMEL_CASE = /^[a-z][a-zA-Z0-9]*$/;
  for (const [key, prop] of Object.entries(props)) {
    if (!CAMEL_CASE.test(key)) badCase.push(key);
    const desc = (prop as { description?: unknown }).description;
    if (typeof desc !== 'string' || desc.trim() === '') undescribed.push(key);
  }
  const issues: string[] = [];
  if (badCase.length > 0) {
    issues.push(`non-camelCase field name(s): ${badCase.join(', ')}`);
  }
  if (undescribed.length > 0) {
    issues.push(
      `missing or empty .describe() on field(s): ${undescribed.join(', ')} — agents read these at handshake, so an undocumented field is invisible`,
    );
  }
  if (issues.length > 0) {
    throw new Error(`Tool \`${toolName}\` schema is malformed: ${issues.join('; ')}.`);
  }
}

/**
 * Build a `ToolModule` from a Zod-schema spec.
 *
 * The returned module is registered like any other (one import + one
 * `ENTRIES` row in `registry.ts`). The dispatcher detects the
 * `__zodSchema` marker and `safeParse`s the raw args; on a parse
 * failure it returns a formatted error (see {@link formatZodError});
 * on success the handler runs with the parsed, typed value.
 */
export function defineTool<S extends ToolZodSchema>(spec: DefineToolSpec<S>): ZodToolModule {
  // Sibling to `validateToolFieldShape` (which guards the per-field
  // describe/camelCase rules). The TOP-LEVEL `description` is what
  // calling agents read in `list_tools` to learn the tool's purpose;
  // an empty one ships a doc-less tool. Throw at module-load so the
  // omission can't reach the registry.
  if (typeof spec.description !== 'string' || spec.description.trim() === '') {
    throw new Error(
      `Tool \`${spec.name}\` is missing a non-empty top-level description — agents read this in \`list_tools\` to learn the tool's purpose.`,
    );
  }
  const inputSchema = toJsonSchema(spec.schema);
  validateToolFieldShape(spec.name, inputSchema);
  const definition: ToolDefinition = {
    name: spec.name,
    description: spec.description,
    inputSchema,
  };

  // The public `handle` still accepts a raw `Record<string, unknown>`
  // (the `ToolModule` contract). It re-parses defensively so the
  // module is correct even on the legacy dispatch path or via
  // `runHandler` (which bypasses `execute`'s validation). On the
  // normal `execute` path the dispatcher has already validated — the
  // re-parse is then a cheap idempotent pass over already-valid args.
  //
  // P6 ADAPTER — this is the single chokepoint that maps a typed
  // `ToolOutcome` back to a `ToolResult`. `errorResult` lives in its
  // own dispatch-layer module (`_error-result.ts`) — NOT in the
  // handler-facing `shared.ts` — so this adapter and the dispatcher
  // are its only callers. Both the `safeParse`-failure path AND a
  // converted handler's `err(...)` arm funnel through
  // `outcomeToResult` → `errorResult`, so every `isError: true` result
  // a Zod-backed tool can emit is produced in exactly this spot.
  const handle: ToolModule['handle'] = async (ctx, args) => {
    const parsed = spec.schema.safeParse(args ?? {});
    if (!parsed.success) {
      // The parse failure is itself an error arm — express it as one
      // so it shares the success/error adapter with handler outcomes.
      return outcomeToResult(
        { ok: false, error: `Invalid arguments for \`${spec.name}\`: ${formatZodError(parsed.error, args ?? {})}` },
        errorResult,
      );
    }
    // Structural fix E — consumed-args runtime tracker. Wrap the parsed
    // args in a Proxy that records every property read; after the
    // handler returns, fail (in test mode) if any user-provided field
    // went unread. Catches the bug class where a handler declares a
    // field on its Zod schema but only consumes it on one code path —
    // e.g. `env-refs.ts:141` silently dropping `includeTests` when the
    // caller also passed `key`. Off in production (env var must be set
    // or `VITEST` must be in process.env) to avoid steady-state cost.
    const trackingEnabled = isArgTrackingEnabled();
    const tracked = trackingEnabled ? new Set<string>() : null;
    const handlerArgs = trackingEnabled ? (makeTrackedArgs(parsed.data, tracked!) as typeof parsed.data) : parsed.data;
    const out = await spec.handle(ctx, handlerArgs);
    if (trackingEnabled) {
      assertEveryProvidedArgWasRead(spec.name, args ?? {}, tracked!);
    }
    // A handler may return the typed `ToolOutcome` (P6 target) or a
    // bare `ToolResult` (legacy, pre-conversion). Normalise both.
    return isToolOutcome(out) ? outcomeToResult(out, errorResult) : out;
  };

  const mod: ZodToolModule = {
    definition,
    handle,
    [ZOD_SCHEMA_KEY]: spec.schema,
    ...(spec.bypassFreshnessGate === undefined ? {} : { bypassFreshnessGate: spec.bypassFreshnessGate }),
    ...(spec.isWriteTool === undefined ? {} : { isWriteTool: spec.isWriteTool }),
    ...(spec.readOnlyActions === undefined ? {} : { readOnlyActions: spec.readOnlyActions }),
    ...(spec.bypassSchemaGuard === undefined ? {} : { bypassSchemaGuard: spec.bypassSchemaGuard }),
  };
  // Make the marker non-enumerable AFTER construction so the object
  // literal above can still set it. `registry.ts`'s `withAllowStale`
  // does `{ ...mod }` — a non-enumerable key survives that spread only
  // when re-attached, which `withAllowStale` is taught to do (it
  // re-runs through a Zod-aware wrapper). Defining it non-enumerable
  // keeps `Object.keys(mod)` / JSON.stringify clean for everything
  // else that introspects a module.
  Object.defineProperty(mod, ZOD_SCHEMA_KEY, {
    value: spec.schema,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return mod;
}

/**
 * Return the Zod schema a module was built with, or `undefined` if the
 * module carries no `__zodSchema` marker. The dispatcher in
 * `../tools.ts` calls this to recover the schema for `safeParse`
 * validation; every tool is `defineTool`-backed, so in practice the
 * result is always defined.
 */
export function getZodSchema(mod: ToolModule | undefined): ToolZodSchema | undefined {
  if (!mod) return undefined;
  const candidate = (mod as Partial<ZodToolModule>)[ZOD_SCHEMA_KEY];
  // A Zod schema is an object with a `safeParse` method.
  if (candidate && typeof (candidate as { safeParse?: unknown }).safeParse === 'function') {
    return candidate;
  }
  return undefined;
}

/**
 * Re-attach the non-enumerable `__zodSchema` marker to a module that
 * was shallow-cloned (e.g. `registry.ts`'s `withAllowStale` does
 * `{ ...mod }`, which drops non-enumerable keys). Pass the cloned
 * module and the schema from the original; returns the SAME object
 * (mutated) for call-site convenience. A no-op-safe call: if `schema`
 * is undefined the clone simply stays a legacy-looking module.
 */
export function reattachZodSchema<M extends ToolModule>(clone: M, schema: ToolZodSchema | undefined): M {
  if (!schema) return clone;
  Object.defineProperty(clone, ZOD_SCHEMA_KEY, {
    value: schema,
    enumerable: false,
    writable: false,
    configurable: true,
  });
  return clone;
}

/**
 * Format a `ZodError` into a single readable line — field name + the
 * problem — instead of Zod's raw multi-line issue dump.
 *
 * Examples:
 *   - `maxDepth: expected integer`
 *   - `maxDepth: must be ≤ 10`
 *   - `mode: must be one of 'a', 'b', 'c' (got "x")`
 *   - `query: required`
 *
 * Zod 4 issues no longer carry the received value (v3 did, via
 * `issue.received`). To keep the "expected X, received Y" / `(got "x")`
 * diagnostics an agent relies on, the caller may pass the raw args:
 * the formatter then resolves each issue's path against them to
 * recover what was actually sent. Omit `rawArgs` and those clauses
 * degrade gracefully (a wrong-type issue with no resolvable value is
 * reported as `required`).
 *
 * Multiple issues are joined with `; `. The wording stays terse and
 * uniform so an agent reading the error gets a one-line mental model.
 */
export function formatZodError(error: z.ZodError, rawArgs?: Record<string, unknown>): string {
  const parts = error.issues.map((issue) => formatIssue(issue, rawArgs));
  // De-dup — Zod can emit two issues for one field (e.g. type + range
  // on a union). Keep insertion order.
  const seen = new Set<string>();
  const unique = parts.filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });
  return unique.join('; ');
}

/** What the caller actually passed at an issue's path. */
interface ReceivedValue {
  /** True when the path resolved to a non-`undefined` value. */
  readonly present: boolean;
  /** The resolved value (meaningful only when `present`). */
  readonly value: unknown;
}

/**
 * Resolve the value the caller passed at a Zod issue's `path` against
 * the raw args. A missing `rawArgs`, or a path that runs off a
 * non-object, yields `{ present: false }` — the "we don't know what
 * was sent" state, which the message layer renders as `required`.
 */
function resolveReceived(
  path: ReadonlyArray<PropertyKey>,
  rawArgs: Record<string, unknown> | undefined,
): ReceivedValue {
  if (!rawArgs) return { present: false, value: undefined };
  let cur: unknown = rawArgs;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return { present: false, value: undefined };
    cur = (cur as Record<PropertyKey, unknown>)[seg];
  }
  return { present: cur !== undefined, value: cur };
}

/**
 * Name the runtime type of a received value the way Zod v3's
 * `issue.received` did — lowercase, with `null` / `array` / `nan`
 * called out so a numeric arg that failed to parse reads sensibly.
 */
function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && Number.isNaN(value)) return 'nan';
  return typeof value;
}

/** Render the dotted path of a Zod issue (`['a', 0, 'b']` → `a[0].b`). */
function issuePath(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) return '(root)';
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out.length === 0 ? String(seg) : `.${String(seg)}`;
  }
  return out;
}

/** Format one Zod issue as `<field>: <problem>`. */
function formatIssue(issue: z.core.$ZodIssue, rawArgs: Record<string, unknown> | undefined): string {
  const field = issuePath(issue.path);
  const received = resolveReceived(issue.path, rawArgs);
  return `${field}: ${describeIssue(issue, received)}`;
}

/**
 * Describe a `too_small` / `too_big` range-bound miss. `origin`
 * distinguishes a string-length / array-length bound from a numeric
 * one; `inclusive` picks the comparison glyph for the numeric case.
 */
function describeBoundsIssue(issue: z.core.$ZodIssueTooSmall | z.core.$ZodIssueTooBig): string {
  if (issue.code === 'too_small') {
    const bound = issue.minimum;
    if (issue.origin === 'string') return `must be at least ${bound} character(s)`;
    if (issue.origin === 'array') return `must have at least ${bound} item(s)`;
    return `must be ${issue.inclusive ? '≥' : '>'} ${bound}`;
  }
  const bound = issue.maximum;
  if (issue.origin === 'string') return `must be at most ${bound} character(s)`;
  if (issue.origin === 'array') return `must have at most ${bound} item(s)`;
  return `must be ${issue.inclusive ? '≤' : '<'} ${bound}`;
}

/**
 * Describe an `invalid_value` (Zod 4 enum / literal miss). `values` is
 * the allowed set. A missing required enum field also lands here (v3
 * reported it as an `invalid_type`); an absent received value is that
 * case and yields the plain `required` signal.
 */
function describeValueIssue(issue: z.core.$ZodIssueInvalidValue, received: ReceivedValue): string {
  if (!received.present) return 'required';
  const opts = issue.values.map((o) => `'${String(o)}'`).join(', ');
  return `must be one of ${opts} (got ${JSON.stringify(received.value)})`;
}

/**
 * Map a Zod issue to a compact, agent-readable problem clause.
 *
 * `received` carries what the caller actually passed at the issue's
 * path (see {@link resolveReceived}) — Zod 4 issues no longer include
 * it. A `present: false` received value means "nothing was sent
 * there", which is the signal that distinguishes a missing required
 * arg (`required`) from a wrong-typed one (`expected X, received Y`)
 * for the codes — `invalid_type`, `invalid_value` — that share.
 */
function describeIssue(issue: z.core.$ZodIssue, received: ReceivedValue): string {
  switch (issue.code) {
    case 'invalid_type':
      // A missing required arg and a wrong-typed arg share this code;
      // an absent received value is the missing-arg signal.
      // `expected: 'int'` covers a non-integer on a `z.number().int()`.
      if (!received.present) return 'required';
      return `expected ${issue.expected === 'int' ? 'integer' : issue.expected}, received ${describeType(received.value)}`;
    case 'invalid_value':
      return describeValueIssue(issue, received);
    case 'too_small':
    case 'too_big':
      return describeBoundsIssue(issue);
    case 'invalid_format':
      return `invalid string (${String(issue.format)})`;
    case 'not_multiple_of':
      return `must be a multiple of ${issue.divisor}`;
    case 'unrecognized_keys':
      return `unknown key(s): ${issue.keys.join(', ')}`;
    default:
      return issue.message;
  }
}
