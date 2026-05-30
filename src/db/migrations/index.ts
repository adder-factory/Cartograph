/**
 * Migration registry.
 *
 * Adding a new schema migration is:
 *
 *   1. Pick the next free 3-digit prefix (`NNN`) — `git ls-files
 *      'src/db/migrations/[0-9]*.ts'` shows what's taken.
 *   2. Create `src/db/migrations/<NNN>-<short-description>.ts`
 *      exporting a `MIGRATION: MigrationModule` (just `description`
 *      and `up(db)`).
 *   3. Add **one** import line and **one** array entry to this file.
 *
 * **Why filename-derived versions instead of a field?** Two PRs
 * adding migrations independently used to collide on the
 * `migrations[]` array AND the `CURRENT_SCHEMA_VERSION` const.
 * With monolithic migrations.ts, "I claimed v4 / you claimed v4"
 * resolved as "second PR's v4 silently no-ops" — a real bug class
 * (PR #113's reviewer caught one). With filename-derived versions,
 * two PRs both creating `004-foo.ts` produce a filesystem-level
 * conflict the maintainer sees instantly.
 *
 * `CURRENT_SCHEMA_VERSION` (in `../migrations.ts`) is the max of
 * all registered versions, derived from `ALL_MIGRATIONS` below.
 */

import type { Migration, MigrationModule } from './types.js';

import { MIGRATION as MIG_001 } from './001-initial-schema.js';
import { MIGRATION as MIG_002 } from './002-project-metadata.js';
import { MIGRATION as MIG_003 } from './003-lower-name-index.js';
import { MIGRATION as MIG_004 } from './004-centrality-churn.js';
import { MIGRATION as MIG_005 } from './005-symbol-issues.js';
import { MIGRATION as MIG_006 } from './006-config-refs.js';
import { MIGRATION as MIG_007 } from './007-sql-refs.js';
import { MIGRATION as MIG_008 } from './008-edges-unique.js';
import { MIGRATION as MIG_009 } from './009-fts-subwords-porter.js';
import { MIGRATION as MIG_010 } from './010-co-changes.js';
import { MIGRATION as MIG_011 } from './011-symbol-summaries.js';
import { MIGRATION as MIG_012 } from './012-summary-embeddings.js';
import { MIGRATION as MIG_013 } from './013-directory-summaries.js';
import { MIGRATION as MIG_014 } from './014-summary-roles.js';
import { MIGRATION as MIG_015 } from './015-prune-co-changes-index.js';
import { MIGRATION as MIG_016 } from './016-split-symbol-embeddings.js';
import { MIGRATION as MIG_017 } from './017-drop-redundant-edge-indexes.js';
import { MIGRATION as MIG_018 } from './018-node-coverage.js';
import { MIGRATION as MIG_019 } from './019-code-health-findings.js';
import { MIGRATION as MIG_020 } from './020-artifact-source-hash.js';
import { MIGRATION as MIG_021 } from './021-unresolved-multiplicity.js';
import { MIGRATION as MIG_022 } from './022-add-content-hash-index.js';
import { MIGRATION as MIG_023 } from './023-files-is-test.js';
import { MIGRATION as MIG_024 } from './024-build-context-refs.js';
import { MIGRATION as MIG_025 } from './025-string-imports.js';
import { MIGRATION as MIG_026 } from './026-parse-cache.js';
import { MIGRATION as MIG_027 } from './027-node-loc-history.js';
import { MIGRATION as MIG_028 } from './028-mcp-trace.js';
import { MIGRATION as MIG_029 } from './029-node-metrics.js';
import { MIGRATION as MIG_030 } from './030-mcp-session-state.js';
import { MIGRATION as MIG_031 } from './031-agent-notes.js';
import { MIGRATION as MIG_032 } from './032-edge-confidence.js';
import { MIGRATION as MIG_033 } from './033-decouple-embeddings-from-summaries.js';
import { MIGRATION as MIG_034 } from './034-nodes-rtree.js';
import { MIGRATION as MIG_035 } from './035-summary-hash-at-embed.js';
import { MIGRATION as MIG_036 } from './036-similar-to-edges-index.js';
import { MIGRATION as MIG_037 } from './037-summary-fts.js';
import { MIGRATION as MIG_038 } from './038-docstring-fts.js';
import { MIGRATION as MIG_039 } from './039-test-names.js';
import { MIGRATION as MIG_040 } from './040-nodes-role.js';
import { MIGRATION as MIG_041 } from './041-summary-priority-queue.js';
import { MIGRATION as MIG_042 } from './042-hnsw-meta.js';
import { MIGRATION as MIG_043 } from './043-embeddings-grain.js';
import { MIGRATION as MIG_044 } from './044-embeddings-chunk-idx.js';
import { MIGRATION as MIG_045 } from './045-commit-intents.js';
import { MIGRATION as MIG_046 } from './046-symbol-chunk-embeddings.js';
import { MIGRATION as MIG_047 } from './047-files-needs-reextract.js';
import { MIGRATION as MIG_048 } from './048-nodes-body-hash.js';
import { MIGRATION as MIG_049 } from './049-summary-store.js';
import { MIGRATION as MIG_050 } from './050-embedding-store.js';
import { MIGRATION as MIG_051 } from './051-embedding-store-backfill.js';
import { MIGRATION as MIG_052 } from './052-role-assignments.js';
import { MIGRATION as MIG_053 } from './053-store-last-ref-at.js';
import { MIGRATION as MIG_054 } from './054-strict-tables.js';
import { MIGRATION as MIG_055 } from './055-refs-file-path-fk.js';
import { MIGRATION as MIG_056 } from './056-nodes-file-path-fk.js';
import { MIGRATION as MIG_057 } from './057-repair-strictify-drops.js';
import { MIGRATION as MIG_058 } from './058-drop-dead-columns.js';
import { MIGRATION as MIG_059 } from './059-drop-cruft-columns.js';
import { MIGRATION as MIG_060 } from './060-priority-queue-attempts.js';
import { MIGRATION as MIG_061 } from './061-findings-pass-kind.js';
import { MIGRATION as MIG_062 } from './062-role-assignments-fk-cascade.js';
import { MIGRATION as MIG_063 } from './063-file-summaries.js';
import { MIGRATION as MIG_064 } from './064-restore-nodes-file-path-fk.js';
import { MIGRATION as MIG_065 } from './065-drop-vectors.js';
import { MIGRATION as MIG_066 } from './066-stabilize-node-ids.js';
import { MIGRATION as MIG_067 } from './067-nodes-role-check.js';
import { MIGRATION as MIG_068 } from './068-nodes-betweenness.js';
import { MIGRATION as MIG_069 } from './069-nested-function-manifest.js';
import { MIGRATION as MIG_070 } from './070-nodes-decorator-args.js';
import { MIGRATION as MIG_071 } from './071-nodes-name-nocase-index.js';

interface ModuleRef {
  /**
   * Source filename. The 3-digit prefix is the source of truth for
   * the version number — `validateRegistered` parses it. Keep this
   * field in sync with the actual file on disk; the
   * filesystem-cross-check test catches drift.
   */
  filename: string;
  module: MigrationModule;
}

/**
 * Static-import list of every migration. Two PRs adding
 * migrations both add a single entry here; alphabetical ordering
 * puts adjacent additions on different lines unless the version
 * numbers themselves collide, in which case the filesystem
 * collision on `NNN-*.ts` surfaces the conflict instantly.
 */
const REGISTERED_MODULES: readonly ModuleRef[] = [
  { filename: '001-initial-schema.ts', module: MIG_001 },
  { filename: '002-project-metadata.ts', module: MIG_002 },
  { filename: '003-lower-name-index.ts', module: MIG_003 },
  { filename: '004-centrality-churn.ts', module: MIG_004 },
  { filename: '005-symbol-issues.ts', module: MIG_005 },
  { filename: '006-config-refs.ts', module: MIG_006 },
  { filename: '007-sql-refs.ts', module: MIG_007 },
  { filename: '008-edges-unique.ts', module: MIG_008 },
  { filename: '009-fts-subwords-porter.ts', module: MIG_009 },
  { filename: '010-co-changes.ts', module: MIG_010 },
  { filename: '011-symbol-summaries.ts', module: MIG_011 },
  { filename: '012-summary-embeddings.ts', module: MIG_012 },
  { filename: '013-directory-summaries.ts', module: MIG_013 },
  { filename: '014-summary-roles.ts', module: MIG_014 },
  { filename: '015-prune-co-changes-index.ts', module: MIG_015 },
  { filename: '016-split-symbol-embeddings.ts', module: MIG_016 },
  { filename: '017-drop-redundant-edge-indexes.ts', module: MIG_017 },
  { filename: '018-node-coverage.ts', module: MIG_018 },
  { filename: '019-code-health-findings.ts', module: MIG_019 },
  { filename: '020-artifact-source-hash.ts', module: MIG_020 },
  { filename: '021-unresolved-multiplicity.ts', module: MIG_021 },
  { filename: '022-add-content-hash-index.ts', module: MIG_022 },
  { filename: '023-files-is-test.ts', module: MIG_023 },
  { filename: '024-build-context-refs.ts', module: MIG_024 },
  { filename: '025-string-imports.ts', module: MIG_025 },
  { filename: '026-parse-cache.ts', module: MIG_026 },
  { filename: '027-node-loc-history.ts', module: MIG_027 },
  { filename: '028-mcp-trace.ts', module: MIG_028 },
  { filename: '029-node-metrics.ts', module: MIG_029 },
  { filename: '030-mcp-session-state.ts', module: MIG_030 },
  { filename: '031-agent-notes.ts', module: MIG_031 },
  { filename: '032-edge-confidence.ts', module: MIG_032 },
  { filename: '033-decouple-embeddings-from-summaries.ts', module: MIG_033 },
  { filename: '034-nodes-rtree.ts', module: MIG_034 },
  { filename: '035-summary-hash-at-embed.ts', module: MIG_035 },
  { filename: '036-similar-to-edges-index.ts', module: MIG_036 },
  { filename: '037-summary-fts.ts', module: MIG_037 },
  { filename: '038-docstring-fts.ts', module: MIG_038 },
  { filename: '039-test-names.ts', module: MIG_039 },
  { filename: '040-nodes-role.ts', module: MIG_040 },
  { filename: '041-summary-priority-queue.ts', module: MIG_041 },
  { filename: '042-hnsw-meta.ts', module: MIG_042 },
  { filename: '043-embeddings-grain.ts', module: MIG_043 },
  { filename: '044-embeddings-chunk-idx.ts', module: MIG_044 },
  { filename: '045-commit-intents.ts', module: MIG_045 },
  { filename: '046-symbol-chunk-embeddings.ts', module: MIG_046 },
  { filename: '047-files-needs-reextract.ts', module: MIG_047 },
  { filename: '048-nodes-body-hash.ts', module: MIG_048 },
  { filename: '049-summary-store.ts', module: MIG_049 },
  { filename: '050-embedding-store.ts', module: MIG_050 },
  { filename: '051-embedding-store-backfill.ts', module: MIG_051 },
  { filename: '052-role-assignments.ts', module: MIG_052 },
  { filename: '053-store-last-ref-at.ts', module: MIG_053 },
  { filename: '054-strict-tables.ts', module: MIG_054 },
  { filename: '055-refs-file-path-fk.ts', module: MIG_055 },
  { filename: '056-nodes-file-path-fk.ts', module: MIG_056 },
  { filename: '057-repair-strictify-drops.ts', module: MIG_057 },
  { filename: '058-drop-dead-columns.ts', module: MIG_058 },
  { filename: '059-drop-cruft-columns.ts', module: MIG_059 },
  { filename: '060-priority-queue-attempts.ts', module: MIG_060 },
  { filename: '061-findings-pass-kind.ts', module: MIG_061 },
  { filename: '062-role-assignments-fk-cascade.ts', module: MIG_062 },
  { filename: '063-file-summaries.ts', module: MIG_063 },
  { filename: '064-restore-nodes-file-path-fk.ts', module: MIG_064 },
  { filename: '065-drop-vectors.ts', module: MIG_065 },
  { filename: '066-stabilize-node-ids.ts', module: MIG_066 },
  { filename: '067-nodes-role-check.ts', module: MIG_067 },
  { filename: '068-nodes-betweenness.ts', module: MIG_068 },
  { filename: '069-nested-function-manifest.ts', module: MIG_069 },
  { filename: '070-nodes-decorator-args.ts', module: MIG_070 },
  { filename: '071-nodes-name-nocase-index.ts', module: MIG_071 },
];

/** Strict 3-digit prefix on each migration filename. */
const FILENAME_PATTERN = /^(\d{3})-[a-z0-9]+(?:-[a-z0-9]+)*\.ts$/;

/**
 * Validate the registered set: filenames match the strict
 * `NNN-name.ts` shape, version is parsed from the prefix (no
 * hand-typed version field that can drift), versions are unique,
 * and the result is sorted ascending. Throws loudly at module
 * load if any invariant is violated rather than silently dropping
 * a migration during `runMigrations()`.
 */
function validateRegistered(refs: readonly ModuleRef[]): readonly Migration[] {
  if (refs.length === 0) {
    throw new Error('[Cartograph] migrations registry is empty');
  }
  const parsed = refs.map((r) => {
    const m = FILENAME_PATTERN.exec(r.filename);
    if (!m) {
      throw new Error(
        `[Cartograph] migration filename "${r.filename}" does not match ` +
          `expected pattern NNN-kebab-name.ts (3-digit prefix, lowercase kebab-case body)`,
      );
    }
    const version = parseInt(m[1]!, 10);
    return {
      version,
      filename: r.filename,
      description: r.module.description,
      up: r.module.up,
      requiresFkDisable: r.module.requiresFkDisable ?? false,
    };
  });
  const sorted = [...parsed].sort((a, b) => a.version - b.version);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.version === sorted[i - 1]!.version) {
      throw new Error(
        `[Cartograph] duplicate migration version ${sorted[i]!.version}: ` +
          `${sorted[i - 1]!.filename} vs ${sorted[i]!.filename}`,
      );
    }
  }
  return sorted.map((r) => ({
    version: r.version,
    description: r.description,
    up: r.up,
    requiresFkDisable: r.requiresFkDisable,
  }));
}

export const ALL_MIGRATIONS: readonly Migration[] = validateRegistered(REGISTERED_MODULES);
