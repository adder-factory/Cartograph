import type { Edge, EdgeKind, Language, Node } from '../types.js';

/**
 * Result from parsing a source file.
 */
export interface ExtractionResult {
  /** Extracted nodes */
  nodes: Node[];

  /** Extracted edges */
  edges: Edge[];

  /** References that couldn't be resolved yet */
  unresolvedReferences: UnresolvedReference[];

  /** Nested-function manifest rows mined from manifest-mode files. */
  nestedFunctionManifest?: NestedFunctionManifestRow[];

  /** Any errors during extraction */
  errors: ExtractionError[];

  /** Extraction duration in milliseconds */
  durationMs: number;
}

/**
 * One manifest entry per nested function declaration in a manifest-mode file.
 */
export interface NestedFunctionManifestRow {
  parentNodeId: string;
  filePath: string;
  name: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  signature: string | null;
  bodyHash: string;
}

/**
 * Error during code extraction.
 */
export interface ExtractionError {
  /** Error message */
  message: string;

  /** File path where the error occurred */
  filePath?: string;

  /** Line number if available */
  line?: number;

  /** Column number if available */
  column?: number;

  /** Error severity */
  severity: 'error' | 'warning';

  /** Error code for categorization */
  code?: string;
}

/**
 * A reference that couldn't be resolved during extraction.
 */
export interface UnresolvedReference {
  /** ID of the node containing the reference */
  fromNodeId: string;

  /** Name being referenced */
  referenceName: string;

  /** Type of reference (call, type, import, etc.) */
  referenceKind: EdgeKind;

  /** Location of the reference */
  line: number;
  column: number;

  /** File path where reference occurs (denormalized for performance) */
  filePath?: string;

  /** Language of the source file (denormalized for performance) */
  language?: Language;

  /** Possible qualified names it might resolve to */
  candidates?: string[];

  /** Number of call/reference sites that collapsed to this entry. */
  siteCount?: number;

  /** Additional 1-based line numbers beyond `line`. */
  extraLines?: number[];
}
