import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CARTOGRAPH_PACKAGE_NAME,
  CARTOGRAPH_RELEASES_URL,
  GIT_CLONE_INSTALL_REF,
} from '../../features/upgrade/runtime.js';
import type { CheckResult } from './contract.js';

/**
 * Detect a dangling Bun global link (issue #68). Cartograph's primary
 * install is `bun link` from a source checkout, which registers two
 * symlinks: a bin shim (`$BUN_INSTALL/bin/cartograph`) and a global
 * package link (`$BUN_INSTALL/install/global/node_modules/<pkg>`)
 * pointing at the checkout directory. If that checkout is a disposable
 * release worktree that later gets removed, both symlinks survive but
 * their target is gone — `bun pm ls -g` still lists the package, yet a
 * new `cartograph` CLI or `cartograph serve --mcp` process cannot start.
 * An already-running daemon keeps serving, so the fault is easily
 * misread as a storage or MCP transport problem.
 *
 * This check runs from any healthy Cartograph (a broken link cannot
 * launch the doctor itself) and reports the broken global link with
 * concrete remediation. Returns null when there is no Bun global install
 * to inspect — a standalone binary or a project-local install has no
 * global link, so there is nothing to diagnose.
 */
export interface BunGlobalLinkEnv {
  /** Override `$BUN_INSTALL` (default `~/.bun`); injectable for tests. */
  bunInstall?: string;
}

type LinkState = { kind: 'absent' } | { kind: 'present' } | { kind: 'dangling'; symlinkTarget: string | null };

export function checkBunGlobalLink(env: BunGlobalLinkEnv = {}): CheckResult | null {
  const root = bunInstallRoot(env);
  const pkgLink = path.join(root, 'install', 'global', 'node_modules', CARTOGRAPH_PACKAGE_NAME);

  const pkg = inspectPath(pkgLink);
  const shim = inspectBinShim(path.join(root, 'bin'));

  // Neither the global package link nor the bin shim exists: this
  // Cartograph was not installed via Bun's global link (standalone
  // binary, project-local install, or a different runtime). Nothing to
  // diagnose — stay silent rather than emit a noisy "n/a" row.
  //
  // Scope note: we only FLAG an actually dangling symlink. A one-sided
  // state (e.g. package link present but the bin shim missing) reports
  // `ok`, because Bun's global bin directory is user-configurable — a
  // shim living somewhere other than `<root>/bin` would otherwise read as
  // a false "broken install". The disposable-worktree case this targets
  // dangles BOTH links together.
  if (pkg.kind === 'absent' && shim.state.kind === 'absent') return null;

  if (pkg.kind === 'dangling' || shim.state.kind === 'dangling') {
    const removed = removedTarget(pkgLink, pkg) ?? removedTarget(shim.path, shim.state);
    const removedNote = removed ? ` — it points to a removed directory (${tildify(removed)})` : '';
    // `warn`, not `fail`: this is a GLOBAL-environment gap, not a failure
    // of the cartograph now running (a dangling link cannot launch the
    // doctor, so we are running from a healthy checkout/standalone). A
    // `fail` would flip doctor's overallStatus and make orthogonal,
    // project-scoped commands like `setup`/`quickstart` exit non-zero.
    return {
      id: 'bun-global-link',
      name: 'Bun global link',
      status: 'warn',
      detail:
        `The global \`cartograph\` command is a broken symlink${removedNote}. ` +
        'New `cartograph` CLI and `cartograph serve --mcp` processes cannot start, so a new MCP client ' +
        'registers no Cartograph tools; an already-running daemon keeps serving, which masks the fault.',
      remediation:
        'Re-link from a stable Cartograph checkout (run `bun link` there), or install the published tag: ' +
        `\`bun add -g ${GIT_CLONE_INSTALL_REF}#v<latest>\` (see ${CARTOGRAPH_RELEASES_URL}). ` +
        'A `bun link` install lives only as long as the checkout it points at — never link the global CLI to a ' +
        'temporary release worktree.',
    };
  }

  return {
    id: 'bun-global-link',
    name: 'Bun global link',
    status: 'ok',
    detail: 'The global `cartograph` link resolves to an existing install.',
  };
}

function bunInstallRoot(env: BunGlobalLinkEnv): string {
  return env.bunInstall?.trim() || process.env['BUN_INSTALL']?.trim() || path.join(os.homedir(), '.bun');
}

/** Bun's global bin shim name varies by platform: a bare `cartograph`
 *  on POSIX (the shape issue #68 reproduced with), `.exe`/`.cmd` on
 *  Windows. Mirror the installer's {@link executableNameCandidates}
 *  precedent so the shim half of the check works cross-platform. */
function binShimCandidates(): string[] {
  return process.platform === 'win32' ? ['cartograph.exe', 'cartograph.cmd', 'cartograph'] : ['cartograph'];
}

/** Inspect the Bun bin shim, trying each platform-appropriate name. The
 *  first candidate that exists on disk is classified and its path
 *  returned (so a dangling shim's target can be named); if none exist,
 *  the shim is absent. */
function inspectBinShim(binDir: string): { state: LinkState; path: string } {
  const candidates = binShimCandidates();
  for (const name of candidates) {
    const shimPath = path.join(binDir, name);
    const state = inspectPath(shimPath);
    if (state.kind !== 'absent') return { state, path: shimPath };
  }
  // None exist — report the primary candidate's path (never read for an
  // absent shim, but keeps the returned path meaningful).
  return { state: { kind: 'absent' }, path: path.join(binDir, candidates[0]!) };
}

/**
 * Classify a path as absent, present (resolves to a real target), or a
 * dangling symlink (the link node exists but its target is gone —
 * exactly `readlink` succeeding while `test -e` fails). `existsSync`
 * follows symlinks, so it returns false for a dangling link and true for
 * a real directory or a healthy link.
 */
function inspectPath(p: string): LinkState {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(p);
  } catch {
    return { kind: 'absent' };
  }
  if (fs.existsSync(p)) return { kind: 'present' };
  if (!stat.isSymbolicLink()) return { kind: 'absent' };
  let symlinkTarget: string | null = null;
  try {
    symlinkTarget = fs.readlinkSync(p);
  } catch {
    /* unreadable link — still dangling, just without a nameable target */
  }
  return { kind: 'dangling', symlinkTarget };
}

/** Absolute path a dangling symlink's immediate target resolves to (the
 *  removed checkout/worktree), or null when the state is not dangling. A
 *  relative target is resolved against the link's own directory. */
function removedTarget(linkPath: string, state: LinkState): string | null {
  if (state.kind !== 'dangling' || !state.symlinkTarget) return null;
  return path.resolve(path.dirname(linkPath), state.symlinkTarget);
}

function tildify(p: string): string {
  const home = os.homedir();
  if (p.startsWith(home + path.sep)) return `~${p.substring(home.length)}`;
  return p;
}
