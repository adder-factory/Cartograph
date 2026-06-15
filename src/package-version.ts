import * as fs from 'node:fs';
import { resolveAssetPath } from './assets.js';

/**
 * Read the version from the on-disk `package.json` asset RIGHT NOW
 * (uncached). Unlike {@link CARTOGRAPH_PACKAGE_VERSION}, which freezes the
 * value at module-load time, this re-reads disk on every call so callers
 * can detect an in-place upgrade: a running process keeps the old constant
 * in memory while `cartograph upgrade --apply` (or a manual re-pin)
 * replaces the files underneath it. Returns null when the asset is
 * missing/unparseable (e.g. a sandboxed env) so callers can stay silent
 * rather than report a bogus skew.
 */
export function readOnDiskPackageVersion(): string | null {
  try {
    const raw = fs.readFileSync(resolveAssetPath('package.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version.trim() !== '' ? parsed.version.trim() : null;
  } catch {
    return null;
  }
}

export const CARTOGRAPH_PACKAGE_VERSION = readOnDiskPackageVersion() ?? '0.0.0';
