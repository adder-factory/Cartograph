import { describe, expect, it } from 'vitest';
import { isFrameworkConventionExport } from '../src/db/queries-biomarkers-graph.js';

// unused_export must not flag exports the framework consumes by name — no
// import edge can ever exist for them, and the "fix" (deleting the export)
// is destructive (a Next.js page silently loses its SEO metadata).
describe('isFrameworkConventionExport', () => {
  it('exempts Next.js App Router convention exports in segment files', () => {
    expect(isFrameworkConventionExport('app/about/page.tsx', 'metadata')).toBe(true);
    expect(isFrameworkConventionExport('app/page.tsx', 'metadata')).toBe(true);
    expect(isFrameworkConventionExport('app/layout.tsx', 'dynamic')).toBe(true);
    expect(isFrameworkConventionExport('app/layout.tsx', 'metadata')).toBe(true);
    expect(isFrameworkConventionExport('app/.well-known/security.txt/route.ts', 'dynamic')).toBe(true);
    expect(isFrameworkConventionExport('app/api/things/route.ts', 'GET')).toBe(true);
    expect(isFrameworkConventionExport('app/case-studies/[slug]/page.tsx', 'generateStaticParams')).toBe(true);
    expect(isFrameworkConventionExport('app/(marketing)/pricing/page.tsx', 'revalidate')).toBe(true);
    expect(isFrameworkConventionExport('src/app/blog/layout.tsx', 'viewport')).toBe(true);
  });

  it('exempts root middleware / instrumentation conventions', () => {
    expect(isFrameworkConventionExport('middleware.ts', 'middleware')).toBe(true);
    expect(isFrameworkConventionExport('middleware.ts', 'config')).toBe(true);
    expect(isFrameworkConventionExport('src/instrumentation.ts', 'register')).toBe(true);
  });

  it('does NOT exempt the same names outside convention files', () => {
    expect(isFrameworkConventionExport('lib/constants.ts', 'metadata')).toBe(false);
    expect(isFrameworkConventionExport('components/Header.tsx', 'dynamic')).toBe(false);
    expect(isFrameworkConventionExport('app/helpers/util.ts', 'metadata')).toBe(false);
    expect(isFrameworkConventionExport('worker/routes/contact.ts', 'GET')).toBe(false);
  });

  it('does NOT exempt arbitrary exports inside segment files', () => {
    expect(isFrameworkConventionExport('app/about/page.tsx', 'someHelper')).toBe(false);
    expect(isFrameworkConventionExport('app/api/things/route.ts', 'buildResponse')).toBe(false);
  });

  it('scopes handler methods to route files and metadata to non-route files', () => {
    // GET exported from a page is an ordinary export, not a handler.
    expect(isFrameworkConventionExport('app/about/page.tsx', 'GET')).toBe(false);
    // metadata in a route file is not a convention (route files render nothing).
    expect(isFrameworkConventionExport('app/api/things/route.ts', 'metadata')).toBe(false);
    // shared segment config is valid in both kinds.
    expect(isFrameworkConventionExport('app/api/things/route.ts', 'runtime')).toBe(true);
    expect(isFrameworkConventionExport('app/about/page.tsx', 'runtime')).toBe(true);
  });

  it('anchors root conventions to the project root and splits their export sets', () => {
    // Deep helper files named like the conventions are NOT entrypoints.
    expect(isFrameworkConventionExport('src/lib/middleware.ts', 'middleware')).toBe(false);
    expect(isFrameworkConventionExport('app/utils/instrumentation.ts', 'register')).toBe(false);
    // Cross-set names do not leak between the two root files.
    expect(isFrameworkConventionExport('middleware.ts', 'register')).toBe(false);
    expect(isFrameworkConventionExport('src/instrumentation.ts', 'middleware')).toBe(false);
    expect(isFrameworkConventionExport('src/instrumentation.ts', 'onRequestError')).toBe(true);
  });

  it('exempts TanStack Router `Route` exports under routes/ (issue #12)', () => {
    // Consumed only by the generated routeTree.gen.ts, which is often
    // kept out of the index — so the export reads as falsely unused.
    expect(isFrameworkConventionExport('apps/client/src/routes/index.tsx', 'Route')).toBe(true);
    expect(isFrameworkConventionExport('src/routes/__root.tsx', 'Route')).toBe(true);
    expect(isFrameworkConventionExport('src/routes/posts/$postId.tsx', 'Route')).toBe(true);
    expect(isFrameworkConventionExport('routes/about.ts', 'Route')).toBe(true);
  });

  it('does NOT exempt non-Route exports or Route outside routes/ (issue #12 scope)', () => {
    // Only the `Route` convention name under routes/ is exempted.
    expect(isFrameworkConventionExport('src/routes/index.tsx', 'helper')).toBe(false);
    expect(isFrameworkConventionExport('src/components/Route.tsx', 'Route')).toBe(false);
    expect(isFrameworkConventionExport('src/myroutes/index.tsx', 'Route')).toBe(false);
  });

  it('exempts React Router framework route-module data/config/middleware exports (issue #50)', () => {
    for (const name of [
      'loader',
      'clientLoader',
      'action',
      'clientAction',
      'headers',
      'handle',
      'links',
      'meta',
      'shouldRevalidate',
      'middleware',
      'clientMiddleware',
      'unstable_middleware',
      'unstable_clientMiddleware',
      'ErrorBoundary',
      'HydrateFallback',
    ]) {
      expect(isFrameworkConventionExport('app/routes/dashboard.tsx', name)).toBe(true);
    }
    // Nested route modules and monorepo / src-dir app directories.
    expect(isFrameworkConventionExport('app/routes/blog/$slug.tsx', 'loader')).toBe(true);
    expect(isFrameworkConventionExport('packages/web/app/routes/index.tsx', 'meta')).toBe(true);
    expect(isFrameworkConventionExport('src/app/routes/about.jsx', 'links')).toBe(true);
  });

  it('exempts the default export of route/root/entry.server files via the flag (issue #50)', () => {
    // The default export keeps an arbitrary local name; recognised by the flag.
    expect(isFrameworkConventionExport('app/routes/dashboard.tsx', 'Dashboard', true)).toBe(true);
    expect(isFrameworkConventionExport('app/root.tsx', 'App', true)).toBe(true);
    // entry.server's default request handler is consumed by default, whatever
    // its local name (not just the `handleRequest` template name) — Codex review.
    expect(isFrameworkConventionExport('app/entry.server.tsx', 'serverEntry', true)).toBe(true);
    // A non-default export with an arbitrary name is NOT exempted.
    expect(isFrameworkConventionExport('app/routes/dashboard.tsx', 'Dashboard', false)).toBe(false);
    expect(isFrameworkConventionExport('app/routes/dashboard.tsx', 'Dashboard')).toBe(false);
  });

  it('exempts React Router root and entry.server conventions (issue #50)', () => {
    for (const name of ['links', 'loader', 'Layout', 'ErrorBoundary', 'meta']) {
      expect(isFrameworkConventionExport('app/root.tsx', name)).toBe(true);
    }
    for (const name of ['handleRequest', 'handleDataRequest', 'handleError', 'streamTimeout']) {
      expect(isFrameworkConventionExport('app/entry.server.tsx', name)).toBe(true);
    }
    expect(isFrameworkConventionExport('src/app/entry.server.jsx', 'handleRequest')).toBe(true);
  });

  it('does NOT exempt ordinary helpers in React Router convention files or RR names elsewhere (issue #50)', () => {
    // Ordinary helper exports in convention files remain flaggable.
    expect(isFrameworkConventionExport('app/routes/dashboard.tsx', 'formatDate')).toBe(false);
    expect(isFrameworkConventionExport('app/root.tsx', 'buildNav')).toBe(false);
    expect(isFrameworkConventionExport('app/entry.server.tsx', 'renderShell')).toBe(false);
    // Layout is a root-only convention; not exempt in a plain route module.
    expect(isFrameworkConventionExport('app/routes/dashboard.tsx', 'Layout')).toBe(false);
    // Route data names outside the app/ convention dirs stay flaggable.
    expect(isFrameworkConventionExport('app/lib/data.ts', 'loader')).toBe(false);
    expect(isFrameworkConventionExport('worker/routes/contact.ts', 'loader')).toBe(false);
    expect(isFrameworkConventionExport('src/routes/index.tsx', 'loader')).toBe(false);
    // entry.server hooks don't leak into route modules / root.
    expect(isFrameworkConventionExport('app/routes/dashboard.tsx', 'streamTimeout')).toBe(false);
    // A NAMED (non-default) component in a route file stays flaggable — only the
    // default route component is exempt, so genuinely-dead named components in
    // route files still surface (Codex review of the kind-based first cut).
    expect(isFrameworkConventionExport('app/routes/dashboard.tsx', 'StatsCard', false)).toBe(false);
    // `app/routes.ts` is the route CONFIG file, not a route module dir — even its
    // default export is out of scope for this static path predicate.
    expect(isFrameworkConventionExport('app/routes.ts', 'default')).toBe(false);
    expect(isFrameworkConventionExport('app/routes.ts', 'routes', true)).toBe(false);
  });
});
