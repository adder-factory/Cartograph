/**
 * `buildGeneratedCommand` — derive a commander `Command` for a
 * Zod-backed MCP tool straight from its schema (structural campaign
 * P8).
 *
 * THE PROBLEM (campaign friction category 3)
 * ------------------------------------------
 * `bin/cartograph.ts` hand-declares every command's commander
 * `.option(...)` list, separately from the MCP tool's Zod schema. The
 * two surfaces drift — an audit found `module` missing `--limit`,
 * `graph` missing `--since` / `--compact`, etc. — and the
 * `cli-mcp-alignment` test only checked command *existence*, not
 * argument shape.
 *
 * THE FIX
 * -------
 * For a thin `runViaMCP` shim command — one that only forwards parsed
 * args to a tool — the commander options can be GENERATED from the
 * same Zod schema that produces the MCP `inputSchema`. Parity by
 * construction: there is one declaration, not two.
 *
 *   {@link zodSchemaToCommandSpec}  (pure, `_zod-to-cli.ts`)
 *      → option specs + the family discriminator
 *   {@link buildGeneratedCommand}   (this module)
 *      → a commander `Command` whose `.action()` coerces CLI strings
 *        to the schema's types and calls the injected `runViaMCP`.
 *
 * COERCION (CLI-input-layer concern only)
 * ---------------------------------------
 * Every CLI argument arrives as a string. The MCP tool's own Zod
 * schema stays plain `z.number()` — it never sees a raw CLI string.
 * This module owns the string→type conversion: it builds a
 * CLI-LOCAL `z.coerce`-based schema (`z.coerce.number().int()...`)
 * from the same {@link CliOptionSpec}s, parses the collected option
 * values through it, and forwards the typed result. An out-of-range
 * or non-numeric value is rejected here with a clean CLI error,
 * before `runViaMCP` is ever reached — the MCP layer would reject it
 * too, but the CLI surfaces a `✗ ...` message and a non-zero exit
 * rather than a raw MCP error envelope.
 *
 * SCOPE
 * -----
 * P8 ships this machinery + a 2-3 command proof-of-concept. The bulk
 * conversion of the remaining `runViaMCP` shims is the P8 wave.
 * Hand-written direct-implementation commands (status / files /
 * affected / admin lifecycle / embed / summarize / ask / install /
 * serve / viewer / llm setup) are deliberately NOT generatable — they
 * carry richer human-UI / streaming behaviour — and stay hand-written.
 */

import { Command } from 'commander';
import { z } from 'zod';
import type { ToolModule } from '../mcp/tools/types.js';
import { getZodSchema } from '../mcp/tools/_define-tool.js';
import { type CliOptionSpec, type CommandSpec, zodSchemaToCommandSpec } from '../mcp/tools/_zod-to-cli.js';

/**
 * The `runViaMCP`-shaped callback the generated command's `.action()`
 * forwards to. `bin/cartograph.ts` owns the real implementation
 * (project-path resolution, `Cartograph.open`, the `ToolHandler`
 * round-trip, error styling); it is injected so this module stays
 * decoupled from the heavy CLI runtime and is unit-testable in
 * isolation.
 */
export type RunViaMcp = (
  toolName: string,
  args: Record<string, unknown>,
  projectPath: string | undefined,
) => Promise<void>;

/** Options for {@link buildGeneratedCommand}. */
export interface GenerateCommandOptions {
  /**
   * CLI command name. Defaults to the tool name with the
   * `cartograph_` prefix stripped and `_` → `-` (`cartograph_dead_code`
   * → `dead-code`) — the convention the `cli-mcp-alignment` test
   * already enforces.
   */
  readonly commandName?: string;
  /**
   * Field names to NOT register as CLI options. `projectPath` is
   * always handled specially (registered as `-p, --project-path` and
   * routed to `runViaMCP`'s third argument), so callers never list
   * it. Use this for a field the CLI exposes as a positional arg or
   * deliberately omits.
   */
  readonly skipFields?: readonly string[];
  /**
   * For a FAMILY tool — render the discriminator (`action` / `mode` /
   * `by` / `direction`) as a required POSITIONAL argument
   * (`cartograph note <action>`) instead of a `--<name> <value>` flag.
   *
   * This is the family-tool extension's flag-vs-positional choice:
   * the `note` / `admin` / `summaries` families take a positional
   * action on the CLI today, and the generator must preserve that
   * surface so `cli-mcp-alignment` keeps passing. Ignored when the
   * schema has no discriminator.
   *
   * (A nested-subcommand discriminator — the `admin init` / `admin
   * sync` style — is NOT generated here: those subcommands are
   * hand-written direct implementations with streaming UIs. The
   * positional form covers the flag-style families.)
   */
  readonly discriminatorAsPositional?: boolean;
  /**
   * Field names to render as POSITIONAL arguments instead of
   * `--<name> <value>` flags — the P8-wave extension for commands
   * whose schema field is naturally a positional on the CLI
   * (`module [dirPath]`, `discover [path]`, `node <symbols...>`,
   * `blame <symbol>`).
   *
   * Each entry is the camelCase Zod field name. A REQUIRED scalar
   * field renders as `<name>`; an OPTIONAL scalar as `[name]`; a
   * `string-list` field as `<name...>` (required) / `[name...]`
   * (optional). Declaration order in this array is the CLI
   * positional order — commander hands them to `.action()` in that
   * order, ahead of the options object.
   *
   * Distinct from {@link discriminatorAsPositional}, which targets
   * the family discriminator specifically; this targets ordinary
   * data fields.
   */
  readonly positionalFields?: readonly string[];
  /**
   * Name of a single plain-`string` schema field to render as a
   * SPACE-JOINED variadic positional (`<field...>` / `[field...]`).
   * Commander collects the repeated argv tokens; the generator joins
   * them with a single space before forwarding ONE string to
   * `runViaMcp`.
   *
   * Distinct from a {@link positionalFields} entry: there a
   * `string-list` field becomes a variadic positional that forwards
   * the collected ARRAY verbatim. This option targets a field that is
   * a plain `string` on the MCP side but whose natural CLI form is
   * free text spread across argv tokens — `explore <query...>` — so a
   * multi-word query needs no quoting. The field must be a plain
   * `string` (not array / enum / number); the generator throws
   * otherwise. A variadic positional must be the final argument, so a
   * joined field is registered AFTER every {@link positionalFields}
   * entry.
   */
  readonly joinedVariadicPositional?: string;
  /**
   * Short-flag aliases keyed by camelCase field name
   * (`{ limit: '-l', direction: '-d' }`). The generator registers
   * the option as `-x, --long-flag` instead of bare `--long-flag`,
   * so a generated command keeps the short flags its hand-written
   * predecessor exposed. Preserving them is a UX contract — dropping
   * `-l` for `--limit` would be a silent regression.
   *
   * `projectPath` always gets `-p` (hard-coded); never list it here.
   */
  readonly shortFlags?: Readonly<Record<string, string>>;
  /**
   * Boolean field names to FORCE-render as the negating `--no-<flag>`
   * tri-state pair, even when the Zod field is a plain `.optional()`
   * boolean with no `.default(true)`.
   *
   * The generator already auto-negates a `.default(true)` boolean
   * ({@link CliOptionSpec.isNegated}). This handles the case where a
   * tool DELIBERATELY omits the `.default` — `cartograph_context`'s
   * `code` field carries no `.default` so the handler can tell
   * "omitted" from an explicit `code: true`, yet the CLI's useful
   * surface is still the opt-OUT `--no-code` (the effective default
   * is on). The flag-vs-presentation choice is the CLI layer's, so it
   * lives here rather than coupling the MCP schema.
   *
   * Like an auto-negated field, a forced-negatable boolean is
   * forwarded ONLY when the user explicitly passes one half of the
   * pair (`getOptionValueSource` gate).
   */
  readonly negatableFields?: readonly string[];
  /**
   * CLI-side default values keyed by camelCase field name. Used when
   * the Zod schema declares NO `.default()` for a field but the CLI
   * command wants one — e.g. `cartograph_graph`'s `direction` is a
   * bare (required) enum on the MCP side (an MCP caller must be
   * explicit about which graph operation it wants), yet the CLI's
   * long-standing surface defaults it to `callers`.
   *
   * The value is the default as a STRING (commander stores it, the
   * coercion schema parses it back). It is registered as commander's
   * `.option()` default so `--help` shows it and the value is always
   * forwarded — harmless, since the MCP schema would apply the same
   * effective value. Ignored for a field that already carries a Zod
   * `.default()`. Keeping the default CLI-side (rather than adding it
   * to the schema) leaves the MCP contract unchanged.
   */
  readonly flagDefaults?: Readonly<Record<string, string>>;
  /**
   * Override the auto-derived `--kebab-case` long flag for a field,
   * keyed by camelCase field name (`{ k: '--top-k' }`). The generator
   * normally renders field `maxDepth` as `--max-depth`; an override
   * is for a field whose CLI flag has a different long-standing name
   * than its schema property — `cartograph_graph`'s schema field `k`
   * has always been `--top-k` on the CLI.
   *
   * The MCP `args` key stays the schema field name; only the CLI flag
   * (and thus commander's stored attribute name) changes — the
   * generator reads commander's value off the overridden flag's
   * camelCase and forwards it under the original field name.
   */
  readonly longFlagOverrides?: Readonly<Record<string, string>>;
  /**
   * Named-flag aliases that mirror a positional / discriminator
   * field — keyed by the alias FLAG name (kebab, no leading `--`)
   * with the camelCase schema field name as the value
   * (`{ start: 'start', action: 'action' }`). Used to bridge the
   * gap between the MCP shape (every arg is named) and the CLI
   * positional shape — `cartograph graph FileWatcher` is the
   * idiomatic CLI form, but the MCP-mirror `cartograph graph --start
   * FileWatcher` must also parse without error.
   *
   * The generator registers `--<alias> <value>` as a scalar option
   * and, in the action handler, folds the alias's value into the
   * field's slot ONLY when no positional value was supplied (the
   * positional wins on conflict, mirroring commander's flag-vs-arg
   * precedence elsewhere). Multi-value (variadic) positional
   * aliases collect a single string-or-array value as appropriate.
   * The alias never appears in `--help` as the primary surface;
   * its description points at the canonical positional.
   */
  readonly aliasFlags?: Readonly<Record<string, string>>;
  /**
   * Variadic (`string-list`) field names whose collected token array
   * should be COMMA-FLATTENED: each token is split by `,`, trimmed,
   * empties dropped, and the resulting list of strings is forwarded
   * in place of the raw array. Mirrors the comma-handling style used
   * elsewhere in the CLI (`find --fields name,id`) — without this
   * the variadic stores `['nodes,edges']` (one literal element) and
   * the downstream filter never matches anything.
   *
   * Targets a per-field opt-in rather than a blanket transform: a
   * variadic where the values legitimately contain commas (a regex
   * argument, a quoted SQL fragment) would lose semantics under a
   * universal split.
   */
  readonly commaSplitFields?: readonly string[];
}

/** Field always routed to `runViaMCP`'s `projectPath` argument
 *  rather than into the forwarded `args` object. */
const PROJECT_PATH_FIELD = 'projectPath';

/**
 * Build a commander `Command` for a Zod-backed tool module.
 *
 * @throws if `mod` is not a `defineTool` module (no Zod schema) — a
 *   legacy hand-written-JSON-Schema tool has no schema to generate
 *   from. P4 made all 36 tools Zod-backed, so in practice every
 *   registry module qualifies.
 */
export function buildGeneratedCommand(
  mod: ToolModule,
  runViaMcp: RunViaMcp,
  opts: GenerateCommandOptions = {},
): Command {
  const schema = getZodSchema(mod);
  if (!schema) {
    throw new Error(
      `buildGeneratedCommand: tool \`${mod.definition.name}\` is not Zod-backed ` +
        `(no schema to generate a CLI command from). Only \`defineTool\` modules are generatable.`,
    );
  }
  const spec = zodSchemaToCommandSpec(schema);
  const commandName = opts.commandName ?? defaultCommandName(mod.definition.name);
  const cmd = new Command(commandName).description(mod.definition.description);
  const ctx: GenContext = { cmd, spec, mod, opts };

  // Pre-phase — collect the set of fields targeted by an aliasFlag.
  // A required positional whose field is aliasable is downgraded to
  // OPTIONAL in Phase 1 so commander doesn't reject `--<alias> X`
  // (which carries the value via the flag, not the positional slot).
  // The action handler still asserts a value arrived from one slot
  // or the other — falls back to the MCP schema's own required check
  // when both are absent.
  const aliasedFieldNames = new Set(Object.values(opts.aliasFlags ?? {}));
  // Phase 1 — positionals (the family discriminator / data fields /
  // a joined-variadic field). Returns the membership set used to
  // exclude them from the option list, plus the ordered list the
  // action folds back in by index.
  const layout = registerPositionals(ctx, aliasedFieldNames);
  // Phase 2 — `-p, --project-path` plus every non-positional field as
  // a `--<flag>` option. Returns the specs the action forwards.
  const forwarded = registerOptions(ctx, layout.positionalSet);
  // Phase 2b — aliasFlags. Register each alias as a `--<alias>
  // <value>` option AFTER the primary options so it sits at the end
  // of the option list in --help (the canonical positional is the
  // primary surface; the alias is the MCP-mirror sugar). The action
  // handler reads them in `applyAliasFlags` and folds the value into
  // the matching positional / forwarded slot when that slot is empty.
  const aliasEntries = registerAliasFlags(ctx, layout);
  // Phase 3 — the `.action()` that coerces CLI strings to the schema's
  // types, folds in the positionals, and calls `runViaMcp`.
  // Validate every commaSplitFields entry names a real string-list
  // field on the schema — catches a typo / renamed field rather than
  // silently no-op.
  const commaSplitFields = new Set(opts.commaSplitFields ?? []);
  for (const name of commaSplitFields) {
    const target = spec.options.find((o) => o.name === name);
    if (!target) {
      throw new Error(
        `buildGeneratedCommand: commaSplitFields entry \`${name}\` names no field on \`${mod.definition.name}\`.`,
      );
    }
    if (target.kind !== 'string-list') {
      throw new Error(
        `buildGeneratedCommand: commaSplitFields entry \`${name}\` on \`${mod.definition.name}\` ` +
          `is kind \`${target.kind}\` — comma-splitting only applies to a variadic string-list field.`,
      );
    }
  }
  cmd.action(
    buildActionHandler({
      mod,
      runViaMcp,
      forwarded,
      coercionSchema: buildCoercionSchema(forwarded),
      leadingPositionals: layout.leadingPositionals,
      joinedVariadicName: layout.joinedVariadicName,
      hasProjectPath: hasProjectPathField(spec),
      aliasEntries,
      commaSplitFields,
    }),
  );
  return cmd;
}

/**
 * One {@link GenerateCommandOptions.aliasFlags} entry, after
 * resolution against the schema. `aliasFlag` is the kebab name
 * (`--start`); `aliasKey` is commander's camelCase storage key
 * (`start`); `field` is the matching schema option / discriminator
 * spec. The action handler reads `options[aliasKey]` and folds it
 * into the slot for `field.name`.
 */
interface AliasFlagEntry {
  readonly aliasFlag: string;
  readonly aliasKey: string;
  readonly field: CliOptionSpec;
  /** Index into `leadingPositionals` for a positional-rendered field,
   *  or `-1` when the field is forwarded as a `--flag` option. */
  readonly positionalIndex: number;
}

/**
 * Phase 2b — register each {@link GenerateCommandOptions.aliasFlags}
 * entry as a `--<alias> <value>` option and return the resolved
 * entries. The action handler folds each alias value into the
 * matching field slot when the field's primary slot is empty.
 *
 * An alias for a `string-list` / variadic positional registers
 * the option as variadic too (`--symbols <values...>`) so a
 * batched form is still expressible via the alias.
 */
function registerAliasFlags(ctx: GenContext, layout: PositionalLayout): AliasFlagEntry[] {
  const { cmd, spec, mod, opts } = ctx;
  const aliasMap = opts.aliasFlags ?? {};
  const entries: AliasFlagEntry[] = [];
  for (const [aliasFlag, fieldName] of Object.entries(aliasMap)) {
    const field =
      spec.options.find((o) => o.name === fieldName) ??
      (spec.discriminator?.name === fieldName ? spec.discriminator : undefined);
    if (!field) {
      throw new Error(
        `buildGeneratedCommand: aliasFlags entry \`${aliasFlag}\` names no ` +
          `field \`${fieldName}\` on \`${mod.definition.name}\`.`,
      );
    }
    const aliasLongFlag = `--${aliasFlag}`;
    const aliasKey = aliasFlag.replaceAll(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
    const positionalIndex = layout.leadingPositionals.findIndex((p) => p.name === fieldName);
    const placeholder = field.kind === 'string-list' ? '<values...>' : '<value>';
    const desc = `Alias for the \`${fieldName}\` positional (mirrors MCP arg name)`;
    cmd.option(`${aliasLongFlag} ${placeholder}`, desc);
    entries.push({ aliasFlag, aliasKey, field, positionalIndex });
  }
  return entries;
}

/**
 * The shared working context threaded through the generation phases —
 * the command under construction plus the schema / module / caller
 * options driving it. Bundled so each phase helper takes one cohesive
 * argument instead of repeating the same four parameters.
 */
interface GenContext {
  /** The commander `Command` being assembled (mutated in place). */
  readonly cmd: Command;
  /** The tool's derived CLI shape (options + family discriminator). */
  readonly spec: CommandSpec;
  /** The MCP tool module — its `definition.name` keys error messages. */
  readonly mod: ToolModule;
  /** Caller-supplied generation options. */
  readonly opts: GenerateCommandOptions;
}

/** True when the tool schema declares a `projectPath` field — the CLI
 *  then exposes `-p, --project-path` and routes it to `runViaMcp`. */
function hasProjectPathField(spec: CommandSpec): boolean {
  return spec.options.some((o) => o.name === PROJECT_PATH_FIELD);
}

/**
 * The positional-argument layout {@link registerPositionals} computes
 * and {@link buildGeneratedCommand} threads into the option-exclusion
 * and the action.
 */
interface PositionalLayout {
  /**
   * Every field name rendered as a positional (discriminator + data
   * fields + a joined-variadic field). The option-registration phase
   * skips these so a field is never BOTH a positional and a `--flag`.
   */
  readonly positionalSet: ReadonlySet<string>;
  /**
   * The positionals in CLI order (`[<discriminator>?] [<field>...]`).
   * Commander hands them to `.action()` ahead of the options object,
   * so a positional arrives at its index in this array.
   */
  readonly leadingPositionals: readonly CliOptionSpec[];
  /** The {@link GenerateCommandOptions.joinedVariadicPositional} field
   *  name, when one was requested — the action joins its token array. */
  readonly joinedVariadicName: string | undefined;
}

/**
 * Phase 1 — register every positional argument on `cmd` and return the
 * {@link PositionalLayout}. Order: the (single) family discriminator,
 * then each {@link GenerateCommandOptions.positionalFields} entry, then
 * a {@link GenerateCommandOptions.joinedVariadicPositional} field last
 * (commander requires a variadic positional to be the final argument).
 *
 * `aliasedFieldNames` are fields targeted by an
 * {@link GenerateCommandOptions.aliasFlags} entry — their positional
 * slot is downgraded to optional so commander doesn't reject a call
 * that supplies the value via the alias flag instead.
 */
function registerPositionals(ctx: GenContext, aliasedFieldNames: ReadonlySet<string>): PositionalLayout {
  const { cmd, spec, mod, opts } = ctx;
  const positionalSet = new Set<string>();
  const leadingPositionals: CliOptionSpec[] = [];

  // Family discriminator as a positional argument, when requested.
  if (opts.discriminatorAsPositional && spec.discriminator) {
    const disc = spec.discriminator;
    const choices = disc.choices ?? [];
    const aliased = aliasedFieldNames.has(disc.name);
    const token = aliased ? `[${disc.name}]` : `<${disc.name}>`;
    cmd.argument(token, `${disc.description}${choices.length ? ` — one of: ${choices.join(' | ')}` : ''}`);
    positionalSet.add(disc.name);
    leadingPositionals.push(disc);
  }

  // Non-discriminator positional fields, in declared `positionalFields`
  // order — commander passes them to `.action()` in that order.
  for (const name of opts.positionalFields ?? []) {
    const optSpec = spec.options.find((o) => o.name === name);
    if (!optSpec) {
      throw new Error(
        `buildGeneratedCommand: \`${mod.definition.name}\` has no field \`${name}\` ` +
          `to render as a positional argument.`,
      );
    }
    positionalSet.add(name);
    leadingPositionals.push(optSpec);
    cmd.argument(positionalToken(optSpec, aliasedFieldNames.has(name)), optSpec.description);
  }

  // A plain-`string` field rendered as a SPACE-JOINED variadic
  // positional (`explore <query...>`). Registered last — commander
  // requires a variadic positional to be the final argument. The
  // collected token array is joined with ' ' in the action.
  const joinedVariadicName = opts.joinedVariadicPositional;
  if (joinedVariadicName !== undefined) {
    const optSpec = spec.options.find((o) => o.name === joinedVariadicName);
    if (!optSpec) {
      throw new Error(
        `buildGeneratedCommand: \`${mod.definition.name}\` has no field ` +
          `\`${joinedVariadicName}\` to render as a joined variadic positional.`,
      );
    }
    if (optSpec.kind !== 'string') {
      throw new Error(
        `buildGeneratedCommand: joinedVariadicPositional \`${joinedVariadicName}\` on ` +
          `\`${mod.definition.name}\` is kind \`${optSpec.kind}\` — only a plain string ` +
          `field can be a space-joined variadic positional.`,
      );
    }
    positionalSet.add(joinedVariadicName);
    leadingPositionals.push(optSpec);
    const aliased = aliasedFieldNames.has(joinedVariadicName);
    const required = optSpec.required && !aliased;
    cmd.argument(required ? `<${joinedVariadicName}...>` : `[${joinedVariadicName}...]`, optSpec.description);
  }

  return { positionalSet, leadingPositionals, joinedVariadicName };
}

/**
 * Phase 2 — register `-p, --project-path` (when the schema declares it)
 * plus every non-skipped, non-projectPath, non-positional field as a
 * `--<flag>` option, and return the specs the action forwards.
 *
 * Each `negatableFields` / `flagDefaults` / `longFlagOverrides` entry
 * is validated against the schema (it must name a real field) — a
 * typo / renamed field throws here rather than silently no-op.
 */
function registerOptions(ctx: GenContext, positionalSet: ReadonlySet<string>): CliOptionSpec[] {
  const { cmd, spec, mod, opts } = ctx;
  const skip = new Set(opts.skipFields ?? []);
  const shortFlags = opts.shortFlags ?? {};
  const forceNegatable = new Set(opts.negatableFields ?? []);
  const flagDefaults = opts.flagDefaults ?? {};
  const longOverrides = opts.longFlagOverrides ?? {};

  // `-p, --project-path` is routed to `runViaMcp`'s third argument, not
  // into the forwarded `args` object — registered specially here.
  if (hasProjectPathField(spec)) {
    cmd.option('-p, --project-path <path>', 'Path to the project (defaults to current directory)');
  }

  // Every `negatableFields` / `flagDefaults` / `longFlagOverrides` key
  // must name a real schema field — catch a typo rather than no-op.
  for (const [label, names] of [
    ['negatableFields', forceNegatable] as const,
    ['flagDefaults', Object.keys(flagDefaults)] as const,
    ['longFlagOverrides', Object.keys(longOverrides)] as const,
  ]) {
    for (const name of names) {
      if (!spec.options.some((o) => o.name === name)) {
        throw new Error(
          `buildGeneratedCommand: ${label} entry \`${name}\` names no ` + `field on \`${mod.definition.name}\`.`,
        );
      }
    }
  }

  const forwarded: CliOptionSpec[] = [];
  for (const rawOpt of spec.options) {
    if (rawOpt.name === PROJECT_PATH_FIELD || skip.has(rawOpt.name)) continue;
    // A positional-rendered field (discriminator / data / joined
    // variadic) is excluded — it arrives as a positional arg.
    if (positionalSet.has(rawOpt.name)) continue;
    // A forced-negatable boolean is rendered as the `--no-<flag>`
    // tri-state pair even without a `.default(true)` in the schema.
    if (forceNegatable.has(rawOpt.name) && rawOpt.kind !== 'boolean') {
      throw new Error(
        `buildGeneratedCommand: negatableFields entry \`${rawOpt.name}\` on ` +
          `\`${mod.definition.name}\` is not a boolean field.`,
      );
    }
    let opt: CliOptionSpec = rawOpt;
    if (forceNegatable.has(opt.name) && !opt.isNegated) {
      opt = { ...opt, isNegated: true };
    }
    // A CLI-side default for a field whose schema declares none.
    const cliDefault = flagDefaults[opt.name];
    if (cliDefault !== undefined && opt.defaultValue === undefined) {
      opt = { ...opt, defaultValue: cliDefault };
    }
    // Override the auto-derived `--kebab` long flag.
    const longOverride = longOverrides[opt.name];
    if (longOverride !== undefined) {
      opt = { ...opt, flag: longOverride };
    }
    registerOption(cmd, opt, shortFlags[opt.name]);
    forwarded.push(opt);
  }
  return forwarded;
}

/**
 * Commander stores an option's value under the camelCase of its long
 * flag (`--top-k` → `topK`). For a default `--kebab(name)` flag this
 * equals the field name; it differs only under a `longFlagOverrides`
 * entry — so the action reads `options[commanderKey(opt)]` and forwards
 * it under the schema field name `opt.name`.
 */
function commanderKey(opt: CliOptionSpec): string {
  return opt.flag.replace(/^--/, '').replaceAll(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Everything {@link buildActionHandler} needs to build the
 *  `.action()` closure — bundled so the signature stays one argument. */
interface ActionHandlerSpec {
  readonly mod: ToolModule;
  readonly runViaMcp: RunViaMcp;
  /** Specs registered as `--<flag>` options — forwarded into `args`. */
  readonly forwarded: readonly CliOptionSpec[];
  /** CLI-local coercion schema built from {@link forwarded}. */
  readonly coercionSchema: z.ZodObject<z.ZodRawShape>;
  /** Positionals in CLI order — folded into `args` by index. */
  readonly leadingPositionals: readonly CliOptionSpec[];
  /** Joined-variadic field name, or `undefined`. */
  readonly joinedVariadicName: string | undefined;
  /** True when the schema declares `projectPath`. */
  readonly hasProjectPath: boolean;
  /** Resolved {@link GenerateCommandOptions.aliasFlags} entries —
   *  folded into the matching field slot when empty. */
  readonly aliasEntries: readonly AliasFlagEntry[];
  /** Variadic field names whose collected token array should be
   *  comma-flattened before forwarding (handoff #26). */
  readonly commaSplitFields: ReadonlySet<string>;
}

/**
 * Phase 3 — build the commander `.action()` callback. It coerces the
 * collected CLI strings through the {@link ActionHandlerSpec.coercionSchema},
 * folds in the positionals, and forwards the typed `args` to `runViaMcp`.
 *
 * Commander hands positional args first, then the options object, then
 * the Command — so a positional arrives at its index in
 * {@link ActionHandlerSpec.leadingPositionals}.
 */
function buildActionHandler(handler: ActionHandlerSpec): (...actionArgs: unknown[]) => Promise<void> {
  return async (...actionArgs: unknown[]) => {
    const options = (actionArgs.at(-2) ?? {}) as Record<string, unknown>;
    const command = actionArgs.at(-1) as Command;
    const projectPath = readProjectPath(handler, options);
    const raw = collectForwardedRawArgs(handler, options, command);
    const parsed = handler.coercionSchema.safeParse(raw);
    if (!parsed.success) {
      reportCoercionFailure(handler.forwarded, parsed.error.issues[0]);
      return;
    }
    const finalArgs = parsed.data as Record<string, unknown>;
    foldLeadingPositionals(handler, actionArgs, finalArgs);
    foldAliasFallback(handler, options, finalArgs);
    await handler.runViaMcp(handler.mod.definition.name, finalArgs, projectPath);
  };
}

function readProjectPath(handler: ActionHandlerSpec, options: Record<string, unknown>): string | undefined {
  if (!handler.hasProjectPath) return undefined;
  const value = options[PROJECT_PATH_FIELD];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Strip projectPath + any commander-internal keys before coercion;
 * only the registered option keys feed the schema. A negatable
 * boolean (`--no-x`/`--x` pair) is forwarded ONLY when the user
 * explicitly passed it — commander stores the default (`true`)
 * otherwise, which `getOptionValueSource` distinguishes from a
 * real pass. Left unforwarded, the MCP schema's own default applies.
 */
function collectForwardedRawArgs(
  handler: ActionHandlerSpec,
  options: Record<string, unknown>,
  command: Command,
): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const opt of handler.forwarded) {
    const key = commanderKey(opt);
    if (options[key] === undefined) continue;
    if (opt.isNegated && command.getOptionValueSource(key) !== 'cli') continue;
    let value: unknown = options[key];
    if (handler.commaSplitFields.has(opt.name) && Array.isArray(value)) {
      value = flattenCommaSeparated(value);
    }
    raw[opt.name] = value;
  }
  return raw;
}

/**
 * Surface the first issue in the CLI's `✗ ...` style and exit
 * non-zero — scripts can detect the failure, and the message is
 * the human-meaningful constraint, not a raw MCP envelope. The
 * issue path is a schema field name — resolve it back to the
 * real (possibly overridden) flag for the `--flag:` prefix.
 */
function reportCoercionFailure(
  forwarded: readonly CliOptionSpec[],
  issue: { path: PropertyKey[]; message?: string } | undefined,
): void {
  const issueField = issue?.path.length ? String(issue.path[0]) : '';
  const issueFlag = forwarded.find((o) => o.name === issueField)?.flag;
  const where = issueField ? `${issueFlag ?? `--${kebab(issueField)}`}: ` : '';
  process.stderr.write(`\x1b[31m✗\x1b[0m ${where}${issue?.message ?? 'invalid argument'}\n`);
  process.exitCode = 1;
}

/**
 * Fold the leading positionals in by their declared index. A
 * value-less optional positional arrives `undefined` — skipped;
 * a variadic positional arrives already collected into an array.
 * A joined-variadic positional arrives as a token array — join
 * it back into the single string the MCP schema expects.
 */
function foldLeadingPositionals(
  handler: ActionHandlerSpec,
  actionArgs: readonly unknown[],
  finalArgs: Record<string, unknown>,
): void {
  handler.leadingPositionals.forEach((optSpec, idx) => {
    const value = actionArgs[idx];
    if (value === undefined) return;
    if (Array.isArray(value) && value.length === 0) return;
    finalArgs[optSpec.name] =
      optSpec.name === handler.joinedVariadicName && Array.isArray(value) ? value.join(' ') : value;
  });
}

/**
 * Alias-flag fallback. Folds each alias's value into the matching
 * field slot when that slot is still empty (the primary surface —
 * positional, `--flag`, or discriminator — wins on conflict so
 * the canonical CLI shape is unaffected). Done AFTER coercion so
 * an alias targeting a skipped / non-forwarded field still
 * reaches the MCP `args` payload; the MCP schema's own validation
 * catches an out-of-shape value.
 */
function foldAliasFallback(
  handler: ActionHandlerSpec,
  options: Record<string, unknown>,
  finalArgs: Record<string, unknown>,
): void {
  for (const ae of handler.aliasEntries) {
    if (options[ae.aliasKey] === undefined) continue;
    if (finalArgs[ae.field.name] !== undefined) continue;
    let value: unknown = options[ae.aliasKey];
    if (ae.field.name === handler.joinedVariadicName && Array.isArray(value)) {
      value = value.join(' ');
    }
    finalArgs[ae.field.name] = value;
  }
}

/**
 * The commander positional-argument token for a field rendered as a
 * positional. `<x>` required scalar, `[x]` optional scalar,
 * `<x...>` / `[x...]` variadic (`string-list`). `forceOptional` forces
 * the optional `[...]` form even on a required schema field — used when
 * an aliasFlags entry covers the positional slot, so commander accepts
 * a call that supplies the value via the alias flag instead.
 */
function positionalToken(opt: CliOptionSpec, forceOptional = false): string {
  const variadic = opt.kind === 'string-list';
  const inner = variadic ? `${opt.name}...` : opt.name;
  const required = opt.required && !forceOptional;
  return required ? `<${inner}>` : `[${inner}]`;
}

/** `cartograph_dead_code` → `dead-code`. */
function defaultCommandName(toolName: string): string {
  return toolName.replace(/^cartograph_/, '').replaceAll('_', '-');
}

/** camelCase → kebab-case for an error-message flag reference. */
function kebab(name: string): string {
  return name.replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * Comma-flatten a variadic option's collected token array — splits
 * each element by `,`, trims whitespace, drops empty fragments.
 * `['nodes,edges', 'files']` → `['nodes', 'edges', 'files']`;
 * `['  a , b  ', '']` → `['a', 'b']`. Handoff #26 — matches the
 * comma-handling style used by `find --fields name,id` elsewhere
 * in the CLI.
 */
function flattenCommaSeparated(values: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== 'string') continue;
    for (const part of v.split(',')) {
      const trimmed = part.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

/**
 * Build the commander flag-spec string for a {@link CliOptionSpec},
 * prepending a short-flag alias when one is supplied.
 *
 * `--limit` + `-l` → `-l, --limit`. The `<value>` / `<values...>`
 * placeholder is appended by the caller as appropriate. The negating
 * half of a negatable-boolean pair is registered separately by
 * {@link registerOption} and never routes through here.
 */
function flagSpec(opt: CliOptionSpec, short: string | undefined, placeholder: string): string {
  const head = short ? `${short}, ${opt.flag}` : opt.flag;
  return placeholder ? `${head} ${placeholder}` : head;
}

/** `--compact` → `--no-compact` (commander's negation form). */
function negatedFlag(flag: string): string {
  return flag.replace(/^--/, '--no-');
}

/**
 * Register one {@link CliOptionSpec} as a commander option.
 *
 * A field that declares a Zod `.default(...)` is registered WITH that
 * default as commander's third `.option()` argument: `--help` then
 * shows it, and the CLI/MCP default-limit parity test (#32) — which
 * reads `option.defaultValue` — stays satisfied. Forwarding the
 * default to `runViaMCP` is harmless: the MCP schema would apply the
 * very same default. Boolean flags never carry a default (an absent
 * flag is `undefined`; the schema's `.default(false)` applies MCP-side)
 * — EXCEPT a negatable boolean (`isNegated`, i.e. `.default(true)`):
 * commander's `--no-<flag>` form stores a `true` default, and the
 * action's `getOptionValueSource` gate forwards only an explicit pass.
 *
 * `short` is the optional short-flag alias (`-l`) — passed through so
 * a generated command keeps the short flags its hand-written
 * predecessor exposed.
 */
function registerOption(cmd: Command, opt: CliOptionSpec, short?: string): void {
  if (opt.isFlag) {
    if (opt.isNegated) {
      // Tri-state negatable boolean. Commander does NOT auto-accept
      // `--<flag>` when only `--no-<flag>` is declared, so register
      // BOTH halves of the pair explicitly (the `graph` command's
      // hand-written `--no-compact` / `--compact` shape). The
      // negating half carries the description + the stored `true`
      // default; the positive half is bare. `getOptionValueSource`
      // (in the action) distinguishes "user passed one" from "default".
      cmd.option(negatedFlag(opt.flag), opt.description);
      cmd.option(
        flagSpec(opt, short, ''),
        `Opt INTO ${opt.flag} (default: on; the negating ${negatedFlag(opt.flag)} is the usual form)`,
      );
      return;
    }
    // Plain boolean → opt-IN value-less flag.
    cmd.option(flagSpec(opt, short, ''), opt.description);
    return;
  }
  if (opt.kind === 'string-list') {
    // Variadic value option — commander collects repeated tokens.
    cmd.option(flagSpec(opt, short, '<values...>'), opt.description);
    return;
  }
  // A scalar default is stringified so commander stores it as the CLI
  // would have received it; the coercion schema parses it back.
  const def = opt.defaultValue === undefined ? undefined : String(opt.defaultValue);
  // Scalar value option. `<value>` for required, `[value]` is avoided
  // — commander treats `[value]` as an OPTIONAL-ARGUMENT option which
  // changes parse semantics; an unset optional field simply isn't
  // forwarded, so `<value>` is correct for both required and optional.
  if (def === undefined) {
    cmd.option(flagSpec(opt, short, '<value>'), opt.description);
  } else {
    cmd.option(flagSpec(opt, short, '<value>'), opt.description, def);
  }
}

/**
 * Build a CLI-LOCAL Zod schema whose every field is a `z.coerce`
 * variant of the tool's field. `z.coerce.number().int().min().max()`
 * parses the CLI string THEN validates the range — so a non-numeric
 * or out-of-range value is rejected with the locked bounds.
 *
 * The tool's OWN schema is untouched: coercion belongs at the CLI
 * input boundary, not in the MCP contract.
 */
export function buildCoercionSchema(specs: readonly CliOptionSpec[]): z.ZodObject<z.ZodRawShape> {
  // A mutable builder map — Zod 4 types `z.ZodRawShape` as a `Readonly`
  // record, so the shape is assembled in a plain `Record` first.
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const opt of specs) {
    shape[opt.name] = coerceField(opt);
  }
  return z.object(shape);
}

/** Map one {@link CliOptionSpec} to its `z.coerce`-based CLI field. */
function coerceField(opt: CliOptionSpec): z.ZodTypeAny {
  let field: z.ZodTypeAny;
  switch (opt.kind) {
    case 'boolean':
      // A commander flag yields a literal `true` when passed, absent
      // otherwise — `z.coerce.boolean()` would turn the string "false"
      // truthy, but a flag never carries a value, so a plain boolean
      // is correct.
      field = z.boolean();
      break;
    case 'number': {
      let num = z.coerce.number();
      // `.int()` / `.min()` / `.max()` carry the project's
      // `must be >= N` / `must be <= N` phrasing so a generated
      // command's bounds error reads identically to the hand-written
      // `assignIntArg` / `assignFloatArg` path (`audit4-cli` asserts
      // this exact wording).
      if (opt.isInt) num = num.int('must be an integer');
      if (opt.min !== undefined) num = num.min(opt.min, `must be >= ${opt.min}`);
      if (opt.max !== undefined) num = num.max(opt.max, `must be <= ${opt.max}`);
      field = num;
      break;
    }
    case 'enum':
      // commander already restricts nothing — validate the choice here.
      field = z.enum((opt.choices ?? ['']) as [string, ...string[]]);
      break;
    case 'string-list':
      // Variadic option → already an array of strings from commander.
      field = z.array(z.string());
      break;
    default:
      field = z.string();
      break;
  }
  // A non-required field becomes optional so an unset option simply
  // drops out of the parsed result (and is never forwarded).
  return opt.required ? field : field.optional();
}

/** Re-export for callers that want the spec without the Command. */
export type { CommandSpec };
