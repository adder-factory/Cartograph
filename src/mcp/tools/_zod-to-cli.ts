/**
 * `zodSchemaToCliOptions` — derive the commander option descriptors
 * for a tool from its Zod object schema (structural campaign P3; the
 * introspection rewrite is backlog item B5, 2026-05-19).
 *
 * A `defineTool` module declares one Zod schema. P8 wired the
 * commander command for each generatable tool off that same schema so
 * the CLI surface cannot drift from the MCP surface (the
 * `cli-mcp-alignment` arg-shape parity test enforces the mirror). This
 * module is the PURE DATA half of that wiring: it emits one
 * {@link CliOptionSpec} per schema field. It does NOT touch commander
 * — `src/bin/_command-generator.ts` (the production caller) maps the
 * specs onto `program.command(...).option(...)`.
 *
 * HOW IT INTROSPECTS (B5)
 * -----------------------
 * It does NOT hand-walk Zod's internal `.def` layout. It calls the
 * public, stable `z.toJSONSchema(schema, { io: 'input' })` and walks
 * the resulting JSON Schema — `properties` / `type` / `enum` /
 * `minimum` / `maximum` / `items` / `default` / `required` /
 * `description`. `io: 'input'` is the type a CALLER passes: a
 * `.default()` field is non-`required` and carries its `default`, and
 * a `z.preprocess(...)` field resolves to its post-transform shape
 * (so `cartograph_sql`'s bare-string-or-array `tables` arrives as a
 * plain `array`). The pre-B5 code walked `.def` / `._zod.def`
 * internals, which is exactly what broke in the Zod v3→v4 migration.
 *
 * Kept pure (no commander import, no side effects) so it is trivially
 * unit-testable and reusable for a `--help` doc generator.
 *
 * MAPPING RULES
 * -------------
 *  - Field name → kebab-case long flag (`maxDepth` → `--max-depth`).
 *  - `description` → the option description (empty string when a field
 *    has no `.describe()` — P8 should treat that as a lint miss).
 *  - JSON Schema `type` → `kind`: `string` / `boolean` / `array`
 *    (→ `string-list`); `integer` / `number` → `kind: 'number'`,
 *    `integer` also sets `isInt`. A field carrying `enum` → `kind: 'enum'`.
 *  - `minimum` / `maximum` on a number → `min` / `max` (the locked
 *    reject-out-of-range bounds — P8's parser surfaces them).
 *  - A field NOT in the schema's `required` array → `required: false`;
 *    `default` (when present) is captured in `defaultValue`.
 *  - `boolean` fields become commander FLAGS (no value); everything
 *    else takes a value (`--flag <value>`).
 *
 * Unsupported shapes (array-of-object, a union with a non-scalar
 * member) throw — the intent is that tool schemas stay CLI-expressible;
 * a richer type is a signal to reconsider the CLI shape, not to
 * silently drop the option.
 */

import { z } from 'zod';
import type { ToolZodSchema } from './_define-tool.js';

/**
 * The CLI-expressible leaf kinds.
 *
 *  - `string` / `number` / `boolean` / `enum` — scalar leaves (P3).
 *  - `string-list` (P8) — a `z.array(z.string())` / `z.array(z.enum(...))`
 *    field. Commander registers it as a VARIADIC option
 *    (`--symbols <names...>`); the generator collects the repeated
 *    tokens into an array before forwarding to `runViaMCP`.
 */
type CliOptionKind = 'string' | 'number' | 'boolean' | 'enum' | 'string-list';

/** One commander option, derived from one Zod object field. */
export interface CliOptionSpec {
  /** Original Zod field name (camelCase), e.g. `maxDepth`. */
  readonly name: string;
  /** Long flag in kebab-case, e.g. `--max-depth`. */
  readonly flag: string;
  /** `.describe()` text, or `''` when the field has none. */
  readonly description: string;
  /** CLI option kind. */
  readonly kind: CliOptionKind;
  /** True when the field is `required` (no `.optional()` / `.default()`). */
  readonly required: boolean;
  /** `.default(...)` value when declared, else `undefined`. */
  readonly defaultValue?: unknown;
  /** For `kind: 'number'` — true when the schema has `.int()`. */
  readonly isInt?: boolean;
  /** For `kind: 'number'` — inclusive lower bound from `.min()`. */
  readonly min?: number;
  /** For `kind: 'number'` — inclusive upper bound from `.max()`. */
  readonly max?: number;
  /** For `kind: 'enum'` — the allowed values. */
  readonly choices?: readonly string[];
  /**
   * True for a boolean field — commander should register it as a
   * value-less flag (`--verbose`) rather than `--verbose <value>`.
   */
  readonly isFlag: boolean;
  /**
   * True for `kind: 'string-list'` — commander registers a VARIADIC
   * value option (`--symbols <names...>`). The generator forwards the
   * collected token array straight through to `runViaMCP`.
   */
  readonly isVariadic?: boolean;
  /**
   * True for a boolean field that carries a `.default(true)` — the
   * CLI mirror is the NEGATING form (`--no-<flag>`), because a flag
   * whose default is already `true` is only meaningful as an opt-OUT
   * (`graph`'s `--no-compact`, `compare-to-ref`'s
   * `--no-suppress-line-range-only`). The generator registers the
   * `--no-<flag>` / `--<flag>` negatable pair and uses commander's
   * `getOptionValueSource` so "user passed nothing" stays distinct
   * from the schema default — only an explicit pass is forwarded.
   *
   * A boolean with `.default(false)` or no default keeps the plain
   * opt-IN `--<flag>` form (`isNegated` stays `false`).
   */
  readonly isNegated?: boolean;
}

/**
 * The CLI shape of a whole tool — what {@link buildGeneratedCommand}
 * (in `bin/cartograph.ts`) consumes.
 *
 * `discriminator` is the family-tool axis field (`action` / `mode` /
 * `by` / `direction`): a `z.enum` field whose name is one of the
 * recognised discriminator names. When present, the CLI mirror
 * exposes it either as a `--<name> <value>` flag (the
 * coverage/biomarkers/find/graph style) or as nested subcommands
 * (the admin/summaries/review/session style) — that choice is the
 * generator's, not this module's. `options` always contains EVERY
 * field including the discriminator, so a flag-style family command
 * gets it for free; a subcommand-style family command filters it out.
 */
export interface CommandSpec {
  /** Every field as a {@link CliOptionSpec}, declaration order. */
  readonly options: readonly CliOptionSpec[];
  /** The family discriminator spec, or `undefined` for a flat tool. */
  readonly discriminator?: CliOptionSpec;
}

/**
 * Field names recognised as a family-tool discriminator. A `z.enum`
 * field with one of these names becomes {@link CommandSpec.discriminator}.
 * Mirrors the `action` / `mode` set the `cli-mcp-alignment` test
 * already keys on, plus the `find`/`graph` axis fields (`by` /
 * `direction`) the alignment memo documents.
 */
export const DISCRIMINATOR_FIELD_NAMES: readonly string[] = ['action', 'mode', 'by', 'direction'];

/** camelCase → kebab-case (`maxDepth` → `max-depth`, `projectPath` → `project-path`). */
export function toKebabCase(name: string): string {
  return (
    name
      // Boundary between a lower/digit and an upper: insert a hyphen.
      .replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2')
      // Boundary inside an acronym run followed by a normal word
      // (`HTTPServer` → `HTTP-Server`).
      .replaceAll(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
      .toLowerCase()
  );
}

/**
 * The minimal slice of a JSON Schema property node this module reads.
 * `z.toJSONSchema` emits a much richer document; these are the only
 * keys the CLI mapping needs.
 */
interface JsonProp {
  readonly type?: string | readonly string[];
  readonly enum?: readonly unknown[];
  readonly description?: string;
  readonly default?: unknown;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly items?: JsonProp;
  readonly anyOf?: readonly JsonProp[];
}

/** The object-schema slice — `z.toJSONSchema` of a `z.object(...)`. */
interface JsonObjectSchema {
  readonly properties?: Record<string, JsonProp>;
  readonly required?: readonly string[];
}

/**
 * Walk a tool's Zod object schema and produce one {@link CliOptionSpec}
 * per field. Field order matches the schema's declaration order.
 *
 * @throws if a field is not CLI-expressible (an array of objects, a
 *   union with a non-scalar member, an otherwise un-typed property).
 *   A thrown error is a loud "this tool's schema is not CLI-mirrorable
 *   as-is" signal rather than a silent drop.
 */
export function zodSchemaToCliOptions(schema: ToolZodSchema): CliOptionSpec[] {
  // `io: 'input'` — the JSON Schema of the type a CALLER passes: a
  // `.default()` field is non-`required` and carries `default`; a
  // `z.preprocess` field resolves to its post-transform shape. (The
  // `io: 'output'` form would mark every defaulted field `required`.)
  const json = z.toJSONSchema(schema, { io: 'input' }) as JsonObjectSchema;
  const required = new Set(json.required ?? []);
  return Object.entries(json.properties ?? {}).map(([name, prop]) =>
    jsonPropToCliOption(name, prop, required.has(name)),
  );
}

/** Map one JSON Schema property to a {@link CliOptionSpec}. */
function jsonPropToCliOption(name: string, prop: JsonProp, required: boolean): CliOptionSpec {
  return {
    name,
    flag: `--${toKebabCase(name)}`,
    description: prop.description ?? '',
    required,
    ...(prop.default === undefined ? {} : { defaultValue: prop.default }),
    ...resolveKind(name, prop),
  };
}

/** The kind-specific slice of a {@link CliOptionSpec}. */
type KindSlice = Pick<CliOptionSpec, 'kind' | 'isFlag'> &
  Partial<Pick<CliOptionSpec, 'isInt' | 'min' | 'max' | 'choices' | 'isVariadic' | 'isNegated'>>;

/**
 * Classify a JSON Schema property into its {@link CliOptionKind} plus
 * the kind-specific fields. `isNegated` reads the ORIGINAL `prop`'s
 * `default` (a `.default(true)` boolean → opt-OUT `--no-<flag>`).
 */
function resolveKind(name: string, prop: JsonProp): KindSlice {
  // Peel a nullable wrapper: `z.X().nullable()` renders either as an
  // `anyOf` with a `{type:'null'}` member or a `type: [...,'null']`
  // array. Null is irrelevant on the CLI — a flag is passed or not.
  const eff = stripNull(prop);

  // An enum field (`z.enum`) carries `enum` alongside `type:'string'` —
  // check it before the plain-string branch.
  if (Array.isArray(eff.enum)) {
    return { kind: 'enum', isFlag: false, choices: eff.enum.map(String) };
  }
  const type = typeof eff.type === 'string' ? eff.type : undefined;
  switch (type) {
    case 'boolean':
      return { kind: 'boolean', isFlag: true, ...(prop.default === true ? { isNegated: true } : {}) };
    case 'integer':
      return { kind: 'number', isFlag: false, isInt: true, ...numBounds(eff) };
    case 'number':
      return { kind: 'number', isFlag: false, ...numBounds(eff) };
    case 'string':
      return { kind: 'string', isFlag: false };
    case 'array':
      return { kind: 'string-list', isFlag: false, isVariadic: true, ...arrayChoices(name, eff) };
  }
  // A `z.union([z.string(), z.number()])` field (e.g. `changed-since`'s
  // `since`) renders as `anyOf` with no top-level `type`. Every CLI arg
  // arrives as a string, so the mirror is a plain `--flag <value>`
  // string option — the MCP schema does the string-or-number
  // discrimination. Reject a union with a non-scalar member.
  if (Array.isArray(eff.anyOf)) {
    assertUnionCliExpressible(name, eff.anyOf);
    return { kind: 'string', isFlag: false };
  }
  throw new Error(
    `zodSchemaToCliOptions: field \`${name}\` has a JSON Schema shape that is ` +
      `not CLI-expressible (${JSON.stringify(prop).slice(0, 120)}). Supported: ` +
      `string, number, boolean, enum, string array, string|number union. ` +
      `Reconsider this tool's CLI shape or scope this field out of the CLI mirror.`,
  );
}

/**
 * Resolve a nullable wrapper to the representable inner shape.
 * `z.X().nullable()` is either `anyOf` with a `{type:'null'}` member
 * or `type: [<type>, 'null']`. A genuine multi-member union (no null,
 * or >1 non-null member) is returned unchanged for the `anyOf` branch.
 */
function stripNull(prop: JsonProp): JsonProp {
  if (Array.isArray(prop.type)) {
    const nonNull = prop.type.filter((t) => t !== 'null');
    if (nonNull.length === 1) return { ...prop, type: nonNull[0] };
  }
  if (Array.isArray(prop.anyOf)) {
    const nonNull = prop.anyOf.filter((m) => m.type !== 'null');
    // Exactly one real member → a nullable wrapper; unwrap to it.
    if (nonNull.length === 1) return { ...prop, ...nonNull[0], anyOf: undefined };
    // Some (but not all) members were null → keep the trimmed union.
    if (nonNull.length !== prop.anyOf.length) return { ...prop, anyOf: nonNull };
  }
  return prop;
}

/** `minimum` / `maximum` → `min` / `max`, each omitted when absent. */
function numBounds(prop: JsonProp): Partial<Pick<CliOptionSpec, 'min' | 'max'>> {
  return {
    ...(typeof prop.minimum === 'number' ? { min: prop.minimum } : {}),
    ...(typeof prop.maximum === 'number' ? { max: prop.maximum } : {}),
  };
}

/** True when a JSON Schema property is a string-coercible scalar —
 *  usable as a `string-list` element or a union member. */
function isStringLike(prop: JsonProp): boolean {
  if (Array.isArray(prop.enum)) return true;
  const type = typeof prop.type === 'string' ? prop.type : undefined;
  return type === 'string' || type === 'integer' || type === 'number';
}

/**
 * The `choices` slice for an `array` field. The element type must be a
 * string-like scalar; an `enum` element surfaces its values so the CLI
 * `--help` can list them.
 *
 * @throws if the element is not CLI-expressible (e.g. an array of
 *   objects — `at-range`'s `ranges`).
 */
function arrayChoices(name: string, prop: JsonProp): Partial<Pick<CliOptionSpec, 'choices'>> {
  const items = prop.items ? stripNull(prop.items) : undefined;
  if (!items || !isStringLike(items)) {
    throw new Error(
      `zodSchemaToCliOptions: field \`${name}\` is an array whose elements are not ` +
        `CLI-expressible (must be string / number / enum). Scope this field out of ` +
        `the CLI mirror or reshape it.`,
    );
  }
  return Array.isArray(items.enum) ? { choices: items.enum.map(String) } : {};
}

/**
 * Assert every member of an `anyOf` union is a string-coercible scalar.
 * A union with an object / array member has no flag form.
 */
function assertUnionCliExpressible(name: string, members: readonly JsonProp[]): void {
  for (const member of members) {
    if (!isStringLike(stripNull(member))) {
      throw new Error(
        `zodSchemaToCliOptions: field \`${name}\` is a union with a non-scalar member ` +
          `(${JSON.stringify(member).slice(0, 80)}), which is not CLI-expressible ` +
          `(union members must be string / number / enum). Scope this field out of ` +
          `the CLI mirror or reshape it.`,
      );
    }
  }
}

/**
 * Build a {@link CommandSpec} for a whole tool — its full option list
 * plus the family discriminator (if any).
 *
 * This is the P8 family-tool extension: where {@link zodSchemaToCliOptions}
 * is the flat per-field mapper, this wraps it and additionally locates
 * the family axis. {@link buildGeneratedCommand} in `bin/cartograph.ts`
 * uses `discriminator` to decide between a `--<name> <value>` flag and
 * a nested subcommand tree.
 */
export function zodSchemaToCommandSpec(schema: ToolZodSchema): CommandSpec {
  const options = zodSchemaToCliOptions(schema);
  const discriminator = options.find((o) => o.kind === 'enum' && DISCRIMINATOR_FIELD_NAMES.includes(o.name));
  return { options, ...(discriminator ? { discriminator } : {}) };
}
