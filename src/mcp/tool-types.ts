/**
 * Shared MCP tool types.
 *
 * Lives in its own module so per-tool files in `./tools/` and
 * the legacy class wrapper in `./tools.ts` can import the same
 * type definitions without a circular dependency.
 */

interface PropertySchema {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  /** For type: 'array' — describes the items shape. */
  items?: PropertySchema | { type: string; properties?: Record<string, PropertySchema>; required?: string[] };
  /** For nested object schemas (e.g. cartograph_summaries action='save' items). */
  properties?: Record<string, PropertySchema>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, PropertySchema>;
    required?: string[];
  };
}

/**
 * Structured freshness metadata attached alongside the text body so
 * MCP clients can render it visually instead of relying on the agent
 * to read the prefix banner. Mirrors the FreshnessInfo surface
 * (subset relevant to the response).
 */
export interface FreshnessMetadata {
  isStale: boolean;
  indexedSha: string | null;
  currentSha: string | null;
  filesChanged: number | null;
  commitsAhead: number | null;
  breakdown: { added: number; modified: number; deleted: number; total: number } | null;
  /** True when execute() ran an inline sync before dispatching. */
  autoSynced?: boolean;
  /** True when execute() refused to dispatch because drift is too large. */
  blocked?: boolean;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  metadata?: {
    freshness?: FreshnessMetadata;
  };
}

/**
 * Shared `allowStale` schema property — every tool's inputSchema
 * accepts it as an opt-in to query a stale index. Suppresses the
 * heavy-drift hard-block AND inline auto-sync. Freshness metadata is
 * still attached to the response. Injected by the registry (not
 * declared per tool) — see tools/registry.ts.
 */
export const allowStaleProperty: PropertySchema = {
  type: 'boolean',
  description:
    'Bypass the freshness gate and query the cached index even when stale. Skips auto-sync. Freshness metadata is still attached to the response so the caller can see drift. Default false.',
};
