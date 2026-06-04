import * as fs from 'node:fs';
import * as path from 'node:path';

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
    const parsed = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as unknown;
    const obj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    const rawScripts = obj['scripts'];
    if (!rawScripts || typeof rawScripts !== 'object' || Array.isArray(rawScripts)) return {};
    return Object.fromEntries(
      Object.entries(rawScripts as Record<string, unknown>).filter((entry): entry is [string, string] => {
        return typeof entry[1] === 'string';
      }),
    );
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
