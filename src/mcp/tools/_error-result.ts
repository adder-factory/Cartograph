/**
 * `errorResult` — wrap an error message in the `isError: true` MCP
 * `ToolResult` envelope.
 *
 * WHY ITS OWN MODULE (structural campaign P6 — the final wave)
 * -----------------------------------------------------------
 * `errorResult` deliberately does NOT live in `shared.ts`. `shared.ts`
 * is the helper grab-bag every `defineTool` handler imports, and P6
 * makes a handler's `ToolOutcome` `err(...)` arm its ONE way to signal
 * an error (mapped to an `isError` envelope in exactly one place — the
 * `_define-tool.ts` adapter). `errorResult` is a DISPATCH-LAYER
 * primitive: its only legitimate callers are the dispatcher
 * (`mcp/tools.ts` — schema-mismatch / unknown-tool / exec-fault
 * envelopes) and the `defineTool` adapter (`_define-tool.ts` — the
 * `outcomeToResult` sink).
 *
 * Keeping it out of `shared.ts` takes it off every handler's natural
 * import surface: a handler that wants to forge an `isError` result
 * has to reach for a module named `_error-result.ts`, which is a loud
 * signal in review — the typed-outcome discipline is structural, not
 * a naming convention. The pre-P6 `errorResult` export from
 * `shared.ts` (and its `ToolResult`-returning `validateString`
 * sibling) are both gone.
 */
import type { ToolResult } from '../tool-types.js';

/** Wrap an error message in the `isError: true` MCP `ToolResult` envelope. */
export function errorResult(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}
