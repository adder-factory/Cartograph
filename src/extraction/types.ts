import { z } from 'zod';
import type { Edge, EdgeKind, Language, Node } from '../graph/core-types.js';

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

export const extractionResultSchema = z.custom<ExtractionResult>(isExtractionResult, {
  message: 'Expected structurally valid ExtractionResult',
});

function isExtractionResult(value: unknown): value is ExtractionResult {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value['nodes']) &&
    value['nodes'].every(isNodeLike) &&
    Array.isArray(value['edges']) &&
    value['edges'].every(isEdgeLike) &&
    Array.isArray(value['unresolvedReferences']) &&
    value['unresolvedReferences'].every(isUnresolvedReferenceLike) &&
    (value['nestedFunctionManifest'] === undefined ||
      (Array.isArray(value['nestedFunctionManifest']) &&
        value['nestedFunctionManifest'].every(isNestedFunctionManifestRowLike))) &&
    Array.isArray(value['errors']) &&
    value['errors'].every(isExtractionErrorLike) &&
    typeof value['durationMs'] === 'number' &&
    Number.isFinite(value['durationMs']) &&
    value['durationMs'] >= 0
  );
}

function isNodeLike(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    hasString(value, 'id') &&
    hasString(value, 'kind') &&
    hasString(value, 'name') &&
    hasString(value, 'qualifiedName') &&
    hasString(value, 'filePath') &&
    hasString(value, 'language') &&
    hasFiniteNumber(value, 'startLine') &&
    hasFiniteNumber(value, 'endLine') &&
    hasFiniteNumber(value, 'startColumn') &&
    hasFiniteNumber(value, 'endColumn') &&
    hasFiniteNumber(value, 'updatedAt') &&
    optionalString(value, 'docstring') &&
    optionalString(value, 'signature') &&
    optionalString(value, 'visibility') &&
    optionalBoolean(value, 'isExported') &&
    optionalBoolean(value, 'isAsync') &&
    optionalBoolean(value, 'isStatic') &&
    optionalStringArray(value, 'decorators') &&
    optionalDecoratorArgs(value, 'decoratorArgs') &&
    optionalNumberOrNull(value, 'centrality') &&
    optionalNumberOrNull(value, 'betweenness') &&
    optionalString(value, 'bodyHash')
  );
}

function isEdgeLike(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    hasString(value, 'source') &&
    hasString(value, 'target') &&
    hasString(value, 'kind') &&
    optionalRecord(value, 'metadata') &&
    optionalFiniteNumber(value, 'line') &&
    optionalFiniteNumber(value, 'column') &&
    optionalString(value, 'confidence')
  );
}

function isUnresolvedReferenceLike(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    hasString(value, 'fromNodeId') &&
    hasString(value, 'referenceName') &&
    hasString(value, 'referenceKind') &&
    hasFiniteNumber(value, 'line') &&
    hasFiniteNumber(value, 'column') &&
    optionalString(value, 'filePath') &&
    optionalString(value, 'language') &&
    optionalStringArray(value, 'candidates') &&
    optionalFiniteNumber(value, 'siteCount') &&
    optionalNumberArray(value, 'extraLines')
  );
}

function isNestedFunctionManifestRowLike(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    hasString(value, 'parentNodeId') &&
    hasString(value, 'filePath') &&
    hasString(value, 'name') &&
    hasFiniteNumber(value, 'startLine') &&
    hasFiniteNumber(value, 'startCol') &&
    hasFiniteNumber(value, 'endLine') &&
    hasFiniteNumber(value, 'endCol') &&
    optionalStringOrNull(value, 'signature') &&
    hasString(value, 'bodyHash')
  );
}

function isExtractionErrorLike(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    hasString(value, 'message') &&
    optionalString(value, 'filePath') &&
    optionalFiniteNumber(value, 'line') &&
    optionalFiniteNumber(value, 'column') &&
    (value['severity'] === 'error' || value['severity'] === 'warning') &&
    optionalString(value, 'code')
  );
}

function isDecoratorArgsEntryLike(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    hasString(value, 'name') &&
    isStringArray(value['argStrings']) &&
    isStringArray(value['argIdents']) &&
    (value['namedArgs'] === undefined || isStringRecord(value['namedArgs']))
  );
}

function hasString(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === 'string';
}

function hasFiniteNumber(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value);
}

function optionalString(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return value === undefined || typeof value === 'string';
}

function optionalStringOrNull(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return value === undefined || value === null || typeof value === 'string';
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return value === undefined || typeof value === 'boolean';
}

function optionalFiniteNumber(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function optionalNumberOrNull(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return value === undefined || value === null || (typeof value === 'number' && Number.isFinite(value));
}

function optionalStringArray(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return value === undefined || isStringArray(value);
}

function optionalNumberArray(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'number'));
}

function optionalRecord(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return value === undefined || isRecord(value);
}

function optionalDecoratorArgs(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  return value === undefined || (Array.isArray(value) && value.every(isDecoratorArgsEntryLike));
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isStringRecord(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
