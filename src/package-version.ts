import * as fs from 'node:fs';
import { resolveAssetPath } from './assets.js';

function readPackageVersion(): string {
  try {
    const raw = fs.readFileSync(resolveAssetPath('package.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const CARTOGRAPH_PACKAGE_VERSION = readPackageVersion();
