/**
 * resolveWebTreeSitterAsset — the module-resolution fallback that
 * rescues install-from-git global installs (field report #2 trap 1):
 * dependencies hoist to the package manager's global root, where the
 * static sibling-path guesses in resolveAssetPath never look.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { resolveAssetPath, resolveWebTreeSitterAsset } from '../src/assets.js';

describe('web-tree-sitter wasm resolution', () => {
  it('module-resolution fallback finds the dependency copy', () => {
    const resolved = resolveWebTreeSitterAsset('web-tree-sitter.wasm');
    expect(resolved).not.toBeNull();
    expect(fs.existsSync(resolved!)).toBe(true);
    expect(resolved!).toMatch(/web-tree-sitter[\/\\]web-tree-sitter\.wasm$/);
  });

  it('resolveAssetPath returns an EXISTING wasm path end-to-end', () => {
    const p = resolveAssetPath('web-tree-sitter.wasm');
    expect(fs.existsSync(p)).toBe(true);
  });

  it('returns null for assets the dependency does not ship', () => {
    expect(resolveWebTreeSitterAsset('definitely-not-shipped.bin')).toBeNull();
  });
});
