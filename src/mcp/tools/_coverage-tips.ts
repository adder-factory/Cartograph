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
import { z } from 'zod';
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

const packageStringMapSchema = z.preprocess(
  (value: unknown): Record<string, string> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};

    const stringEntries: [string, string][] = [];
    for (const [key, entryValue] of Object.entries(value)) {
      if (typeof entryValue === 'string') stringEntries.push([key, entryValue]);
    }
    return Object.fromEntries(stringEntries);
  },
  z.record(z.string(), z.string()),
);

const packageJsonSchema = z.looseObject({
  scripts: packageStringMapSchema,
  devDependencies: packageStringMapSchema,
  dependencies: packageStringMapSchema,
});

type PackageJsonShape = z.infer<typeof packageJsonSchema>;

function readJsonIfExists<T>(file: string, schema: z.ZodType<T>): T | null {
  try {
    const body = fs.readFileSync(file, 'utf8');
    const parsed: unknown = JSON.parse(body);
    const result = schema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
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
  const pkg = readJsonIfExists(pkgJsonPath, packageJsonSchema);
  if (pkg) {
    const runner = detectNodeTestRunner(pkg);
    if (runner) return runner;
  }

  return detectNonNodeTestRunner(projectRoot);
}

function packageDependencyNames(pkg: PackageJsonShape): ReadonlySet<string> {
  return new Set([...Object.keys(pkg.devDependencies), ...Object.keys(pkg.dependencies)]);
}

function detectNodeTestRunner(pkg: PackageJsonShape): TestRunner | null {
  const dependencyNames = packageDependencyNames(pkg);
  if (dependencyNames.has('vitest')) {
    return {
      name: 'vitest',
      command: 'npx vitest run --coverage',
      outputHint: 'coverage/lcov.info',
    };
  }
  if (dependencyNames.has('jest')) {
    return {
      name: 'jest',
      command: 'npx jest --coverage --coverageReporters=lcov',
      outputHint: 'coverage/lcov.info',
    };
  }
  if (dependencyNames.has('c8') || dependencyNames.has('nyc')) return detectIstanbulRunner(dependencyNames);
  return null;
}

function detectIstanbulRunner(dependencyNames: ReadonlySet<string>): TestRunner {
  const usesC8 = dependencyNames.has('c8');
  return {
    name: usesC8 ? 'c8' : 'nyc',
    command: usesC8 ? 'npx c8 --reporter=lcov npm test' : 'npx nyc --reporter=lcov npm test',
    outputHint: 'coverage/lcov.info',
  };
}

function detectNonNodeTestRunner(projectRoot: string): TestRunner | null {
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
      lines.push(
        '',
        `This looks like a **${runner.name}** project. To populate coverage:`,
        '',
        testCoverageHint(runner),
      );
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
