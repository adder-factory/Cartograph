/**
 * CLI ↔ MCP surface alignment.
 *
 * Per the project's CLAUDE.md and the MCP playbook, MCP tool names
 * mirror CLI command names — `cartograph_X` ↔ `cartograph X` for
 * top-level tools, and family tools `cartograph_<family>({action|mode})`
 * mirror `cartograph <family> <action>` (subcommand) or
 * `cartograph <family> --mode <m>` (flag).
 *
 * This is a hand-asserted invariant today: the memo
 * `project_cartograph_cli_mcp_alignment.md` records "100% alignable
 * mirrored" as of 2026-05-10. This test mechanises that audit so
 * drift fails CI rather than silently shipping a tool the agent /
 * human can't use from the other surface.
 *
 * The test is deterministic: it imports the MCP tool registry and
 * the commander program from the CLI module. The CLI module guards
 * its `program.parse()` block behind an `import.meta.url` ↔
 * `process.argv[1]` entry-point check, so importing for metadata
 * doesn't trigger parse. Each surface's identifiers are normalised
 * and the two sets are compared minus an explicit asymmetric allowlist.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Command } from 'commander';
import { getToolModules } from '../src/mcp/tools/registry.js';
import { isReadOnlySql } from '../src/mcp/tools/sql.js';

const byString = (a: string, b: string): number => a.localeCompare(b);

/**
 * Identifiers known to be intentionally one-sided — each entry
 * carries an inline justification so future drift can be evaluated
 * against the original reason.
 *
 * Format mirrors the test's normalised-id form:
 *   - Top-level:      `<name>`        (e.g. `session`)
 *   - Family-action:  `<family>:<a>`  (e.g. `admin:summarize`)
 */
const KNOWN_ASYMMETRIC = new Set<string>([
  // ── CLI-only ─────────────────────────────────────────────────
  // `cartograph install` runs the interactive installer; no MCP
  // equivalent because the installer needs a TTY for clack prompts.
  'install',

  // `cartograph serve` starts the MCP server itself — meaningless to
  // expose via MCP (you'd already be inside an MCP session).
  'serve',

  // `cartograph mcp-budget` is a CLI-side diagnostic for the MCP
  // connection payload (`tools/list` + initialize instructions). It
  // measures the server surface before a session starts, so exposing
  // it as an MCP tool would miss the point.
  'mcp_budget',

  // `cartograph viewer` boots the local HTTP viewer; no MCP mirror
  // because the viewer is a standalone web UI, not a tool call.
  'viewer',

  // `cartograph llm setup` is CLI-side LLM provisioning — installer-style
  // flow that needs a TTY (clack prompts) and has no MCP analogue.
  'llm',
  'llm:setup',

  // `cartograph similar <symbol>` routes through `cartograph_graph` with
  // `direction: 'similar'` (folded 2026-05-14, FRICTION-46 — the
  // standalone `cartograph_similar` MCP tool was retired to free a slot
  // against the 45-tool registry cap). The CLI subcommand name is kept
  // as an ergonomic shortcut; the MCP-side equivalent is reached as
  // `cartograph_graph({direction: 'similar'})` rather than a
  // top-level tool name.
  'similar',

  // `cartograph doctor` is a top-level CLI for discoverability ("the
  // first thing to run when something doesn't work"). The MCP-side
  // equivalent is `cartograph_admin({action: 'doctor'})` — same impl,
  // different surface. Top-level discoverability beats top-level
  // alignment here; the CLI top-level slot exists for human users
  // who type their problem out, the MCP side hangs off admin where
  // every other diagnostic / lifecycle action lives.
  'doctor',

  // `cartograph setup` is CLI-only: a TTY-bound bootstrap that
  // orchestrates init + install-models + doctor with streaming
  // progress per step. An MCP equivalent would need to either
  // block until completion (multi-minute install) or invent a
  // streaming protocol — neither matches the existing MCP contract.
  // Users who want programmatic install-flow control can call the
  // underlying actions individually via `cartograph_admin`.
  'setup',
]);

// ── helpers ───────────────────────────────────────────────────

/** `cartograph_dead_code` → `dead_code`; family forms unchanged. */
function stripPrefix(toolName: string): string {
  return toolName.replace(/^cartograph_/, '');
}

/** Normalise CLI command name (`dead-code`) to underscore form
 *  (`dead_code`) so MCP and CLI sets share a single vocabulary. */
function cliToMcpName(cliName: string): string {
  return cliName.replaceAll('-', '_');
}

function visitCliCommand(cmd: Command, prefix: string[], ids: Set<string>): void {
  const name = cmd.name();
  // Skip the root program (no name) and the auto-injected `help` command.
  if (!name || name === 'help' || name === 'cartograph') {
    for (const sub of cmd.commands) visitCliCommand(sub, prefix, ids);
    return;
  }
  const path = [...prefix, cliToMcpName(name)];
  ids.add(path.join(':'));
  for (const sub of cmd.commands) visitCliCommand(sub, path, ids);
}

/** Walk the commander tree and return every leaf-or-family
 *  identifier as `family[:sub[:sub...]]` (already MCP-normalised). */
function collectCliIds(program: Command): Set<string> {
  const ids = new Set<string>();
  visitCliCommand(program, [], ids);
  return ids;
}

/**
 * For each MCP tool, return its identifier(s):
 *  - Tools with no enum discriminator: just `<stripped_name>`.
 *  - Tools with an `action` or `mode` enum: emit
 *    `<stripped_name>:<value>` for every enum value, AND the bare
 *    `<stripped_name>` so the CLI top-level family command (which
 *    accepts the enum as a flag) still satisfies the check.
 */
function collectMcpIds(): {
  ids: Set<string>;
  familyEnums: Map<string, { discriminator: 'action' | 'mode'; values: string[] }>;
} {
  const ids = new Set<string>();
  const familyEnums = new Map<string, { discriminator: 'action' | 'mode'; values: string[] }>();
  for (const m of getToolModules()) {
    const stripped = stripPrefix(m.definition.name);
    ids.add(stripped);
    const props = m.definition.inputSchema.properties;
    for (const disc of ['action', 'mode'] as const) {
      const schema = props[disc];
      if (schema && Array.isArray(schema.enum) && schema.enum.length > 0) {
        familyEnums.set(stripped, { discriminator: disc, values: schema.enum });
        for (const v of schema.enum) {
          // Normalise enum value to MCP form (`embed-only` → `embed_only`)
          // so it can be compared against CLI subcommand names that
          // came in via cliToMcpName().
          ids.add(`${stripped}:${cliToMcpName(v)}`);
        }
      }
    }
  }
  return { ids, familyEnums };
}

/** Pretty list of identifiers for failure messages — sorted, one per line. */
function fmt(set: Iterable<string>): string {
  return [...set]
    .sort(byString)
    .map((s) => `  - ${s}`)
    .join('\n');
}

/**
 * Extract every `cartograph <command>` top-level command name from the
 * fenced code block(s) under CLAUDE.md's `## CLI Usage` section.
 *
 * Only the FIRST token after `cartograph` is taken — `cartograph admin
 * sync` yields `admin`, not `admin sync`. Flags/args/subcommands are
 * deliberately ignored: prose drift on those is too brittle to guard,
 * but a renamed or removed top-level command (the `search`→`find`
 * rename is the canonical case) is exactly the rot worth catching.
 */
function extractDocumentedCliCommands(claudeMd: string): string[] {
  const lines = claudeMd.split('\n');
  const startIdx = lines.findIndex((l) => /^##\s+CLI Usage\s*$/.test(l));
  if (startIdx === -1) {
    throw new Error('CLAUDE.md: `## CLI Usage` section heading not found');
  }
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]!)) {
      endIdx = i;
      break;
    }
  }

  const commands = new Set<string>();
  let inFence = false;
  for (const line of lines.slice(startIdx + 1, endIdx)) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) continue;
    // First token after `cartograph` — lowercase, may contain a hyphen
    // (`at-range`). A leading `-` would be a flag, excluded by the class.
    const m = /^\s*cartograph\s+([a-z][a-z-]*)\b/.exec(line);
    if (m) commands.add(m[1]!);
  }
  return [...commands].sort(byString);
}

function cliCoversMcpId(id: string, cliIds: ReadonlySet<string>): boolean {
  if (cliIds.has(id)) return true;
  if (!id.includes(':')) return false;
  const family = id.split(':')[0]!;
  return cliIds.has(family);
}

function mcpCoversCliId(
  id: string,
  mcpIds: ReadonlySet<string>,
  familyEnums: ReadonlyMap<string, { values: string[] }>,
): boolean {
  if (mcpIds.has(id)) return true;
  if (!id.includes(':')) return false;
  const [family, sub] = id.split(':');
  const fam = familyEnums.get(family!);
  return fam?.values.map(cliToMcpName).includes(sub!) ?? false;
}

function staleAsymmetryReason(id: string, mcpIds: ReadonlySet<string>, cliIds: ReadonlySet<string>): string | null {
  const onMcp = mcpIds.has(id);
  const onCli = cliIds.has(id);
  if (onMcp && onCli) return `${id} (now mirrored on both sides — drop from KNOWN_ASYMMETRIC)`;
  if (!onMcp && !onCli) return `${id} (absent from both sides — drop from KNOWN_ASYMMETRIC)`;
  return null;
}

/**
 * Per-tool exceptions. Keyed by stripped tool name. Value is the
 * set of schema property names NOT required to appear on the CLI
 * (with a justification), or the sentinel `'*'` to skip the whole
 * tool (a deliberately hand-written CLI command whose surface is
 * intentionally richer / different than the MCP schema).
 */
const ARG_SHAPE_EXCEPTIONS: Record<string, Set<string> | '*'> = {
  // ── Hand-written direct implementations ─────────────────────────
  // These tools have streaming progress / interactive UI / hand-curated
  // subcommand trees that intentionally don't 1:1 mirror their MCP
  // schema. Each `'*'` was retired (#31) in favor of per-property
  // exemptions naming the actual gaps with justifications — the test
  // now catches a NEW unmirrored field even on a hand-written tool.

  // `cartograph admin` is a multi-subcommand surface. `action` is the
  // subcommand axis itself (not a flag); `confirm` is `uninit`-
  // specific; `clearParseCacheLanguage` and `summarizeLimit` are
  // advanced operator knobs deliberately kept off the headline CLI
  // surface. Other admin fields must be mirrored by a subcommand flag
  // or positional.
  admin: new Set(['action', 'confirm', 'clearParseCacheLanguage', 'summarizeLimit']),

  // `cartograph files` carries hand-rendered tree / flat / grouped /
  // summary layouts; the MCP `path` field is REMOVED (rejected at
  // the schema boundary — use `dir`), and `includeMetadata` is the
  // legacy alias for the current `metadata` flag.
  files: new Set(['path', 'includeMetadata']),

  // `cartograph review` is a subcommand family (`review context` /
  // `review neighbors` / `review risk` / `review agent-audit` /
  // `review trust`)
  // reflecting the `mode` enum. All schema fields are mirrored on
  // that family surface, so no per-property carve-outs are needed.

  // `cartograph session` is a subcommand tree (create / resume /
  // audit / list / delete / macro_save / macro_run / macro_list /
  // macro_delete).
  // `action` is the subcommand axis.
  session: new Set(['action']),

  // `cartograph status` takes a `[path]` positional (resolved as
  // projectPath) rather than the MCP `--project-path` flag. The
  // `verbose` and `topHotspots` / `topBiomarkers` / `summaryBreakdown`
  // knobs are still wired as `--verbose` / `--top-*`.
  status: new Set(['projectPath']),

  // `cartograph summaries` has two subcommands (`pending` / `save`)
  // reflecting the `action` enum. `items` is the agent-bridge save
  // payload — the CLI reads a JSON file argument instead of taking
  // it as a flag.
  summaries: new Set(['items']),

  // ── `affected` and `ask` ────────────────────────────────────────
  // Both formerly `'*'`; per the #31 audit ALL their schema fields
  // ARE mirrored on the CLI. No per-property carve-outs needed.

  // ── Permanent per-property carve-outs on generated commands ────
  // `allowStale` is injected into every tool's schema by the
  // registry's `withAllowStale` wrapper; the CLI deliberately does
  // not surface it. Stripped globally below — no per-tool entry.
  graph: new Set([
    // `cartograph graph` is GENERATED (registerGeneratedCommand), but
    // two schema properties have an intentional CLI asymmetry:
    // `symbols` (the batched callers/callees form) has no CLI flag —
    // the CLI takes a single `<start>` positional (`skipFields`); and
    // `k` is exposed under its long-standing CLI name `--top-k`
    // (`longFlagOverrides`), which does not normalise back to `k`.
    'symbols',
    'k',
  ]),
  // `role` is GENERATED (registerGeneratedCommand) — the `role` enum
  // is the `[role]` positional and `symbols` / `symbol` / `via` /
  // `limit` are full `--flag` mirrors, so it carries no carve-out.
};

/** Schema properties suppressed for EVERY tool (cross-cutting). */
const GLOBALLY_IGNORED_PROPS = new Set<string>([
  'allowStale', // registry-injected freshness override; not a CLI flag
]);

/** kebab→camel and `-`/`_` normalisation so a CLI long flag
 *  (`--max-depth`) and a schema property (`maxDepth`) compare equal. */
function normalizeArgName(name: string): string {
  return name.replace(/^--/, '').replaceAll(/[-_]/g, '').toLowerCase();
}

/**
 * Collect every argument identifier reachable under a command:
 * its own long-flag options + positional argument names, unioned
 * recursively with every subcommand. A family command
 * (`admin` / `coverage`) thus contributes the union of all its
 * subcommands' flags — which is what a family tool's schema
 * (one flat object) needs to mirror.
 */
function collectCommandArgNames(cmd: Command): Set<string> {
  const names = new Set<string>();
  for (const opt of cmd.options) {
    if (opt.long) {
      names.add(normalizeArgName(opt.long));
      // Commander's negation form (`--no-foo`) has `.negate === true`
      // and a destination key WITHOUT the `no-` prefix (`opts().foo`).
      // The schema-property mirror is the positive name (`foo`), so
      // also record that to avoid false-positive arg-shape drift on
      // `--no-X` flags. Without this, every `--no-X` flag would need
      // a per-property carve-out in ARG_SHAPE_EXCEPTIONS.
      if (opt.negate) {
        names.add(normalizeArgName(opt.long.replace(/^--no-/, '--')));
      }
    }
  }
  // `cmd.registeredArguments` (commander >=11) lists positionals.
  const positionals =
    (cmd as unknown as { registeredArguments?: Array<{ name(): string }> }).registeredArguments ??
    (cmd as unknown as { _args?: Array<{ name(): string }> })._args ??
    [];
  for (const arg of positionals) {
    names.add(normalizeArgName(arg.name()));
  }
  for (const sub of cmd.commands) {
    if (sub.name() === 'help') continue;
    for (const n of collectCommandArgNames(sub)) names.add(n);
  }
  return names;
}

/** Find the top-level CLI command mirroring a stripped tool name
 *  (`dead_code` → the `dead-code` command). */
function findMirrorCommand(program: Command, stripped: string): Command | undefined {
  const wanted = normalizeArgName(stripped);
  return program.commands.find((c) => normalizeArgName(c.name()) === wanted);
}

function schemaPropertiesMissingCliArgs(module: ReturnType<typeof getToolModules>[number], program: Command): string[] {
  const stripped = stripPrefix(module.definition.name);
  const exception = ARG_SHAPE_EXCEPTIONS[stripped];
  if (exception === '*') return [];

  const mirror = findMirrorCommand(program, stripped);
  if (!mirror) return [];

  const cliArgs = collectCommandArgNames(mirror);
  const props = Object.keys(module.definition.inputSchema.properties ?? {});
  return props
    .filter((prop) => !GLOBALLY_IGNORED_PROPS.has(prop))
    .filter((prop) => !(exception instanceof Set && exception.has(prop)))
    .filter((prop) => !cliArgs.has(normalizeArgName(prop)))
    .map((prop) => `${stripped}: schema property \`${prop}\` has no CLI option/argument`);
}

/** Walk the commander tree for a command by `path` and read its
 *  `--limit` option default. */
function cliLimitDefault(program: Command, segments: string[]): number {
  let cmd: Command | undefined = program;
  for (const seg of segments) {
    cmd = cmd?.commands.find((c) => c.name() === seg);
  }
  if (!cmd) throw new Error(`CLI command not found: ${segments.join(' ')}`);
  const opt = cmd.options.find((o) => o.long === '--limit');
  if (!opt) throw new Error(`--limit option not found on: ${segments.join(' ')}`);
  return Number(opt.defaultValue);
}

/** Read the `limit.default` from an MCP tool's inputSchema. */
function mcpLimitDefault(toolDef: Record<string, unknown>): number {
  const schema = toolDef['inputSchema'] as { properties?: Record<string, { default?: unknown }> };
  const def = schema.properties?.['limit']?.default;
  if (typeof def !== 'number') throw new Error('limit.default missing from MCP schema');
  return def;
}

/** Run the CLI, returning stdout+stderr and the exit code. */
function runCli(cliEntry: string, repoRoot: string, cliArgs: string[]): { out: string; code: number } {
  try {
    const out = execFileSync('bun', [cliEntry, ...cliArgs], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { out: (e.stdout ?? '') + (e.stderr ?? ''), code: e.status ?? 1 };
  }
}

// ── test ──────────────────────────────────────────────────────

describe('CLI ↔ MCP surface alignment', () => {
  it('every MCP tool / family-action has a CLI mirror (or an allowlist exemption)', async () => {
    // Dynamic import so the env-var gate is set first (vitest hoists
    // top-of-file `import` statements above bare assignments).
    const cli = await import('../src/bin/cartograph.js');
    const program = cli.program;

    const cliIds = collectCliIds(program);
    const { ids: mcpIds, familyEnums } = collectMcpIds();

    // For each MCP id, check CLI coverage. A family-action like
    // `admin:sync` is covered if EITHER the CLI has the same nested
    // subcommand path (`admin sync`) OR the CLI has a top-level
    // family command (`admin`) that accepts the discriminator as a
    // flag — admin/summaries/review use subcommands; coverage /
    // search / biomarkers / dead_code / note use a flag.
    const missingFromCli: string[] = [];
    for (const id of mcpIds) {
      if (KNOWN_ASYMMETRIC.has(id)) continue;
      if (cliCoversMcpId(id, cliIds)) continue;
      missingFromCli.push(id);
    }
    expect(
      missingFromCli,
      `MCP tools/actions with no CLI mirror (and not on KNOWN_ASYMMETRIC):\n${fmt(missingFromCli)}`,
    ).toEqual([]);

    // Reverse direction: every CLI command/subcommand must
    // correspond to an MCP id, or be on the allowlist. Catches the
    // case where a CLI subcommand outlives its MCP action.
    const orphanedCli: string[] = [];
    for (const id of cliIds) {
      if (KNOWN_ASYMMETRIC.has(id)) continue;
      if (mcpCoversCliId(id, mcpIds, familyEnums)) continue;
      orphanedCli.push(id);
    }
    expect(
      orphanedCli,
      `CLI commands/subcommands with no MCP mirror (and not on KNOWN_ASYMMETRIC):\n${fmt(orphanedCli)}`,
    ).toEqual([]);

    // Sanity: the allowlist itself shouldn't grow without intent —
    // each entry must currently appear on exactly one side. Catches
    // stale entries left behind after an asymmetry got resolved.
    const stale: string[] = [];
    for (const id of KNOWN_ASYMMETRIC) {
      const reason = staleAsymmetryReason(id, mcpIds, cliIds);
      if (reason) stale.push(reason);
    }
    expect(stale, `KNOWN_ASYMMETRIC has stale entries:\n${stale.join('\n')}`).toEqual([]);
  });

  it('every cartograph command in CLAUDE.md `## CLI Usage` exists in the CLI', async () => {
    // Guards prose↔surface drift — the test above only compares the
    // CLI and MCP *surfaces* to each other, so a stale command name
    // in CLAUDE.md's documentation slips through it. This is the rot
    // the `cartograph search`→`find` rename left behind: CLAUDE.md
    // prose said `search` long after the command became `find`.
    // The public release ships no repo-root CLAUDE.md; skip when absent.
    // The guard reactivates automatically if a CLAUDE.md with a
    // `## CLI Usage` section is added.
    const claudeMdPath = path.join(__dirname, '..', 'CLAUDE.md');
    if (!fs.existsSync(claudeMdPath)) return;
    const claudeMd = fs.readFileSync(claudeMdPath, 'utf-8');
    const documented = extractDocumentedCliCommands(claudeMd);
    expect(
      documented.length,
      'No `cartograph <command>` lines found in CLAUDE.md `## CLI Usage` — section renamed or its fenced block removed?',
    ).toBeGreaterThan(0);

    const cli = await import('../src/bin/cartograph.js');
    const realCommands = new Set(cli.program.commands.map((c) => c.name()).filter((n) => n && n !== 'help'));

    const drifted = documented.filter((c) => !realCommands.has(c));
    expect(
      drifted,
      'CLAUDE.md `## CLI Usage` documents cartograph command(s) that no longer exist ' +
        `in the CLI (prose-vs-surface drift):\n${fmt(drifted)}\n` +
        `Registered top-level commands: ${[...realCommands].sort(byString).join(', ')}`,
    ).toEqual([]);
  });
});

/**
 * CLI ↔ MCP ARGUMENT-SHAPE parity (structural campaign P8 — friction
 * category 3 kill).
 *
 * The surface-alignment test above checks command / family-action
 * EXISTENCE only. It does not catch a command that exists on both
 * surfaces but exposes a different set of arguments — the rot a
 * tool-surface audit kept finding (`module` missing `--limit`,
 * `graph` missing `--since` / `--compact`).
 *
 * This block mechanises the per-argument mirror: for every MCP tool,
 * each property of its `inputSchema` must have a corresponding CLI
 * option (long flag) or positional argument on the mirror command.
 *
 * It must FAIL on real drift. The escape hatch is the explicit
 * {@link ARG_SHAPE_EXCEPTIONS} allowlist — every entry carries an
 * inline justification (a deliberately-hand-written command, or a
 * known asymmetry like a flag the CLI surfaces under a different
 * name). P8 ships the machinery + a POC; the bulk shim→generator
 * conversion is the P8 wave, which will shrink this allowlist.
 */
describe('CLI ↔ MCP argument-shape parity (#cat3)', () => {
  it('every MCP tool inputSchema property has a CLI option / positional mirror', async () => {
    const cli = await import('../src/bin/cartograph.js');
    const program = cli.program;
    const modules = getToolModules();

    const gaps: string[] = [];
    for (const m of modules) {
      gaps.push(...schemaPropertiesMissingCliArgs(m, program));
    }

    expect(
      gaps,
      `MCP schema properties with no CLI mirror (arg-shape drift — friction cat-3):\n${fmt(gaps)}\n` +
        `Fix: add the missing CLI option, or — for a deliberately hand-written command — ` +
        `add a justified entry to ARG_SHAPE_EXCEPTIONS.`,
    ).toEqual([]);
  });

  it('ARG_SHAPE_EXCEPTIONS has no stale whole-tool skips', async () => {
    // A `'*'` entry must name a real tool — catches a renamed tool
    // leaving a dead allowlist key behind.
    const toolNames = new Set(getToolModules().map((m) => stripPrefix(m.definition.name)));
    const stale = Object.keys(ARG_SHAPE_EXCEPTIONS).filter((k) => !toolNames.has(k));
    expect(stale, `ARG_SHAPE_EXCEPTIONS keys naming no live tool:\n${fmt(stale)}`).toEqual([]);
  });

  it('ARG_SHAPE_EXCEPTIONS per-property carve-outs name only fields the schema still exposes', () => {
    // Per-property exemptions name fields on the MCP schema that the CLI
    // is allowed to skip. When a schema field is renamed or removed, the
    // matching exemption goes stale — without this guard the exemption
    // would silently mask a NEW mirror gap on an unrelated field with the
    // same name. (Structural fix #31 follow-up: the '*' tightening
    // surfaced six new per-property carve-outs; staleness has to fail
    // the test, not silently absolve.)
    const modules = getToolModules();
    const schemaPropsByTool = new Map<string, Set<string>>();
    for (const m of modules) {
      const stripped = stripPrefix(m.definition.name);
      schemaPropsByTool.set(stripped, new Set(Object.keys(m.definition.inputSchema.properties ?? {})));
    }

    const stale: string[] = [];
    for (const [tool, exception] of Object.entries(ARG_SHAPE_EXCEPTIONS)) {
      if (exception === '*') continue;
      const schemaProps = schemaPropsByTool.get(tool);
      if (!schemaProps) {
        // Self-contained: catch a dead tool key here too instead of
        // relying on the sibling 'stale whole-tool skips' test. If
        // someone runs this `it(...)` in isolation the staleness
        // doesn't silently slip through.
        stale.push(`${tool}: per-property exemption tool key names no live MCP tool`);
        continue;
      }
      for (const prop of exception) {
        if (!schemaProps.has(prop)) stale.push(`${tool}: per-property exemption \`${prop}\` no longer in schema`);
      }
    }
    expect(stale, `Stale per-property exemptions:\n${fmt(stale)}`).toEqual([]);
  });

  it('ARG_SHAPE_EXCEPTIONS per-property carve-outs are not already mirrored by CLI args', async () => {
    const cli = await import('../src/bin/cartograph.js');
    const program = cli.program;
    const stale: string[] = [];
    for (const [tool, exception] of Object.entries(ARG_SHAPE_EXCEPTIONS)) {
      if (exception === '*') continue;
      const mirror = findMirrorCommand(program, tool);
      if (!mirror) continue;
      const cliArgs = collectCommandArgNames(mirror);
      for (const prop of exception) {
        if (cliArgs.has(normalizeArgName(prop))) {
          stale.push(`${tool}: per-property exemption \`${prop}\` is now mirrored on the CLI`);
        }
      }
    }
    expect(stale, `Mirrored fields still listed in ARG_SHAPE_EXCEPTIONS:\n${fmt(stale)}`).toEqual([]);
  });
});

/**
 * Read-only gate on `cartograph_sql` — a value-setting PRAGMA
 * (`PRAGMA user_version = 5`) is a write and must be rejected, while
 * bare introspection PRAGMAs stay allowed. The original gate matched
 * only the pragma name against the allowlist and ignored the trailing
 * `= value` assignment, so allowlisted value-form pragmas
 * (`user_version` / `schema_version` / `page_size`) were writable.
 */
describe('cartograph_sql read-only gate — value-PRAGMA rejection', () => {
  it('rejects value-setting PRAGMAs even when the pragma name is allowlisted', () => {
    expect(isReadOnlySql('PRAGMA user_version = 5')).toBe(false);
    expect(isReadOnlySql('PRAGMA user_version=5')).toBe(false);
    expect(isReadOnlySql('  pragma   schema_version  =  9 ')).toBe(false);
    expect(isReadOnlySql('PRAGMA page_size = 4096')).toBe(false);
    expect(isReadOnlySql('PRAGMA user_version = 5;')).toBe(false);
  });

  it('still allows bare introspection PRAGMAs and single quoted/identifier args', () => {
    expect(isReadOnlySql('PRAGMA user_version')).toBe(true);
    expect(isReadOnlySql('PRAGMA user_version;')).toBe(true);
    expect(isReadOnlySql('PRAGMA table_info(nodes)')).toBe(true);
    expect(isReadOnlySql("PRAGMA table_info('nodes')")).toBe(true);
    expect(isReadOnlySql('PRAGMA integrity_check(20)')).toBe(true);
  });

  it('still rejects non-allowlisted pragma names and plain writes', () => {
    expect(isReadOnlySql('PRAGMA cache_size = 99999')).toBe(false);
    expect(isReadOnlySql('PRAGMA journal_mode = WAL')).toBe(false);
    expect(isReadOnlySql('DELETE FROM nodes')).toBe(false);
    expect(isReadOnlySql('SELECT * FROM nodes')).toBe(true);
  });

  // F#30 — `startsWith('SELECT ')` rejected `SELECT\nname...` (newline
  // after the keyword is the same whitespace token as a space, but a
  // literal-space prefix check disagreed). Multi-line SELECT / WITH /
  // EXPLAIN are the agent-natural shape for any non-trivial query.
  it('accepts SELECT / WITH / EXPLAIN with any whitespace after the keyword', () => {
    expect(isReadOnlySql('SELECT\n  name, kind\nFROM nodes')).toBe(true);
    expect(isReadOnlySql('SELECT\tname FROM nodes')).toBe(true);
    expect(isReadOnlySql('WITH\n  recent AS (SELECT id FROM nodes)\nSELECT * FROM recent')).toBe(true);
    expect(isReadOnlySql('EXPLAIN\nSELECT * FROM nodes')).toBe(true);
  });

  it('allows read-only CTEs whose string literals contain write-keyword text', () => {
    expect(isReadOnlySql("WITH c(x) AS (SELECT 'UPDATE') SELECT x FROM c")).toBe(true);
    expect(isReadOnlySql("WITH c(x) AS (SELECT 'DELETE FROM nodes') SELECT x FROM c")).toBe(true);
  });

  it('still rejects identifiers that begin with SELECT/WITH/EXPLAIN substrings', () => {
    expect(isReadOnlySql('SELECTOR')).toBe(false);
    expect(isReadOnlySql('WITHIN')).toBe(false);
    expect(isReadOnlySql('EXPLAINING')).toBe(false);
  });
});

/**
 * CLI/MCP default-page-size parity (friction #32) — the CLI `--limit`
 * option default must match the MCP tool schema's `limit.default` for
 * the same list action, otherwise the same call returns a different
 * page size on the two surfaces. The audit caught `session list`
 * (CLI 10 vs MCP 20) and `note list` (CLI 30 vs MCP 50) diverging.
 */
describe('CLI ↔ MCP list default-limit parity (#32)', () => {
  it('session list --limit default matches cartograph_session schema', async () => {
    const cli = await import('../src/bin/cartograph.js');
    const { SESSION_TOOL } = await import('../src/mcp/tools/session.js');
    expect(cliLimitDefault(cli.program, ['session', 'list'])).toBe(
      mcpLimitDefault(SESSION_TOOL.definition as unknown as Record<string, unknown>),
    );
  });

  it('note --limit default matches cartograph_note schema', async () => {
    const cli = await import('../src/bin/cartograph.js');
    const { NOTE_TOOL } = await import('../src/mcp/tools/note.js');
    expect(cliLimitDefault(cli.program, ['note'])).toBe(
      mcpLimitDefault(NOTE_TOOL.definition as unknown as Record<string, unknown>),
    );
  });
});

/**
 * CLI behaviour parity — spawns the real CLI (`bun src/bin/cartograph.ts`)
 * against this repo's own index. These guard four audited
 * CLI-vs-MCP divergences:
 *   - `sql` exits non-zero on a rejected / invalid query (scripts can
 *     detect failure).
 *   - `find --by name` exact mode returns the container + members set
 *     the MCP tool returns, not a fuzzy relevance rank.
 *   - `coverage <symbol>` positional selects symbol mode.
 *   - `role` with no args produces the project-wide distribution table.
 */
describe('CLI behaviour parity (spawned)', () => {
  const repoRoot = path.join(__dirname, '..');
  const cliEntry = path.join(repoRoot, 'src', 'bin', 'cartograph.ts');
  const indexed = fs.existsSync(path.join(repoRoot, '.cartograph'));

  it.skipIf(!indexed)(
    'sql exits non-zero on a rejected write query',
    () => {
      const { code } = runCli(cliEntry, repoRoot, ['sql', 'DELETE FROM nodes']);
      expect(code).not.toBe(0);
    },
    60_000,
  );

  it.skipIf(!indexed)(
    'sql exits non-zero on an invalid (no such table) query',
    () => {
      const { code } = runCli(cliEntry, repoRoot, ['sql', 'SELECT * FROM no_such_table_xyz']);
      expect(code).not.toBe(0);
    },
    60_000,
  );

  it.skipIf(!indexed)(
    'find --by name exact returns the container + its members',
    () => {
      const { out, code } = runCli(cliEntry, repoRoot, ['find', '--by', 'name', 'GraphTraverser']);
      expect(code).toBe(0);
      // MCP exact mode lists the class then its member methods, not a
      // fuzzy relevance rank with `(NN%)` scores and unrelated imports.
      expect(out).toContain('GraphTraverser (class)');
      expect(out).toContain('traverseBFS (method)');
      expect(out).not.toMatch(/\(\d+%\)/);
    },
    60_000,
  );

  // Handoff #3: `--no-include-tests` was rejected as an unknown option
  // because the CLI registered only `--include-tests`. The fix migrates
  // to Commander's negation form so the help text's "default true"
  // promise becomes a real, flippable flag.
  it('find --help advertises --no-include-tests (handoff #3)', () => {
    const help = runCli(cliEntry, repoRoot, ['find', '--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('--no-include-tests');
  }, 60_000);

  it.skipIf(!indexed)(
    'find --by env --no-include-tests parses without error',
    () => {
      // The repro from handoff #3: previously this exited non-zero with
      // "error: unknown option '--no-include-tests'". After the fix
      // Commander accepts the negation form and the command runs to
      // completion (the empty-state message is acceptable when no env
      // refs match — what matters is that the option was recognized).
      const { code } = runCli(cliEntry, repoRoot, ['find', '--by', 'env', '--no-include-tests']);
      expect(code).toBe(0);
    },
    60_000,
  );

  it.skipIf(!indexed)(
    'coverage with a bare positional symbol selects symbol mode',
    () => {
      const { out, code } = runCli(cliEntry, repoRoot, ['coverage', 'computeMetrics']);
      expect(code).toBe(0);
      expect(out).toMatch(/(?:Coverage for|No coverage data for) `computeMetrics`/);
      expect(out).not.toContain('lowest first');
    },
    60_000,
  );

  it.skipIf(!indexed)(
    'role with no args produces the project-wide distribution table',
    () => {
      const { out, code } = runCli(cliEntry, repoRoot, ['role']);
      expect(code).toBe(0);
      // Bug #12 (2026-05-22) renamed the section title to scope the
      // denominator disclosure — the `(project-wide` prefix is the
      // stable substring; the suffix may carry "classifier-target kinds
      // only" or future qualifiers as the disclosure evolves.
      expect(out).toContain('Role distribution (project-wide');
    },
    60_000,
  );

  // ── CLI ↔ MCP per-flag parity ────────────────────────────────────
  // The surface-alignment test above checks command/action existence
  // only; these guard the per-flag mirrors that a tool-surface audit
  // (2026-05-18) found missing on the CLI side.

  it.skipIf(!indexed)(
    'node accepts the --include-* folds and a batched symbol list',
    () => {
      // cartograph_node supports includeCallers/Callees/Biomarkers/Tests
      // + a batched `symbols` array — the CLI mirror must expose them.
      const help = runCli(cliEntry, repoRoot, ['node', '--help']);
      expect(help.code).toBe(0);
      for (const flag of ['--include-callers', '--include-callees', '--include-biomarkers', '--include-tests']) {
        expect(help.out, `node --help should list ${flag}`).toContain(flag);
      }
      // Batched form: two positional symbols resolve in one call.
      const { out, code } = runCli(cliEntry, repoRoot, [
        'node',
        'handleAtRange',
        'renderDiffRangeReport',
        '--include-biomarkers',
      ]);
      expect(code).toBe(0);
      expect(out).toContain('handleAtRange');
      expect(out).toContain('renderDiffRangeReport');
      expect(out).toContain('Biomarkers:');
    },
    90_000,
  );

  it.skipIf(!indexed)(
    'status accepts the MCP rollup flags and renders Feature Readiness',
    () => {
      const help = runCli(cliEntry, repoRoot, ['status', '--help']);
      expect(help.code).toBe(0);
      for (const flag of ['--verbose', '--top-hotspots', '--top-biomarkers', '--summary-breakdown']) {
        expect(help.out, `status --help should list ${flag}`).toContain(flag);
      }
      // --verbose renders the Feature Readiness rollup the MCP tool shows.
      const { out, code } = runCli(cliEntry, repoRoot, ['status', '--verbose']);
      expect(code).toBe(0);
      expect(out).toContain('Feature Readiness');
    },
    90_000,
  );

  // Handoff #4: --top-hotspots / --top-biomarkers MUST silently coerce
  // negative / 0 / non-numeric / fractional / above-cap inputs to match
  // the MCP-side parseInlineTopN contract. Previously assignIntArg{min:1}
  // wrapped these flags and rejected the same inputs the MCP silently
  // accepted, creating a documented agent-confusing drift.
  it.skipIf(!indexed).each([
    ['0', 'suppress'],
    ['-5', 'suppress'],
    ['1.5', 'floor to 1'],
    ['abc', 'non-numeric → suppress'],
    ['999', 'clamp to MAX'],
  ])(
    'status --top-biomarkers %s exits 0 (%s; handoff #4)',
    (value) => {
      const { code } = runCli(cliEntry, repoRoot, ['status', '--top-biomarkers', value]);
      expect(code).toBe(0);
    },
    60_000,
  );

  // Both flags share `parseInlineTopN`, but a single representative
  // --top-hotspots case guards against a future refactor diverging the
  // two flag wirings (per reviewer suggestion on handoff #4).
  it.skipIf(!indexed)(
    'status --top-hotspots -5 exits 0 (silent suppress, parity with --top-biomarkers)',
    () => {
      const { code } = runCli(cliEntry, repoRoot, ['status', '--top-hotspots', '-5']);
      expect(code).toBe(0);
    },
    60_000,
  );

  it('status --help describes the coerce-on-invalid contract (handoff #4)', () => {
    const help = runCli(cliEntry, repoRoot, ['status', '--help']);
    expect(help.code).toBe(0);
    // Help text now mirrors the MCP schema description — no more
    // contradictory "Clamped to [1, 30]" on a flag that rejects 0.
    // Commander word-wraps long help text, so we match each phrase
    // separately rather than across a line break.
    expect(help.out).toContain('Negative / non-numeric');
    expect(help.out).toContain('suppressed');
    expect(help.out).not.toMatch(/Clamped to \[1, \d+\]/);
  }, 60_000);

  it.skipIf(!indexed)(
    'at-range accepts the bulk --ranges mode',
    () => {
      const help = runCli(cliEntry, repoRoot, ['at-range', '--help']);
      expect(help.code).toBe(0);
      expect(help.out).toContain('--ranges');
      const { out, code } = runCli(cliEntry, repoRoot, ['at-range', '--ranges', 'src/mcp/tools/at-range.ts:671-692']);
      expect(code).toBe(0);
      expect(out).toContain('renderDiffRangeReport');
    },
    60_000,
  );

  it.skipIf(!indexed)(
    'affected surfaces the traversal count on the human surface',
    () => {
      const { out, code } = runCli(cliEntry, repoRoot, ['affected', 'src/mcp/tools/at-range.ts']);
      expect(code).toBe(0);
      // The MCP tool prints "Traversed N dependents total." — the CLI
      // direct implementation must mirror that blast-radius signal.
      expect(out).toMatch(/Traversed \d+ dependents? total\./);
    },
    60_000,
  );
});
