import { describe, expect, it } from 'bun:test';
import {
  assertBytesOmitBuildRoots,
  buildRootVariants,
  patchRe2GlueForStandalone,
  patchUsearchForStandalone,
  usearchPrebuildRelativePath,
} from '../scripts/standalone-build-privacy.js';

describe('standalone build privacy', () => {
  it('removes re2-wasm build-directory metadata while preserving runtime asset lookup', () => {
    const source = ['const before = true;', "scriptDirectory = __dirname + '/';", 'const after = true;'].join('\n');

    const patched = patchRe2GlueForStandalone(source);

    expect(patched).not.toContain('__dirname');
    expect(patched).toContain('CARTOGRAPH_ASSET_ROOT');
    expect(patched).toContain('process.cwd()');
  });

  it('fails closed when the upstream re2-wasm glue shape changes', () => {
    expect(() => patchRe2GlueForStandalone('scriptDirectory = import.meta.dirname;')).toThrow(
      're2-wasm glue no longer contains the expected scriptDirectory line',
    );
  });

  it('routes usearch native loading through the standalone asset root', () => {
    const source = [
      'import build from "node-gyp-build";',
      'import * as path from "path";',
      'import { getFileName, getRoot } from "bindings";',
      'function getDirName() {',
      '    try {',
      '        if (__dirname)',
      '            return __dirname;',
      '    }',
      '    catch (e) { }',
      '    return getRoot(getFileName());',
      '}',
      '// dummy code for ncc to include the native module',
      'if (process.uptime() < 0) {',
      '    require(__dirname + "/../../../prebuilds/darwin-arm64+x64/usearch.node");',
      '    require(__dirname + "/../../../prebuilds/linux-arm64/usearch.node");',
      '    require(__dirname + "/../../../prebuilds/linux-x64/usearch.node");',
      '    require(__dirname + "/../../../prebuilds/win32-ia32/usearch.node");',
      '    require(__dirname + "/../../../prebuilds/win32-x64/usearch.node");',
      '    require(__dirname + "/../../../build/Release/usearch.node");',
      '}',
    ].join('\n');

    const patched = patchUsearchForStandalone(source);

    expect(patched).toContain('CARTOGRAPH_ASSET_ROOT');
    expect(patched).toContain('path.join(assetRoot, "usearch")');
    expect(patched).not.toContain('__dirname');
    expect(patched).not.toContain('from "bindings"');
    expect(patched).not.toContain('dummy code for ncc');
  });

  it('fails closed when the upstream usearch loader shape changes', () => {
    expect(() => patchUsearchForStandalone('const compiled = loadNative();')).toThrow(
      'usearch loader no longer matches the expected standalone patch shape',
    );
  });

  it('maps supported standalone targets to their packaged usearch prebuild', () => {
    expect(usearchPrebuildRelativePath('darwin-arm64')).toBe('darwin-arm64+x64/usearch.node');
    expect(usearchPrebuildRelativePath('darwin-x64')).toBe('darwin-arm64+x64/usearch.node');
    expect(usearchPrebuildRelativePath('linux-arm64')).toBe('linux-arm64/usearch.node');
    expect(usearchPrebuildRelativePath('linux-x64')).toBe('linux-x64/usearch.node');
    expect(usearchPrebuildRelativePath('windows-x64')).toBeNull();
  });

  it('rejects a compiled binary containing the checkout root', () => {
    const root = '/private/build/cartograph';
    const bytes = new TextEncoder().encode(`prefix:${root}/node_modules/example:suffix`);

    expect(() => assertBytesOmitBuildRoots(bytes, [root])).toThrow('compiled binary embeds a build-root variant');
  });

  it('allows compiled bytes that contain no checkout root', () => {
    const bytes = new TextEncoder().encode('portable standalone binary');

    expect(() => assertBytesOmitBuildRoots(bytes, ['/private/build/cartograph'])).not.toThrow();
  });

  it('covers resolved, realpath, separator, escaped, and case-normalized Windows roots', () => {
    const variants = buildRootVariants('C:\\Users\\Alice\\Cartograph', 'c:\\users\\Alice\\Cartograph', 'win32');

    expect(variants).toContain('C:\\Users\\Alice\\Cartograph');
    expect(variants).toContain('C:/Users/Alice/Cartograph');
    expect(variants).toContain('C:\\\\Users\\\\Alice\\\\Cartograph');
    expect(variants).toContain('c:\\users\\alice\\cartograph');
    expect(variants).toContain('C:\\USERS\\ALICE\\CARTOGRAPH');
  });

  it('rejects every derived Windows build-root representation', () => {
    const variants = buildRootVariants('C:\\Users\\Alice\\Cartograph', 'c:\\users\\Alice\\Cartograph', 'win32');

    for (const variant of variants) {
      const bytes = new TextEncoder().encode(`prefix:${variant}/node_modules/example:suffix`);
      expect(() => assertBytesOmitBuildRoots(bytes, variants)).toThrow('compiled binary embeds a build-root variant');
    }
  });
});
