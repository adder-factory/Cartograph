import * as path from 'node:path';

/**
 * Render a model identifier for a user-/agent-facing trailer.
 *
 * A local GGUF backend reports its model as the absolute file path it
 * was loaded from (`/Users/me/.cartograph/models/Qwen3-7B-Q4_K_M.gguf`).
 * Echoing that verbatim leaks the operator's home directory and bloats
 * the line with a path the agent can't act on. Collapse filesystem-like
 * values to their basename; API model ids pass through untouched.
 */
export function displayModelName(model: string): string {
  if (!model.includes('/') && !model.includes('\\')) return model;
  const base = path.basename(model.replaceAll('\\', '/'));
  return base.length > 0 ? base : model;
}
