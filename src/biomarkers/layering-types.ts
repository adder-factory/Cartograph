/**
 * One named architectural layer. Files matching `paths` (glob
 * patterns, project-root-relative POSIX) belong to this layer. The
 * layering rule walks `imports` edges and emits an `illegal_import`
 * finding when a layer-A file imports a layer-B file that the rule
 * forbids.
 *
 * Forbidden direction is expressed in EITHER direction:
 *   - `cannotImport: ['layer-name', 'glob/...']` listed on the
 *     SOURCE layer (preferred); OR
 *   - `canImport: [...]` listed on the source layer (allow-list — any
 *     import to a target NOT in this list is forbidden).
 *
 * Both forms accept layer names (matched against `Layer.name`) and
 * glob patterns (matched against the resolved target file path via
 * `Bun.Glob`).
 *
 * If neither field is set, the layer has no outbound restrictions.
 */
export interface LayerConfig {
  /** Stable name referenced by other layers' canImport / cannotImport. */
  name: string;
  /** Glob patterns assigning files to this layer. */
  paths: string[];
  /** Allow-list of layers/globs this layer is permitted to import. */
  canImport?: string[];
  /** Deny-list of layers/globs this layer must not import. */
  cannotImport?: string[];
}

/**
 * Per-file override that lifts the layering restriction for a single
 * file. Match is exact: project-root-relative POSIX path.
 */
export interface LayerException {
  /** File path the exception applies to. */
  file: string;
  /** Targets this file is allowed to import despite layer rules. */
  canImport: string[];
}
