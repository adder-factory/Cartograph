/**
 * classifyConfigChange — which apply-class a config edit needs.
 *
 * The viewer's "Save → now what?" prompt hinges on this, so the tests
 * assert the SURPRISING cases (priority ordering, hot vs reindex), not
 * the tautological "a changed field is changed".
 */
import { describe, it, expect } from 'vitest';
import { classifyConfigChange } from '../src/config/change-class.js';
import { DEFAULT_CONFIG, type CartographConfig } from '../src/types.js';

const base: CartographConfig = { ...DEFAULT_CONFIG, rootDir: '/tmp/proj', include: ['src/**/*.ts'] };

const withField = (patch: Partial<CartographConfig>): CartographConfig => ({ ...base, ...patch });

describe('classifyConfigChange', () => {
  it('returns "none" when nothing classified changed', () => {
    expect(classifyConfigChange(base, withField({}))).toBe('none');
  });

  it('treats scope-affecting edits as "reindex"', () => {
    expect(classifyConfigChange(base, withField({ exclude: ['**/dist/**'] }))).toBe('reindex');
    expect(classifyConfigChange(base, withField({ include: ['lib/**/*.ts'] }))).toBe('reindex');
    expect(classifyConfigChange(base, withField({ languages: ['python'] }))).toBe('reindex');
  });

  it('treats maxFileSize as "reindex" (it only applies on the next index, not instantly)', () => {
    expect(classifyConfigChange(base, withField({ maxFileSize: base.maxFileSize + 1 }))).toBe('reindex');
  });

  it('treats a feature-toggle flip as "reindex"', () => {
    expect(classifyConfigChange(base, withField({ enableBiomarkers: false }))).toBe('reindex');
    expect(classifyConfigChange(base, withField({ enableCoChange: false }))).toBe('reindex');
  });

  it('treats an llm-only edit as "hot" (re-read per call, no re-index)', () => {
    const next = withField({ llm: { enabled: true, summarize: false } });
    expect(classifyConfigChange(base, next)).toBe('hot');
  });

  it('treats a database edit as "restart"', () => {
    const next = withField({ database: { provider: 'postgres', url: 'postgres://x' } });
    expect(classifyConfigChange(base, next)).toBe('restart');
  });

  it('reports the most disruptive class when several change at once', () => {
    // database (restart) beats a simultaneous include (reindex) edit.
    const next = withField({
      include: ['lib/**/*.ts'],
      database: { provider: 'postgres', url: 'postgres://x' },
    });
    expect(classifyConfigChange(base, next)).toBe('restart');

    // include (reindex) beats a simultaneous llm (hot) edit.
    const next2 = withField({ include: ['lib/**/*.ts'], llm: { enabled: true } });
    expect(classifyConfigChange(base, next2)).toBe('reindex');
  });

  it('ignores array reordering only by value, never silently dropping a real change', () => {
    // A genuine value change in exclude is caught.
    expect(classifyConfigChange(base, withField({ exclude: [...base.exclude, '**/extra/**'] }))).toBe('reindex');
  });
});
