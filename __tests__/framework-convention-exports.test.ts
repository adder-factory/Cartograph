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
});
