/**
 * Leaf tool-name → module lookup, populated by the registry at load.
 *
 * Exists to break a runtime import cycle: the registry imports the family
 * tools (e.g. SESSION_TOOL, whose macro replay resolves steps by tool
 * name) to assemble its ENTRIES, so a family tool reaching back into
 * `registry.ts` for `getToolModule` would close the loop. This module
 * imports nothing but a type, so registry → family-tool → _tool-lookup
 * is a clean DAG.
 */

import type { ToolModule } from './types.js';

const byName = new Map<string, ToolModule>();

/** Register a tool module under its advertised name. Called by the registry. */
export function registerToolModule(mod: ToolModule): void {
  byName.set(mod.definition.name, mod);
}

/** Resolve a tool module by its advertised name, or undefined. */
export function getToolModule(name: string): ToolModule | undefined {
  return byName.get(name);
}
