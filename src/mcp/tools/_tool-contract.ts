/**
 * ToolContract is the authored source for a tool surface when the MCP
 * schema and generated CLI need more than the Zod field list alone.
 *
 * The Zod schema remains the source for:
 * - MCP inputSchema
 * - handler argument typing and validation
 * - generated CLI field kinds, descriptions, enum choices, bounds, and
 *   schema-level defaults
 *
 * The `cli` block adds the presentation-only choices that do not belong
 * in the MCP schema: positionals, aliases, short flags, forced negation,
 * CLI-only defaults, examples, and next-step help text.
 */
import type { ToolModule } from './types.js';
import { defineTool, type DefineToolSpec, type ToolZodSchema } from './_define-tool.js';

/**
 * CLI metadata for a generated command.
 *
 * Keep this shape runtime-free: it is stored on MCP tool modules and is
 * read by `src/bin/_command-generator.ts`, but it should not import
 * commander or CLI execution code.
 */
interface ToolCliContract {
  /** Override `cartograph_X` -> `x` command-name derivation. */
  readonly commandName?: string;
  /** Schema fields intentionally omitted from the generated CLI surface. */
  readonly skipFields?: readonly string[];
  /** Render the `action` / `mode` / `by` / `direction` enum as a positional. */
  readonly discriminatorAsPositional?: boolean;
  /** Schema fields rendered as ordinary positional arguments. */
  readonly positionalFields?: readonly string[];
  /** Plain string schema field rendered as a space-joined variadic positional. */
  readonly joinedVariadicPositional?: string;
  /** Short flags keyed by schema field name, e.g. `{ limit: '-l' }`. */
  readonly shortFlags?: Readonly<Record<string, string>>;
  /** Optional booleans that should expose the `--no-*` / `--*` pair. */
  readonly negatableFields?: readonly string[];
  /** CLI-only defaults keyed by schema field name. */
  readonly flagDefaults?: Readonly<Record<string, string>>;
  /** Long-flag overrides keyed by schema field name. */
  readonly longFlagOverrides?: Readonly<Record<string, string>>;
  /** Alias flags keyed by flag name (without `--`) and valued by schema field name. */
  readonly aliasFlags?: Readonly<Record<string, string>>;
  /** Variadic string-list fields that should split comma-separated tokens. */
  readonly commaSplitFields?: readonly string[];
  /** Example invocations appended to generated `--help`. */
  readonly examples?: readonly string[];
  /** Follow-up guidance appended to generated `--help`. */
  readonly nextStepHints?: readonly string[];
}

export interface ToolContract<S extends ToolZodSchema> extends DefineToolSpec<S> {
  readonly cli?: ToolCliContract;
}

const TOOL_CONTRACT_KEY = '__toolContract' as const;

export interface ContractToolModule extends ToolModule {
  readonly [TOOL_CONTRACT_KEY]: ToolContract<ToolZodSchema>;
}

export function defineToolContract<S extends ToolZodSchema>(contract: ToolContract<S>): ContractToolModule {
  return reattachToolContract(defineTool(contract), contract) as ContractToolModule;
}

export function getToolContract(mod: ToolModule | undefined): ToolContract<ToolZodSchema> | undefined {
  if (!mod) return undefined;
  return (mod as Partial<ContractToolModule>)[TOOL_CONTRACT_KEY];
}

export function reattachToolContract<M extends ToolModule>(
  clone: M,
  contract: ToolContract<ToolZodSchema> | undefined,
): M & Partial<ContractToolModule> {
  if (!contract) return clone;
  Object.defineProperty(clone, TOOL_CONTRACT_KEY, {
    value: contract,
    enumerable: false,
    writable: false,
    configurable: true,
  });
  return clone;
}
