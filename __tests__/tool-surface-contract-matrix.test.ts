/**
 * Registry-level tool surface contract matrix.
 *
 * Runtime smoke lives in `tool-surface-smoke.test.ts`: it opens a tiny
 * indexed repo, calls every MCP handler, and spawns every CLI command's
 * `--help`. This file stays lighter and checks the authored contracts
 * before runtime dispatch:
 * - every registered tool has schema-valid minimal MCP args;
 * - schema defaults are applied by the shared normalizer;
 * - unknown MCP args produce structured warnings;
 * - enum/action mistakes fail at the schema boundary;
 * - every registered tool still has a top-level CLI help surface.
 */
import { describe, expect, it } from 'vitest';
import type { Command } from 'commander';
import { getToolModules } from '../src/mcp/tools/registry.js';
import type { ToolModule } from '../src/mcp/tools/types.js';
import type { ToolDefinition } from '../src/mcp/tool-types.js';
import { normalizeToolArgs } from '../src/mcp/tools/_arg-normalizer.js';

const UNKNOWN_ARG = 'definitelyNotASchemaFieldForMatrix';

function defaultCommandName(toolName: string): string {
  return toolName.replace(/^cartograph_/, '').replaceAll('_', '-');
}

function findMirrorCommand(program: Command, toolName: string): Command | undefined {
  const wanted = defaultCommandName(toolName);
  return program.commands.find((cmd) => cmd.name() === wanted);
}

function placeholderFor(schema: ToolDefinition['inputSchema']['properties'][string]): unknown {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.type === 'integer' || schema.type === 'number') return 1;
  if (schema.type === 'boolean') return false;
  if (schema.type === 'array') return [];
  return 'fixtureAlpha';
}

function minimalSchemaArgs(mod: ToolModule): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const props = mod.definition.inputSchema.properties;
  for (const name of mod.definition.inputSchema.required ?? []) {
    const schema = props[name];
    if (!schema || 'default' in schema) continue;
    args[name] = placeholderFor(schema);
  }
  return args;
}

function defaultedProps(mod: ToolModule): Array<{ name: string; value: unknown }> {
  const out: Array<{ name: string; value: unknown }> = [];
  for (const [name, schema] of Object.entries(mod.definition.inputSchema.properties)) {
    if ('default' in schema) out.push({ name, value: schema.default });
  }
  return out;
}

function firstEnumProp(mod: ToolModule): { name: string; values: readonly string[] } | null {
  for (const [name, schema] of Object.entries(mod.definition.inputSchema.properties)) {
    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
      return { name, values: schema.enum };
    }
  }
  return null;
}

describe('registered tool surface contract matrix', () => {
  it('covers every registered tool with schema-valid minimal MCP args', () => {
    const failures: string[] = [];
    for (const mod of getToolModules()) {
      const args = minimalSchemaArgs(mod);
      const result = normalizeToolArgs(mod, args);
      if (!result.ok) failures.push(`${mod.definition.name}: ${result.error} (args=${JSON.stringify(args)})`);
    }

    expect(failures, `minimal MCP arg contract failures:\n${failures.join('\n')}`).toEqual([]);
  });

  it('applies declared schema defaults through the shared MCP normalizer', () => {
    const failures: string[] = [];
    for (const mod of getToolModules()) {
      const defaults = defaultedProps(mod);
      if (defaults.length === 0) continue;

      const args = minimalSchemaArgs(mod);
      const result = normalizeToolArgs(mod, args);
      if (!result.ok) {
        failures.push(`${mod.definition.name}: could not normalize defaults input: ${result.error}`);
        continue;
      }
      for (const { name, value } of defaults) {
        if (JSON.stringify(result.data[name]) !== JSON.stringify(value)) {
          failures.push(
            `${mod.definition.name}.${name}: expected default ${JSON.stringify(value)}, got ${JSON.stringify(
              result.data[name],
            )}`,
          );
        }
      }
    }

    expect(failures, `schema default normalization drift:\n${failures.join('\n')}`).toEqual([]);
  });

  it('reports unknown MCP arguments as structured warnings rather than silently dropping them', () => {
    const failures: string[] = [];
    for (const mod of getToolModules()) {
      const result = normalizeToolArgs(mod, { ...minimalSchemaArgs(mod), [UNKNOWN_ARG]: true });
      if (!result.ok) {
        failures.push(`${mod.definition.name}: unexpected validation failure with unknown arg: ${result.error}`);
        continue;
      }
      const warning = result.warnings.find((item) => item.includes(UNKNOWN_ARG));
      if (!warning) failures.push(`${mod.definition.name}: missing unknown-argument warning for ${UNKNOWN_ARG}`);
    }

    expect(failures, `unknown-argument contract failures:\n${failures.join('\n')}`).toEqual([]);
  });

  it('rejects invalid enum/action values with field-specific schema errors', () => {
    const failures: string[] = [];
    for (const mod of getToolModules()) {
      const target = firstEnumProp(mod);
      if (!target) continue;

      const result = normalizeToolArgs(mod, { ...minimalSchemaArgs(mod), [target.name]: '__invalid_enum_value__' });
      if (result.ok) {
        failures.push(`${mod.definition.name}.${target.name}: invalid enum value was accepted`);
        continue;
      }
      if (!result.error.includes(target.name)) {
        failures.push(`${mod.definition.name}.${target.name}: error did not name field (${result.error})`);
      }
    }

    expect(failures, `enum/action validation contract failures:\n${failures.join('\n')}`).toEqual([]);
  });

  it('every registered MCP tool has a top-level CLI help surface', async () => {
    const cli = await import('../src/bin/cartograph.js');
    const failures: string[] = [];

    for (const mod of getToolModules()) {
      const cmd = findMirrorCommand(cli.program, mod.definition.name);
      if (!cmd) {
        failures.push(
          `${mod.definition.name}: no top-level CLI command named ${defaultCommandName(mod.definition.name)}`,
        );
        continue;
      }
      const help = cmd.helpInformation();
      if (!/[Uu]sage:/.test(help)) {
        failures.push(`${mod.definition.name}: CLI help for ${cmd.name()} has no Usage section`);
      }
    }

    expect(failures, `CLI help surface contract failures:\n${failures.join('\n')}`).toEqual([]);
  });
});
