import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkUpgrade,
  compareVersions,
  fetchLatestPublishedVersion,
  renderUpgradeCheck,
} from '../src/features/upgrade/index.js';
import { detectInstallMethod, runSourceUpgrade } from '../src/features/upgrade/source-update.js';

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
    expect(packaged.nextSteps.join('\n')).toContain('package manager');
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
