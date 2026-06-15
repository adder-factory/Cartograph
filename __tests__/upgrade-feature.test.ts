import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkUpgrade,
  compareVersions,
  detectVersionSkew,
  fetchLatestPublishedVersion,
  renderUpgradeCheck,
} from '../src/features/upgrade/index.js';
import {
  canRepinBunGlobal,
  detectInstallMethod,
  isRepinnableCartographSpec,
  runBunGlobalRepin,
  runSourceUpgrade,
} from '../src/features/upgrade/source-update.js';

describe('upgrade feature', () => {
  it('compares semver-like versions', () => {
    expect(compareVersions('0.7.2', '0.7.3')).toBeLessThan(0);
    expect(compareVersions('0.8.0', '0.7.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('reports update availability without applying mutations', async () => {
    const result = await checkUpgrade({
      currentVersion: '0.7.2',
      latestVersion: '0.8.0',
      apply: true,
    });

    expect(result.status).toBe('update_available');
    expect(result.applied).toBe(false);
    expect(result.nextSteps.join('\n')).toContain('git pull');
    expect(renderUpgradeCheck(result)).toContain('Cartograph 0.8.0 is available');
  });

  it('tailors non-source update steps to the install method', async () => {
    const standalone = await checkUpgrade({
      currentVersion: '0.7.2',
      latestVersion: '0.8.0',
      method: 'standalone',
    });
    expect(standalone.nextSteps.join('\n')).toContain('install.sh');

    const packaged = await checkUpgrade({
      currentVersion: '0.7.2',
      latestVersion: '0.8.0',
      method: 'package',
    });
    const packagedSteps = packaged.nextSteps.join('\n');
    // The correct re-pin command, with the resolved version as the tag.
    // git+https (real clone), NOT the github: shorthand whose tarball-API
    // path 504s (issue #23).
    expect(packagedSteps).toContain('bun add -g git+https://github.com/adder-factory/cartograph.git#v0.8.0');
    expect(packagedSteps).not.toContain('github:adder-factory/cartograph');
    expect(packagedSteps).toContain('bun remove -g @adder-factory/cartograph');
    // Cartograph isn't on npm — never suggest npm, and `bun update -g`
    // can't move a pinned tag, so neither of the old footguns appears.
    expect(packagedSteps).not.toContain('npm install');
    expect(packagedSteps).not.toContain('bun update -g');
  });

  it('applies a package re-pin in place via the injected executor', async () => {
    const seen: string[] = [];
    const result = await checkUpgrade({
      currentVersion: '0.7.2',
      latestVersion: '0.8.0',
      apply: true,
      method: 'package',
      applyPackage: (latestVersion) => {
        seen.push(latestVersion);
      },
    });
    expect(seen).toEqual(['0.8.0']);
    expect(result.status).toBe('updated');
    expect(result.applied).toBe(true);
    expect(result.message).toContain('0.7.2 → 0.8.0');
    // Restart is surfaced as a prominent warning (issue #13 risk).
    expect(result.warning).toContain('Restart');
    expect(result.warning).toContain('#13');
  });

  it('blocks (with manual steps) when the package re-pin throws', async () => {
    const result = await checkUpgrade({
      currentVersion: '0.7.2',
      latestVersion: '0.8.0',
      apply: true,
      method: 'package',
      applyPackage: () => {
        throw new Error('network down');
      },
    });
    expect(result.status).toBe('blocked');
    expect(result.applied).toBe(false);
    expect(result.message).toContain('network down');
    const blockedSteps = result.nextSteps.join('\n');
    expect(blockedSteps).toContain('bun add -g git+https://github.com/adder-factory/cartograph.git#v0.8.0');
    // Fallback to the standalone installer when the re-pin keeps failing.
    expect(blockedSteps).toContain('install.sh');
  });

  it('surfaces registry lookup failures as unknown status', async () => {
    const result = await checkUpgrade({
      currentVersion: '0.7.2',
      fetchLatestVersion: async () => {
        throw new Error('offline');
      },
    });

    expect(result.status).toBe('unknown');
    expect(result.warning).toContain('offline');
  });
});

describe('detectVersionSkew', () => {
  it('flags a strictly newer on-disk version (in-place upgrade, server not restarted)', () => {
    expect(detectVersionSkew('1.1.5', '1.1.6')).toEqual({ running: '1.1.5', onDisk: '1.1.6' });
  });

  it('stays silent when on-disk equals or trails the running version, or is unreadable', () => {
    expect(detectVersionSkew('1.1.5', '1.1.5')).toBeNull();
    expect(detectVersionSkew('1.1.6', '1.1.5')).toBeNull();
    expect(detectVersionSkew('1.1.5', null)).toBeNull();
  });
});

describe('isRepinnableCartographSpec', () => {
  it('accepts both the git+https clone form and the legacy github: shorthand, tagged or not', () => {
    expect(isRepinnableCartographSpec('git+https://github.com/adder-factory/cartograph.git#v1.1.5')).toBe(true);
    expect(isRepinnableCartographSpec('git+https://github.com/adder-factory/cartograph.git')).toBe(true);
    expect(isRepinnableCartographSpec('github:adder-factory/cartograph#v1.0.5')).toBe(true);
    expect(isRepinnableCartographSpec('github:adder-factory/cartograph')).toBe(true);
  });

  it('rejects semver ranges, unrelated repos, and prefix look-alikes (boundary-anchored)', () => {
    expect(isRepinnableCartographSpec('^1.0.0')).toBe(false);
    expect(isRepinnableCartographSpec('github:someone/else#v1')).toBe(false);
    expect(isRepinnableCartographSpec('git+https://github.com/someone/else.git#v1')).toBe(false);
    // A different repo that merely shares this one's name prefix must NOT qualify.
    expect(isRepinnableCartographSpec('github:adder-factory/cartograph-other#v1')).toBe(false);
  });
});

describe('install method detection', () => {
  it('classifies this repository as a source checkout', () => {
    const method = detectInstallMethod();
    expect(method.kind).toBe('source');
    if (method.kind === 'source') {
      expect(fs.realpathSync(method.root)).toBe(fs.realpathSync(path.resolve(__dirname, '..')));
    }
  });

  it('classifies Bun standalone virtual paths as standalone', () => {
    expect(detectInstallMethod('file:///$bunfs/root/cartograph')).toEqual({ kind: 'standalone' });
  });

  it('returns unknown for unparseable module URLs', () => {
    expect(detectInstallMethod('not-a-url')).toEqual({ kind: 'unknown' });
  });
});

describe('Bun-global re-pin (#1/#2 upgrade improvements)', () => {
  let dir: string;
  let pkgRoot: string;
  beforeEach(() => {
    // Mimic a Bun global: <global>/node_modules/@adder-factory/cartograph
    // with the manifest at <global>/package.json pinning a GitHub tag.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-upgrade-repin-'));
    pkgRoot = path.join(dir, 'node_modules', '@adder-factory', 'cartograph');
    fs.mkdirSync(pkgRoot, { recursive: true });
    fs.writeFileSync(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: '@adder-factory/cartograph' }));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeManifest(spec: string): void {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ dependencies: { '@adder-factory/cartograph': spec } }),
    );
  }

  it('detects a legacy github:-tag Bun global as re-pinnable (back-compat)', () => {
    writeManifest('github:adder-factory/cartograph#v1.0.5');
    expect(canRepinBunGlobal(pkgRoot, dir)).toBe(true);
  });

  it('detects a git+https-tag Bun global as re-pinnable (current install form)', () => {
    writeManifest('git+https://github.com/adder-factory/cartograph.git#v1.1.5');
    expect(canRepinBunGlobal(pkgRoot, dir)).toBe(true);
  });

  it('does NOT treat a non-GitHub spec or a missing manifest as re-pinnable', () => {
    writeManifest('^1.0.0');
    expect(canRepinBunGlobal(pkgRoot, dir)).toBe(false);
    fs.rmSync(path.join(dir, 'package.json'));
    expect(canRepinBunGlobal(pkgRoot, dir)).toBe(false);
  });

  it('rejects a project-LOCAL install even with a GitHub spec (reviewer R1 — no global clobber)', () => {
    // A project that installs cartograph locally AND lists it with a
    // GitHub spec must NOT qualify: `bun remove -g` would wipe the
    // user's separate GLOBAL install. The package root is NOT under the
    // (different) Bun global dir, so re-pin is refused.
    writeManifest('github:adder-factory/cartograph#v1.0.5'); // <dir>/package.json = the "project"
    const someOtherBunGlobal = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-other-global-'));
    try {
      expect(canRepinBunGlobal(pkgRoot, someOtherBunGlobal)).toBe(false);
    } finally {
      fs.rmSync(someOtherBunGlobal, { recursive: true, force: true });
    }
  });

  it('removes then re-adds via git+https, migrating a legacy github: pin off the 504-prone tarball path', () => {
    writeManifest('github:adder-factory/cartograph#v1.0.5');
    const calls: string[][] = [];
    runBunGlobalRepin('1.0.8', (args) => calls.push(args), dir);
    expect(calls).toEqual([
      ['remove', '-g', '@adder-factory/cartograph'],
      ['add', '-g', 'git+https://github.com/adder-factory/cartograph.git#v1.0.8'],
    ]);
  });

  it('rolls back to the previous spec when the add fails, then rethrows', () => {
    writeManifest('github:adder-factory/cartograph#v1.0.5');
    const calls: string[][] = [];
    const runner = (args: string[]): void => {
      calls.push(args);
      if (args[0] === 'add' && args[2]?.includes('#v1.0.8')) throw new Error('add failed');
    };
    expect(() => runBunGlobalRepin('1.0.8', runner, dir)).toThrow('add failed');
    // remove → add(new, throws) → add(previous spec, rollback)
    expect(calls.some((c) => c[0] === 'remove')).toBe(true);
    expect(calls.some((c) => c[0] === 'add' && c[2] === 'github:adder-factory/cartograph#v1.0.5')).toBe(true);
  });

  it('skips rollback (no double-add) when no previous spec is found, still rethrows', () => {
    // No <dir>/package.json → previousSpec is null. The remove + failed
    // add still run; rollback is a no-op (reviewer R4 edge).
    const calls: string[][] = [];
    const runner = (args: string[]): void => {
      calls.push(args);
      if (args[0] === 'add') throw new Error('add failed');
    };
    expect(() => runBunGlobalRepin('1.0.8', runner, dir)).toThrow('add failed');
    expect(calls.filter((c) => c[0] === 'add')).toHaveLength(1); // no rollback re-add
  });
});

describe('source self-update (real git fixtures)', () => {
  let tmpDir: string;
  let originDir: string;
  let checkoutDir: string;

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  }

  function configureIdentity(dir: string): void {
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'commit.gpgsign', 'false');
  }

  function writeVersion(dir: string, version: string): void {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      `${JSON.stringify({ name: '@adder-factory/cartograph', version }, null, 2)}\n`,
    );
  }

  /** Commit a version bump in the origin repo so the clone falls behind. */
  function bumpOrigin(version: string): void {
    writeVersion(originDir, version);
    git(originDir, 'commit', '-q', '-am', `release ${version}`);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-upgrade-'));
    originDir = path.join(tmpDir, 'origin');
    checkoutDir = path.join(tmpDir, 'checkout');
    fs.mkdirSync(originDir);
    git(originDir, 'init', '-q', '-b', 'main');
    configureIdentity(originDir);
    writeVersion(originDir, '0.7.2');
    git(originDir, 'add', '.');
    git(originDir, 'commit', '-q', '-m', 'init 0.7.2');
    git(tmpDir, 'clone', '-q', originDir, checkoutDir);
    configureIdentity(checkoutDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports current when the checkout matches upstream', async () => {
    const result = await runSourceUpgrade({ root: checkoutDir, currentVersion: '0.7.2', apply: false });
    expect(result.status).toBe('current');
    expect(result.method).toBe('source');
    expect(result.message).toContain('origin/main');
  });

  it('treats local-commits-only (ahead, not behind) as current', async () => {
    fs.writeFileSync(path.join(checkoutDir, 'local.txt'), 'local\n');
    git(checkoutDir, 'add', '.');
    git(checkoutDir, 'commit', '-q', '-m', 'local work');

    const result = await runSourceUpgrade({ root: checkoutDir, currentVersion: '0.7.2', apply: false });
    expect(result.status).toBe('current');
    expect(result.message).toContain('local commit');
  });

  it('reports update_available with the upstream version delta', async () => {
    bumpOrigin('0.7.3');

    const result = await runSourceUpgrade({ root: checkoutDir, currentVersion: '0.7.2', apply: false });
    expect(result.status).toBe('update_available');
    expect(result.applied).toBe(false);
    expect(result.latestVersion).toBe('0.7.3');
    expect(result.message).toContain('1 commit(s) behind');
    expect(result.message).toContain('0.7.2 → 0.7.3');
    expect(result.nextSteps.join('\n')).toContain('cartograph upgrade --apply');
  });

  it('fast-forwards the checkout and reinstalls dependencies on apply', async () => {
    bumpOrigin('0.7.3');
    const installRoots: string[] = [];

    const result = await runSourceUpgrade({
      root: checkoutDir,
      currentVersion: '0.7.2',
      apply: true,
      runInstall: (root) => installRoots.push(root),
    });

    expect(result.status).toBe('updated');
    expect(result.applied).toBe(true);
    expect(result.latestVersion).toBe('0.7.3');
    expect(installRoots).toEqual([checkoutDir]);
    expect(git(checkoutDir, 'rev-parse', 'HEAD')).toBe(git(originDir, 'rev-parse', 'HEAD'));
    const updated = JSON.parse(fs.readFileSync(path.join(checkoutDir, 'package.json'), 'utf-8')) as {
      version: string;
    };
    expect(updated.version).toBe('0.7.3');
    expect(renderUpgradeCheck(result)).toContain('- **install:** source checkout');
  });

  it('still reports updated (with a warning) when the dependency install fails', async () => {
    bumpOrigin('0.7.3');

    const result = await runSourceUpgrade({
      root: checkoutDir,
      currentVersion: '0.7.2',
      apply: true,
      runInstall: () => {
        throw new Error('registry down');
      },
    });

    expect(result.status).toBe('updated');
    expect(result.applied).toBe(true);
    expect(result.warning).toContain('registry down');
    expect(result.nextSteps.join('\n')).toContain('bun install');
  });

  it('refuses to apply over uncommitted changes', async () => {
    bumpOrigin('0.7.3');
    fs.appendFileSync(path.join(checkoutDir, 'package.json'), '\n');
    const installRoots: string[] = [];

    const result = await runSourceUpgrade({
      root: checkoutDir,
      currentVersion: '0.7.2',
      apply: true,
      runInstall: (root) => installRoots.push(root),
    });

    expect(result.status).toBe('blocked');
    expect(result.applied).toBe(false);
    expect(result.message).toContain('uncommitted changes');
    expect(installRoots).toEqual([]);
    // The checkout was not moved.
    expect(git(checkoutDir, 'rev-list', '--count', 'HEAD')).toBe('1');
  });

  it('blocks when local commits diverge from upstream', async () => {
    bumpOrigin('0.7.3');
    fs.writeFileSync(path.join(checkoutDir, 'local.txt'), 'local\n');
    git(checkoutDir, 'add', '.');
    git(checkoutDir, 'commit', '-q', '-m', 'diverging local work');

    const result = await runSourceUpgrade({ root: checkoutDir, currentVersion: '0.7.2', apply: true });
    expect(result.status).toBe('blocked');
    expect(result.applied).toBe(false);
    expect(result.message).toContain('local commit');
  });

  it('blocks on a detached HEAD', async () => {
    bumpOrigin('0.7.3');
    git(checkoutDir, 'checkout', '-q', '--detach');

    const result = await runSourceUpgrade({ root: checkoutDir, currentVersion: '0.7.2', apply: true });
    expect(result.status).toBe('blocked');
    expect(result.message).toContain('detached HEAD');
  });

  it('resolves the tracked remote for branch names containing dots', async () => {
    bumpOrigin('0.7.3');
    git(checkoutDir, 'checkout', '-q', '-b', 'release.1', '--track', 'origin/main');

    const result = await runSourceUpgrade({ root: checkoutDir, currentVersion: '0.7.2', apply: false });
    expect(result.status).toBe('update_available');
    expect(result.latestVersion).toBe('0.7.3');
  });

  it('downgrades a fetch failure to a warning and compares against the last fetched state', async () => {
    bumpOrigin('0.7.3');
    git(checkoutDir, 'fetch', '-q', 'origin');
    git(checkoutDir, 'remote', 'set-url', 'origin', path.join(tmpDir, 'missing'));

    const result = await runSourceUpgrade({ root: checkoutDir, currentVersion: '0.7.2', apply: false });
    expect(result.status).toBe('update_available');
    expect(result.latestVersion).toBe('0.7.3');
    expect(result.warning).toContain('last fetched state');
  });

  it('blocks when the branch has no upstream', async () => {
    bumpOrigin('0.7.3');
    git(checkoutDir, 'checkout', '-q', '-b', 'feature');

    const result = await runSourceUpgrade({ root: checkoutDir, currentVersion: '0.7.2', apply: true });
    expect(result.status).toBe('blocked');
    expect(result.message).toContain('no upstream');
    expect(result.nextSteps.join('\n')).toContain('--set-upstream-to');
  });
});

describe('fetchLatestPublishedVersion', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('prefers GitHub releases and strips the tag v-prefix', async () => {
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
      expect(String(url)).toContain('api.github.com');
      return new Response(JSON.stringify({ tag_name: 'v9.9.9' }), { status: 200 });
    }) as typeof fetch;

    await expect(fetchLatestPublishedVersion()).resolves.toBe('9.9.9');
  });

  it('falls back to npm when GitHub fails and combines both errors when neither answers', async () => {
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
      if (String(url).includes('api.github.com')) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({ version: '8.8.8' }), { status: 200 });
    }) as typeof fetch;
    await expect(fetchLatestPublishedVersion()).resolves.toBe('8.8.8');

    globalThis.fetch = (async () => new Response('{}', { status: 500 })) as typeof fetch;
    await expect(fetchLatestPublishedVersion()).rejects.toThrow(/GitHub releases API.*; npm registry/);
  });
});
