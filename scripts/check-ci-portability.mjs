#!/usr/bin/env node
/**
 * CI portability guardrail.
 *
 * GitHub runners only have the tools installed by the workflow plus the
 * project's npm dependencies. CI-invoked scripts may use fast local tools
 * like `rg`, but only when they have a fallback such as `git grep` or a
 * Node filesystem traversal.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'check.yml');
const packageJsonPath = path.join(repoRoot, 'package.json');
const NONSTANDARD_COMMANDS = ['rg', 'fd', 'ag'];

function readRel(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

function ciNpmScripts(workflowText) {
  const out = new Set();
  for (const match of workflowText.matchAll(/run:\s*npm run ([\w:-]+)/g)) {
    out.add(match[1]);
  }
  return [...out].sort();
}

function firstCommand(script) {
  const trimmed = script.trim();
  const match = /^([A-Za-z0-9_./:-]+)/.exec(trimmed);
  return match?.[1] ?? '';
}

function scriptFileFromPackageCommand(script) {
  const match = /^(?:[A-Z0-9_]+=("[^"]*"|'[^']*'|[^ ]+)\s+)*(node|bun|bash)\s+([^ \t;&|]+)/.exec(script.trim());
  return match?.[3] ?? null;
}

function hasBareNonstandardCommand(command) {
  return NONSTANDARD_COMMANDS.some((tool) => new RegExp(`(^|[;&|]\\s*)${tool}(\\s|$)`).test(command));
}

function hasDirectNonstandardInvocation(source, tool) {
  const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`\\b(?:spawnSync|spawn|execFileSync|execFile)\\(\\s*['"]${escaped}['"]`),
    new RegExp(`\\brun\\(\\s*['"]${escaped}['"]`),
  ].some((re) => re.test(source));
}

function hasFallbackFor(source, tool) {
  if (tool === 'rg') return /\bgit grep\b/.test(source) || /\bfs\.readdirSync\b/.test(source);
  return /\bfs\.readdirSync\b/.test(source);
}

const workflow = fs.readFileSync(workflowPath, 'utf8');
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const ciScripts = ciNpmScripts(workflow);
const failures = [];

for (const match of workflow.matchAll(/run:\s*([^\n]+)/g)) {
  const command = match[1].trim();
  if (hasBareNonstandardCommand(command)) {
    failures.push(`workflow command uses a local-only binary without an install/fallback: ${command}`);
  }
}

for (const scriptName of ciScripts) {
  const command = pkg.scripts?.[scriptName];
  if (typeof command !== 'string') {
    failures.push(`workflow runs missing package script: ${scriptName}`);
    continue;
  }

  if (hasBareNonstandardCommand(command)) {
    failures.push(`package script ${scriptName} uses a local-only binary directly: ${command}`);
  }

  const entry = scriptFileFromPackageCommand(command);
  if (!entry) {
    const commandName = firstCommand(command);
    if (!commandName) failures.push(`package script ${scriptName} is empty`);
    continue;
  }

  const entryPath = path.join(repoRoot, entry);
  if (!fs.existsSync(entryPath)) {
    failures.push(`package script ${scriptName} points at missing script file: ${entry}`);
    continue;
  }

  const source = readRel(entry);
  for (const tool of NONSTANDARD_COMMANDS) {
    if (hasDirectNonstandardInvocation(source, tool) && !hasFallbackFor(source, tool)) {
      failures.push(
        `CI-invoked script ${entry} invokes \`${tool}\` without a fallback. ` +
          'Install it in the workflow or add a git/Node fallback.',
      );
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`CI portability check failed:\n- ${failures.join('\n- ')}\n`);
  process.exit(1);
}

console.log(`CI portability check passed for ${ciScripts.length} workflow npm scripts.`);
