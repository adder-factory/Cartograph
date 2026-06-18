/**
 * --session viewer scoping. The selector is resolved PER REQUEST (id
 * first, then label) so a viewer can be launched before its labeled
 * session exists — the instance shows nothing until that session
 * makes its first tool call, then locks onto it.
 */
import * as path from 'node:path';
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

/** Normalize a path for cross-project comparison: unify separators and
 *  strip trailing slashes, and fold case on Windows (case-insensitive
 *  filesystem) — never on POSIX, where lowercasing would over-match. */
function normalizePathForCompare(p: string): string {
  const slashed = stripTrailingSlashes(p.replaceAll('\\', '/'));
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

/**
 * A recorded call targets THIS viewer's project when it carries no
 * `projectPath` override (it ran against the session's own project,
 * already scoped by the SQL filter) or that override resolves to this
 * very project. A call that overrode to a DIFFERENT project is a
 * cross-project call — it operated elsewhere and must not surface here,
 * even though the issuing session is rooted in this project.
 *
 * Only an ABSOLUTE override is confidently cross-project: a relative or
 * alias path (".", a subdirectory) can't be resolved to a root at render
 * time, so it falls back to the session scope (the live query already
 * bound the session to this project) and is kept rather than risk hiding
 * own-project work. A symlinked absolute path that resolves here but
 * spells differently can still be hidden — benign: this comparison only
 * ever hides an own-project call, it never leaks a foreign one.
 */
export function callTargetsViewerProject(ctx: RequestContext, callProjectPath: string | null): boolean {
  if (!callProjectPath || !path.isAbsolute(callProjectPath)) return true;
  return normalizePathForCompare(callProjectPath) === normalizePathForCompare(ctx.projectPath);
}
