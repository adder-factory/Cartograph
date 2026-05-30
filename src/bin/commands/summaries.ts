/**
 * `cartograph summaries` family subcommands — extracted from the
 * bin/cartograph.ts decomposition; side-effecting module: importing it
 * registers the commands on `summariesCmd`.
 */
import { summariesCmd, error, assignIntArg, runViaMCP, installFamilyActionAlias } from '../_cli-core.js';
import * as fs from 'node:fs';
import { errMsg } from '../../errors.js';

/**
 * `--action <name>` alias on the family parent so the MCP shape
 * `cartograph summaries --action pending` parses (mirrors the MCP
 * arg name without changing the canonical subcommand form
 * `cartograph summaries pending`). The alias is wired by an argv-
 * preprocessing hook below — see `installFamilyActionAlias`.
 */
installFamilyActionAlias(summariesCmd, 'summaries', 'action');

summariesCmd
  .command('pending')
  .description(
    "Pull a batch of symbols needing summaries (agent-bridge; mirrors cartograph_summaries MCP tool with action='pending')",
  )
  .option('-p, --project-path <path>', 'Project path')
  .option('-l, --limit <n>', 'Batch size (default 20, max 40)', '20')
  .option('--model-hint <m>', 'Model label to record (default "agent-cli", matching the `summaries save` default)')
  .action(async (options: { projectPath?: string; limit?: string; modelHint?: string }) => {
    const args: Record<string, unknown> = { action: 'pending' };
    if (
      !assignIntArg({
        args,
        key: 'limit',
        raw: options.limit ?? '20',
        optionName: '--limit',
        opts: { min: 1, max: 40 },
      })
    )
      return;
    // Default the model hint to 'agent-cli' so the default CLI round-trip
    // (`summaries pending | summaries save`) records the pending batch and
    // saves it under one consistent label — `summaries save` also defaults
    // `model` to 'agent-cli'. Without this the pending batch falls back to
    // the MCP-layer 'agent-mcp' default and never matches on a re-run.
    args['modelHint'] = options.modelHint ?? 'agent-cli';
    await runViaMCP('cartograph_summaries', args, options.projectPath);
  });

summariesCmd
  .command('save [json-file]')
  .description(
    "Persist agent-generated summaries from a JSON file or stdin (mirrors cartograph_summaries MCP tool with action='save')",
  )
  .option('-p, --project-path <path>', 'Project path')
  .option('--model <m>', 'Model label to record (default "agent-cli")')
  .action(async (jsonFile: string | undefined, options: { projectPath?: string; model?: string }) => {
    let raw: string;
    if (jsonFile) {
      // Guard the read so a missing file yields a clean error + non-zero
      // exit instead of a raw Node ENOENT stack trace.
      try {
        raw = fs.readFileSync(jsonFile, 'utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          error(`summaries save: file not found: ${jsonFile}`);
        } else {
          error(`summaries save: could not read file ${jsonFile}: ${errMsg(err)}`);
        }
        process.exit(1);
      }
    } else {
      // Read from stdin.
      raw = await new Promise<string>((resolve, reject) => {
        let buf = '';
        process.stdin.setEncoding('utf-8');
        process.stdin.on('data', (c) => (buf += c));
        process.stdin.on('end', () => resolve(buf));
        process.stdin.on('error', reject);
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      error(`Could not parse summaries JSON: ${errMsg(err)}`);
      process.exit(1);
    }
    // Accept both shapes: a bare array of summary items, or the
    // `summaries pending` envelope `{items: [...], remaining, total, ...}`.
    // The former lets ad-hoc scripts pipe in just the data; the latter
    // lets `cartograph summaries pending | cartograph summaries save` work
    // without an intermediate jq filter.
    const items = Array.isArray(parsed) ? parsed : (parsed as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) {
      error('Expected a JSON array of {nodeId, contentHash, summary} or {"items":[...]}.');
      process.exit(1);
    }
    const args: Record<string, unknown> = { action: 'save', items };
    // Always forward the model label — default to 'agent-cli' so the
    // stored provenance matches what --help documents. When omitted the
    // MCP tool's own default is 'agent-mcp', which is wrong for a CLI
    // caller (FRICTION item F/summaries-save).
    args['model'] = options.model ?? 'agent-cli';
    await runViaMCP('cartograph_summaries', args, options.projectPath);
  });
