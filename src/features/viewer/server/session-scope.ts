/**
 * --session viewer scoping. The selector is resolved PER REQUEST (id
 * first, then label) so a viewer can be launched before its labeled
 * session exists — the instance shows nothing until that session
 * makes its first tool call, then locks onto it.
 */
import { findSessionByLabel, getSessionById } from '../../../db/queries-trace.js';
import type { RequestContext } from './context.js';

/**
 * The session id this viewer is scoped to, or null when unscoped.
 * An unresolved selector returns itself: as a filter it matches no
 * recorded calls (correct "not started yet" behavior), and it keeps
 * matching by id the moment a session with that exact id appears.
 *
 * Id lookup takes precedence over label: a label chosen to be
 * identical to some OTHER session's id resolves to that session, not
 * the labeled one — pick labels that don't look like session ids.
 */
export function resolveScopedSessionId(ctx: RequestContext): string | null {
  if (!ctx.sessionScope) return null;
  const byId = getSessionById(ctx.queries, ctx.sessionScope);
  if (byId) return byId.id;
  const byLabel = findSessionByLabel(ctx.queries, ctx.sessionScope);
  return byLabel?.id ?? ctx.sessionScope;
}

/** Trailing-slash strip without a regex (S5852: `/+$` patterns flag
 *  as backtracking hotspots; a loop is unambiguous). */
function stripTrailingSlashes(p: string): string {
  let end = p.length;
  while (end > 0 && p.codePointAt(end - 1) === 47 /* '/' */) end--;
  return p.slice(0, end);
}

/** The viewer's project root, normalized for comparison against
 *  mcp_sessions.project_root (trailing slashes stripped). */
export function viewerProjectRootParam(ctx: RequestContext): string {
  return stripTrailingSlashes(ctx.projectPath);
}

/** One database = one graph viewer: a session stamped for a DIFFERENT
 *  project root is never served here. Legacy sessions (NULL root,
 *  recorded by older binaries) pass — they cannot be attributed. */
export function sessionBelongsToProject(ctx: RequestContext, projectRoot: string | null | undefined): boolean {
  if (!projectRoot) return true;
  return stripTrailingSlashes(projectRoot) === viewerProjectRootParam(ctx);
}
