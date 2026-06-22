import * as fs from 'node:fs';
import * as path from 'node:path';
import { readPackageJsonScripts } from './package-manifest.js';

export type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm';

export function detectPackageManager(projectRoot: string): PackageManager {
  if (fs.existsSync(path.join(projectRoot, 'bun.lock')) || fs.existsSync(path.join(projectRoot, 'bun.lockb'))) {
    return 'bun';
  }
  if (fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(projectRoot, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

export function packageJsonExists(projectRoot: string): boolean {
  return fs.existsSync(path.join(projectRoot, 'package.json'));
}

export function readPackageScripts(projectRoot: string): Record<string, string> {
  try {
    return readPackageJsonScripts(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

export function packageScriptCommand(manager: PackageManager, script: string, args: string[] = []): string {
  const suffix = args.length > 0 ? ` -- ${args.map(shellQuote).join(' ')}` : '';
  switch (manager) {
    case 'bun':
      return `bun run ${script}${suffix}`;
    case 'pnpm':
      return `pnpm run ${script}${suffix}`;
    case 'yarn':
      return `yarn run ${script}${suffix}`;
    case 'npm':
      return script === 'test' ? `npm test${suffix}` : `npm run ${script}${suffix}`;
  }
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  const escapedSingleQuote = String.raw`'\''`;
  return "'" + value.replaceAll("'", escapedSingleQuote) + "'";
}
