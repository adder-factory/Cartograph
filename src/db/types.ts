import type { EdgeKind, Language, NodeKind } from '../graph/core-types.js';

/**
 * Database schema version info.
 */
export interface SchemaVersion {
  /** Current schema version */
  version: number;

  /** When schema was created/updated */
  appliedAt: number;

  /** Description of this version */
  description?: string;
}

/**
 * Statistics about the knowledge graph.
 */
export interface GraphStats {
  /** Total number of nodes */
  nodeCount: number;

  /** Total number of edges */
  edgeCount: number;

  /** Number of tracked files */
  fileCount: number;

  /** Number of tracked files matching test-file conventions (is_test=1). */
  testFileCount: number;

  /** Node counts by kind */
  nodesByKind: Record<NodeKind, number>;

  /** Edge counts by kind */
  edgesByKind: Record<EdgeKind, number>;

  /** File counts by language */
  filesByLanguage: Record<Language, number>;

  /** Database size in bytes */
  dbSizeBytes: number;

  /** Last update timestamp */
  lastUpdated: number;
}
