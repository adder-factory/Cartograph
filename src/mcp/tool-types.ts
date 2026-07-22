import type { FreshnessRecommendedAction, FreshnessSeverity } from '../freshness.js';

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
  /** Bucketed trust level from FreshnessInfo. Lets clients style drift severity. */
  severity: FreshnessSeverity;
  indexedSha: string | null;
  currentSha: string | null;
  filesChanged: number | null;
  /** Git-independent count of indexed files whose content drifted on disk. */
  contentDriftedFiles: number | null;
  commitsAhead: number | null;
  breakdown: { added: number; modified: number; deleted: number; total: number } | null;
  /** One-word action hint for clients that render metadata apart from text. */
  recommendedAction: FreshnessRecommendedAction;
  /** True when execute() ran an inline sync before dispatching. */
  autoSynced?: boolean;
  /** True when execute() refused to dispatch because drift is too large. */
  blocked?: boolean;
}

interface NextAction {
  /** MCP tool name to call next. */
  tool: string;
  /** Concrete argument object for the suggested call. */
  args: Record<string, unknown>;
  /** Short explanation of why this call is useful. */
  reason?: string;
  /** Lower numbers should be attempted first. */
  priority?: number;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  metadata?: {
    freshness?: FreshnessMetadata;
    warnings?: string[];
    nextActions?: NextAction[];
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
