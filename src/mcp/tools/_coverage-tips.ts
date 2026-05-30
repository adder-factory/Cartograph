/**
 * @internal — agent-facing tips for `cartograph_coverage` when data is
 * missing, stale, or empty. Centralised so every read-mode renders the
 * same advice and the same one-liners.
 *
 * Detection is best-effort: a missing or unparseable manifest just
 * yields a `null` runner, and the caller falls back to generic advice.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileExists } from '../../utils.js';

export interface TestRunner {
  /** Display name in tips (e.g. "vitest"). */
  name: string;
  /** Shell command that produces an lcov report under the project root. */
  command: string;
  /** Conventional output path the command writes to. */
  outputHint: string;
}

interface DetectArgs {
  projectRoot: string;
}

function readJsonIfExists<T = unknown>(file: string): T | null {
  try {
    const body = fs.readFileSync(file, 'utf8');
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

interface PackageJsonShape {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
}

/**
 * Inspect the most common project manifests and return the first
 * matching test runner. Order matters: vitest is checked before jest
 * (some projects keep jest in devDeps long after migrating to
 * vitest), and Python/Rust/Go are checked only when no Node manifest
 * is present.
 */
export function detectTestRunner(projectRoot: string): TestRunner | null {
  return detectFromArgs({ projectRoot });
}

function detectFromArgs({ projectRoot }: DetectArgs): TestRunner | null {
  const pkgJsonPath = path.join(projectRoot, 'package.json');
  const pkg = readJsonIfExists<PackageJsonShape>(pkgJsonPath);
  if (pkg) {
    const allDeps = { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) };
    if ('vitest' in allDeps) {
      return {
        name: 'vitest',
        command: 'npx vitest run --coverage',
        outputHint: 'coverage/lcov.info',
      };
    }
    if ('jest' in allDeps) {
      return {
        name: 'jest',
        command: 'npx jest --coverage --coverageReporters=lcov',
        outputHint: 'coverage/lcov.info',
      };
    }
    if ('c8' in allDeps || 'nyc' in allDeps) {
      return {
        name: 'c8' in allDeps ? 'c8' : 'nyc',
        command: 'c8' in allDeps ? 'npx c8 --reporter=lcov npm test' : 'npx nyc --reporter=lcov npm test',
        outputHint: 'coverage/lcov.info',
      };
    }
  }

  if (fileExists(path.join(projectRoot, 'pyproject.toml')) || fileExists(path.join(projectRoot, 'setup.cfg'))) {
    return {
      name: 'pytest',
      command: 'pytest --cov --cov-report=lcov:coverage/lcov.info',
      outputHint: 'coverage/lcov.info',
    };
  }

  if (fileExists(path.join(projectRoot, 'Cargo.toml'))) {
    return {
      name: 'cargo-tarpaulin',
      command: 'cargo tarpaulin --out Lcov --output-dir coverage',
      outputHint: 'coverage/lcov.info',
    };
  }

  if (fileExists(path.join(projectRoot, 'go.mod'))) {
    return {
      name: 'go test',
      command: 'go test -coverprofile=coverage.out ./... && gcov2lcov -infile=coverage.out -outfile=coverage/lcov.info',
      outputHint: 'coverage/lcov.info',
    };
  }

  return null;
}

/** Render the per-runner instruction block used inside tips. */
export function testCoverageHint(runner: TestRunner): string {
  return [
    '```bash',
    runner.command,
    '```',
    '',
    `Then call \`cartograph_coverage({mode: "refresh"})\`. The command above writes \`${runner.outputHint}\`, which refresh auto-discovers.`,
  ].join('\n');
}

interface TipsCtx {
  projectRoot: string;
  /** Newest `ingestedAt` epoch-ms across `node_coverage`, or null when empty. */
  newestIngestedAt: number | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const STALE_AFTER_DAYS = 7;
const STALE_AFTER_MS = STALE_AFTER_DAYS * MS_PER_DAY;

export function buildCoverageTips(ctx: TipsCtx): string {
  const lines: string[] = [];

  if (ctx.newestIngestedAt == null) {
    lines.push('', '### No coverage data ingested');
    const runner = detectFromArgs({ projectRoot: ctx.projectRoot });
    if (runner) {
      lines.push('', `This looks like a **${runner.name}** project. To populate coverage:`);
      lines.push('', testCoverageHint(runner));
    } else {
      lines.push(
        '',
        'No supported test-runner manifest detected. Generate an lcov.info under the project root, then call `cartograph_coverage({mode: "refresh"})`.',
      );
    }
    lines.push(
      '',
      "_Shortcut_: if a report already exists at a conventional path (e.g. `coverage/lcov.info`), just call `cartograph_coverage({mode: 'refresh'})`.",
    );
    return lines.join('\n');
  }

  const ageMs = Date.now() - ctx.newestIngestedAt;
  if (ageMs > STALE_AFTER_MS) {
    const days = Math.floor(ageMs / MS_PER_DAY);
    lines.push(
      '',
      `> ⚠️ Newest coverage row is ${days}d old. Re-run tests and call \`cartograph_coverage({mode: 'refresh'})\` to refresh.`,
    );
  }

  return lines.join('\n');
}
