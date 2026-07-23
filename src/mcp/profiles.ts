/**
 * Named MCP serve profiles.
 *
 * Profiles filter the advertised MCP tools without changing the live
 * registry. `full` intentionally has no allowlist so adding/removing a
 * registered tool preserves current default behaviour.
 */

export const MCP_SERVER_PROFILE_NAMES = ['full', 'core', 'coding', 'read-only', 'review'] as const;
export type McpServerProfile = (typeof MCP_SERVER_PROFILE_NAMES)[number];

export const DEFAULT_MCP_SERVER_PROFILE: McpServerProfile = 'core';

const CORE_PROFILE_TOOLS = [
  'cartograph_admin',
  'cartograph_affected',
  'cartograph_at_range',
  'cartograph_biomarkers',
  'cartograph_compare_to_ref',
  'cartograph_context',
  'cartograph_files',
  'cartograph_find',
  'cartograph_graph',
  'cartograph_node',
  'cartograph_playbook',
  'cartograph_review',
  'cartograph_status',
  'cartograph_tests_for',
  'cartograph_verify',
] as const;

const CODING_PROFILE_TOOLS = [
  'cartograph_at_range',
  'cartograph_context',
  'cartograph_files',
  'cartograph_find',
  'cartograph_graph',
  'cartograph_node',
  'cartograph_status',
  'cartograph_tests_for',
  'cartograph_verify',
] as const;

const READ_ONLY_PROFILE_TOOLS = [
  'cartograph_affected',
  'cartograph_ask',
  'cartograph_at_range',
  'cartograph_biomarkers',
  'cartograph_blame',
  'cartograph_changed_since',
  'cartograph_compare_to_ref',
  'cartograph_context',
  'cartograph_coverage',
  'cartograph_dead_code',
  'cartograph_deps',
  'cartograph_digest',
  'cartograph_entry_points',
  'cartograph_explore',
  'cartograph_files',
  'cartograph_find',
  'cartograph_graph',
  'cartograph_history',
  'cartograph_host',
  'cartograph_hotspots',
  'cartograph_imports',
  'cartograph_node',
  'cartograph_note',
  'cartograph_playbook',
  'cartograph_propose_rename',
  'cartograph_review',
  'cartograph_role',
  'cartograph_session',
  'cartograph_sql',
  'cartograph_status',
  'cartograph_summaries',
  'cartograph_tests_for',
  'cartograph_trace_to_culprits',
  'cartograph_verify',
] as const;

const REVIEW_PROFILE_TOOLS = [
  'cartograph_admin',
  'cartograph_affected',
  'cartograph_at_range',
  'cartograph_biomarkers',
  'cartograph_blame',
  'cartograph_changed_since',
  'cartograph_compare_to_ref',
  'cartograph_coverage',
  'cartograph_dead_code',
  'cartograph_deps',
  'cartograph_files',
  'cartograph_find',
  'cartograph_graph',
  'cartograph_history',
  'cartograph_host',
  'cartograph_hotspots',
  'cartograph_imports',
  'cartograph_node',
  'cartograph_playbook',
  'cartograph_review',
  'cartograph_status',
  'cartograph_tests_for',
  'cartograph_trace_to_culprits',
  'cartograph_verify',
] as const;

export const MCP_SERVER_PROFILE_TOOL_NAMES: Readonly<Record<McpServerProfile, readonly string[] | null>> = {
  full: null,
  core: CORE_PROFILE_TOOLS,
  coding: CODING_PROFILE_TOOLS,
  'read-only': READ_ONLY_PROFILE_TOOLS,
  review: REVIEW_PROFILE_TOOLS,
};

export function resolveMcpServerProfile(value: McpServerProfile | undefined): McpServerProfile {
  return value ?? DEFAULT_MCP_SERVER_PROFILE;
}

export function mcpServerProfileToolSet(profile: McpServerProfile): ReadonlySet<string> | null {
  const names = MCP_SERVER_PROFILE_TOOL_NAMES[profile];
  return names ? new Set(names) : null;
}

export function mcpServerProfileIncludesTool(profile: McpServerProfile, toolName: string): boolean {
  const names = MCP_SERVER_PROFILE_TOOL_NAMES[profile];
  return names === null || names.includes(toolName);
}
