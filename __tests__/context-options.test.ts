import { describe, expect, it } from 'vitest';
import {
  contextNodeKindsForTask,
  normalizeBuildOptions,
  normalizeFindOptions,
  pickSearchKinds,
} from '../src/context/options.js';

describe('context option normalization', () => {
  it('uses high-value node kinds by default without import/export noise', () => {
    const opts = normalizeFindOptions();

    expect(opts.nodeKinds).toContain('function');
    expect(opts.nodeKinds).toContain('class');
    expect(opts.nodeKinds).not.toContain('import');
    expect(opts.nodeKinds).not.toContain('export');
  });

  it('clamps user-supplied find limits to bounded ranges', () => {
    const opts = normalizeFindOptions({
      searchLimit: 1_000_000,
      maxNodes: 1_000_000,
      traversalDepth: 1_000,
    });

    expect(opts.searchLimit).toBe(100);
    expect(opts.maxNodes).toBe(1000);
    expect(opts.traversalDepth).toBe(10);
  });

  it('copies default arrays so callers cannot mutate shared state', () => {
    const first = normalizeFindOptions();
    first.nodeKinds.push('import');
    first.edgeKinds.push('calls');

    const second = normalizeFindOptions();
    expect(second.nodeKinds).not.toContain('import');
    expect(second.edgeKinds).toEqual([]);
  });

  it('keeps build extra candidates isolated from the caller array', () => {
    const extraCandidates = normalizeBuildOptions().extraCandidates;
    extraCandidates.push({
      node: {
        id: 'fake',
        name: 'Fake',
        kind: 'function',
        filePath: 'src/fake.ts',
        startLine: 1,
        endLine: 1,
        language: 'typescript',
      },
      score: 1,
    });

    expect(normalizeBuildOptions().extraCandidates).toEqual([]);
  });

  it('returns caller search kinds when present and text-search defaults otherwise', () => {
    expect(pickSearchKinds(['function', 'class'])).toEqual(['function', 'class']);

    const defaults = pickSearchKinds([]);
    expect(defaults).toContain('file');
    expect(defaults).toContain('export');
  });

  it('includes tables for database tasks without globally admitting field noise', () => {
    const databaseKinds = contextNodeKindsForTask('fix PostgreSQL schema migration and SQL table writes');
    const behaviorKinds = contextNodeKindsForTask('how does the watcher dispatch a sync');

    expect(databaseKinds).toContain('table');
    expect(databaseKinds).not.toContain('field');
    expect(databaseKinds).not.toContain('property');
    expect(behaviorKinds).not.toContain('table');
    expect(behaviorKinds).not.toContain('field');
  });

  it('includes fields, properties, and parameters only for explicit data-shape tasks', () => {
    const kinds = contextNodeKindsForTask('change the database column field mapping and payload parameter');

    expect(kinds).toEqual(expect.arrayContaining(['table', 'field', 'property', 'parameter']));
  });

  it('includes resource and property nodes for configuration tasks', () => {
    const kinds = contextNodeKindsForTask('update Cloudflare deployment configuration and environment setting');

    expect(kinds).toEqual(expect.arrayContaining(['resource', 'property', 'field']));
  });
});
