#!/usr/bin/env node
/**
 * Codebase audit using the integrated cartograph signals.
 *
 * Surfaces real, actionable findings that combine multiple signals:
 *   - Risk hotspots: high centrality × high churn (bug magnets)
 *   - Single points of failure: outlier centrality (one node nearly everyone depends on)
 *   - Untested high-leverage code: high centrality but no test coverage edges
 *   - Dead exports: exported symbols with zero incoming calls/references
 *   - Coupling smells: files that always co-change but aren't structurally linked
 *   - Long-tail churn without centrality: high churn but low impact (refactor candidates)
 *   - Config-drift signals: env vars read from many distinct files
 *   - Hot SQL tables: tables touched in many distinct call sites (repository-pattern candidates)
 *   - Issue-attributed bug magnets: symbols touched by many `Fixes #N` commits
 *
 * Each finding includes file:line so it's directly actionable.
 *
 * Usage: node scripts/audit.mjs <project-path>
 */

import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';

const target = path.resolve(process.argv[2] ?? process.cwd());
if (!fs.existsSync(target)) {
  console.error(`audit: target path does not exist: ${target}`);
  process.exit(1);
}

const { Cartograph } = await import('../dist/index.js');

console.log(`\n=== Audit: ${target} ===\n`);

// Reset + index fresh
const cgDir = path.join(target, '.cartograph');
if (fs.existsSync(cgDir)) fs.rmSync(cgDir, { recursive: true, force: true });

const cg = await Cartograph.init(target);
const t0 = Date.now();
const r = await cg.indexAll();
const indexMs = Date.now() - t0;
const stats = cg.getStats();

console.log(
  `Indexed: ${stats.fileCount} files / ${stats.nodeCount} nodes / ${stats.edgeCount} edges in ${indexMs}ms\n`,
);

// ----------------------------------------------------------------------------
function section(title) {
  console.log(`\n${title}`);
  console.log('─'.repeat(title.length));
}
function bullet(s) {
  console.log(`  • ${s}`);
}
function indent(s) {
  console.log(`    ${s}`);
}

// ----------------------------------------------------------------------------
// 1. RISK HOTSPOTS — top 5 by centrality × churn
// ----------------------------------------------------------------------------
section('🔥 Risk hotspots (high centrality × high churn)');
const hotspots = cg.getHotspots({ limit: 8, minCommits: 3 });
if (hotspots.length === 0) {
  bullet('No hotspots — either fresh repo, non-git, or signals not yet computed.');
} else {
  bullet(`Top ${hotspots.length} files where bugs accumulate:`);
  hotspots.forEach((h, i) => {
    const ago = h.lastTouchedTs ? Math.floor((Date.now() / 1000 - h.lastTouchedTs) / 86400) + 'd ago' : '—';
    indent(`${i + 1}. ${h.filePath}`);
    indent(
      `   risk=${h.riskScore.toFixed(3)} · centrality=${h.fileCentrality.toFixed(4)} · ${h.commitCount} commits · ${h.loc} LOC · last touched ${ago}`,
    );
  });
  console.log(
    '\n  Action: schedule these for review before adding new features. ' +
      'A regression here propagates widely (centrality) and recently-touched code is more likely to ship a bug (churn).',
  );
}

// ----------------------------------------------------------------------------
// 2. SINGLE POINTS OF FAILURE — outlier centrality (one symbol everyone depends on)
// ----------------------------------------------------------------------------
section('⚡ Single points of failure (centrality outliers)');
const top10 = cg.getTopCentralNodes({ limit: 10 });
if (top10.length < 2) {
  bullet('Not enough nodes ranked.');
} else {
  // Compute mean + stddev of top 10; flag any with z-score > 2
  const scores = top10.map((n) => n.centrality ?? 0);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
  const stddev = Math.sqrt(variance);
  const outliers = top10.filter((n) => stddev > 0 && (n.centrality - mean) / stddev > 1.5);

  if (outliers.length === 0) {
    bullet(`No outlier — top ${top10.length} centrality scores are within 1.5σ of mean (${mean.toFixed(4)}).`);
    indent(
      `Top symbol: ${top10[0].name} (${top10[0].kind}) at ${top10[0].filePath}:${top10[0].startLine}, centrality=${top10[0].centrality.toFixed(4)}`,
    );
  } else {
    bullet(
      `${outliers.length} outlier symbol${outliers.length > 1 ? 's' : ''} where everything funnels through one place:`,
    );
    outliers.forEach((n) => {
      const z = ((n.centrality - mean) / stddev).toFixed(1);
      indent(`${n.name} (${n.kind}) — z=${z}σ, centrality=${n.centrality.toFixed(4)}`);
      indent(`   ${n.filePath}:${n.startLine}`);
    });
    console.log(
      '\n  Action: any breaking change here ripples through the whole codebase. ' +
        'Worth investing in extra test coverage and documentation around these symbols.',
    );
  }
}

// ----------------------------------------------------------------------------
// 3. UNTESTED HIGH-LEVERAGE CODE — central files lacking incoming `tests` edges
// ----------------------------------------------------------------------------
section('🧪 Untested high-leverage files');
const centralFiles = cg.getHotspots({ limit: 30, minCommits: 0, sortBy: 'centrality' });
const untested = [];
for (const f of centralFiles) {
  const tests = cg.getTestsForFile(f.filePath);
  if (tests.length === 0 && !f.filePath.includes('test')) {
    untested.push(f);
  }
  if (untested.length >= 8) break;
}
if (untested.length === 0) {
  bullet('Every high-centrality file has at least one test file pointing at it. ✓');
} else {
  bullet(`${untested.length} high-centrality files with no test coverage edges:`);
  untested.forEach((f) => {
    indent(`${f.filePath} — centrality ${f.fileCentrality.toFixed(4)}, ${f.loc} LOC`);
  });
  console.log(
    '\n  Note: this checks for convention-named tests (foo.test.ts → foo.ts). ' +
      "Tests with non-conventional names won't register. Treat as a starting point, not gospel.",
  );
}

// ----------------------------------------------------------------------------
// 4. DEAD EXPORTS — defer to language-specific tooling
// ----------------------------------------------------------------------------
// We deliberately don't surface a "dead exports" finding here. A spike
// against the cartograph repo (scripts/spikes/spike-dead-exports.mjs)
// showed 45% precision against ts-prune — the underlying graph doesn't
// track import-to-export edges directly, so re-exported symbols look
// "dead" when they're actually wired up. Cross-PR conflict surface
// elimination was worth it; cross-language dead-code detection isn't,
// without a deeper resolution-layer fix.
//
// For now, point users at language-specific tools that handle this
// category correctly:
section('🪦 Dead exports');
bullet("Use a language-specific tool — cartograph's graph isn't precise enough here:");
indent('TypeScript / JavaScript: `npx ts-prune` or `npx knip`');
indent('Python:                  `vulture <path>`');
indent('Go:                      `staticcheck -checks U1000 ./...` (or `deadcode`)');
indent('Rust:                    `cargo +nightly udeps` / built-in `dead_code` lint');
indent('Java:                    `pmd -R rulesets/java/unusedcode.xml`');
indent('C#:                      Roslyn analyzer `IDE0051`');
console.log(
  '\n  Why we don\'t do this in cartograph: the graph tracks calls and references but not the import-to-export linkage that makes "is this export referenced?" a precise question. Spike data showed 45% precision (138 false positives in 250 claims, mostly re-exports). Better to defer to tools built for this.',
);

// ----------------------------------------------------------------------------
// 5. COUPLING SMELLS — high cochange between files NOT structurally linked
// ----------------------------------------------------------------------------
section('🪢 Coupling smells (high cochange, no static link)');
const coupling = [];
const allFiles = cg.getHotspots({ limit: 50, minCommits: 5, sortBy: 'churn' });
for (const f of allFiles) {
  const partners = cg.getCoChangedFiles(f.filePath, { limit: 5, minCount: 3, minJaccard: 0.5 });
  for (const p of partners) {
    // Heuristic: high jaccard pair we haven't already seen
    const key = [f.filePath, p.path].sort().join('|');
    if (coupling.some((c) => c.key === key)) continue;
    if (p.jaccard >= 0.5) {
      coupling.push({ key, a: f.filePath, b: p.path, jaccard: p.jaccard, count: p.count });
    }
  }
  if (coupling.length >= 8) break;
}
coupling.sort((a, b) => b.jaccard - a.jaccard);
if (coupling.length === 0) {
  bullet('No high-jaccard cochange pairs found (Jaccard ≥ 0.5).');
} else {
  bullet(`${coupling.length} pairs that change together ≥50% of the time:`);
  coupling.slice(0, 6).forEach((c) => {
    indent(`${c.jaccard.toFixed(2)}j (${c.count}× together) — ${c.a} ↔ ${c.b}`);
  });
  console.log(
    "\n  Action: investigate whether the coupling is intentional (sibling features) or accidental (a leaky abstraction). High cochange between files that don't import each other is often a sign of an implicit contract worth making explicit.",
  );
}

// ----------------------------------------------------------------------------
// 6. CONFIG SURFACE — env vars read from many distinct files (centralization candidates)
// ----------------------------------------------------------------------------
section('🔧 Configuration surface');
const envKeys = cg.getConfigKeys({ configKind: 'env', limit: 100 });
console.log(`  ${envKeys.length} distinct env vars read across this codebase.`);
if (envKeys.length > 0) {
  const spread = envKeys.filter((k) => k.distinctFiles >= 3);
  if (spread.length > 0) {
    bullet(`${spread.length} env var${spread.length > 1 ? 's' : ''} read from ≥3 different files:`);
    spread.slice(0, 6).forEach((k) => {
      indent(`${k.configKey} — ${k.reads} reads across ${k.distinctFiles} files`);
    });
    console.log(
      '\n  Action: env vars read in many places are good candidates for a central config object. Each read site is a place that can drift if the env var is renamed or its semantics change.',
    );
  } else {
    bullet('All env vars are read from ≤2 files — concentrated nicely.');
  }
}

// ----------------------------------------------------------------------------
// 7. HOT SQL TABLES — touched in many distinct call sites
// ----------------------------------------------------------------------------
section('🗄️  Hot SQL tables');
const tables = cg.getSqlTables({ limit: 30 });
if (tables.length === 0) {
  bullet('No SQL string-literal call sites detected.');
} else {
  const hot = tables.filter((t) => t.total >= 5).slice(0, 5);
  if (hot.length === 0) {
    bullet(`${tables.length} tables touched, but each in <5 sites — well-distributed.`);
  } else {
    bullet(`Tables with ≥5 call sites (high coupling to schema):`);
    hot.forEach((t) => {
      indent(`${t.tableName} — ${t.reads}r / ${t.writes}w / ${t.ddl} ddl (${t.total} total)`);
    });
    console.log(
      '\n  Action: tables touched in many places benefit from a repository/data-access layer. ' +
        'Schema changes ripple to every call site otherwise.',
    );
  }
}

// ----------------------------------------------------------------------------
// 8. ISSUE-ATTRIBUTED BUG MAGNETS — symbols touched in many `Fixes #N` commits
// ----------------------------------------------------------------------------
section('🐛 Bug magnets (symbols mentioned in many `Fixes #N` commits)');
const sampleNodes = cg.getTopCentralNodes({ limit: 500 });
const bugCounts = [];
for (const n of sampleNodes) {
  const issues = cg.getIssuesForNode(n.id);
  if (issues.length >= 2) {
    bugCounts.push({ name: n.name, kind: n.kind, file: n.filePath, line: n.startLine, count: issues.length });
  }
}
bugCounts.sort((a, b) => b.count - a.count);
if (bugCounts.length === 0) {
  bullet('No symbols attributed to ≥2 issues.');
  indent(
    '(Either no `Fixes/Closes/Resolves #N` discipline in commits, or the codebase genuinely has light bug history.)',
  );
} else {
  bullet(`Top symbols by attributed-issue count:`);
  bugCounts.slice(0, 6).forEach((b) => {
    indent(`${b.count} issues — ${b.name} (${b.kind}) — ${b.file}:${b.line}`);
  });
  console.log(
    '\n  Action: symbols that show up in many bug-fix commits are usually the trickiest abstractions. ' +
      'Worth extra invariant tests and consider whether the abstraction itself is the right one.',
  );
}

// ----------------------------------------------------------------------------
// 9. SUMMARY OF SIGNALS COMPUTED
// ----------------------------------------------------------------------------
section('📋 Signals coverage');
const checks = [
  { name: 'centrality', test: () => cg.getTopCentralNodes({ limit: 1 })[0]?.centrality != null },
  { name: 'churn', test: () => cg.getHotspots({ limit: 1, minCommits: 0 })[0]?.commitCount > 0 },
  {
    name: 'cochange',
    test: () => {
      const top = cg.getHotspots({ limit: 1, minCommits: 1 })[0];
      return top && cg.getCoChangedFiles(top.filePath, { limit: 1, minCount: 1, minJaccard: 0 }).length > 0;
    },
  },
  {
    name: 'issue-history',
    test: () => bugCounts.length > 0 || sampleNodes.some((n) => cg.getIssuesForNode(n.id).length > 0),
  },
  { name: 'config-refs', test: () => envKeys.length > 0 },
  { name: 'sql-refs', test: () => tables.length > 0 },
  {
    name: 'tests-edges',
    test: () => {
      const top = cg.getHotspots({ limit: 5, minCommits: 0 })[0];
      return top && cg.getTestsForFile(top.filePath).length > 0;
    },
  },
];
for (const c of checks) {
  try {
    indent(
      (c.test() ? '✓' : '○') + '  ' + c.name + (c.test() ? '' : ' (no data — feature not applicable to this codebase)'),
    );
  } catch {
    indent('?  ' + c.name + ' (error)');
  }
}

cg.close();
console.log('\n=== Audit complete ===\n');
