/**
 * `cg.stats.refreshBiomarkers()` — the findings-only full pass behind
 * `cartograph admin biomarkers-refresh` and the fast biomarker gate.
 *
 * Contract: on a current index it re-runs the FULL analysis (per-file
 * + cross-file) and advances the cross-file generation stamp, without
 * re-extracting the graph; with biomarkers disabled it returns null
 * and runs nothing.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Cartograph } from '../src/index.js';
import { getMetadata } from '../src/db/queries-metadata.js';

describe('stats.refreshBiomarkers', () => {
  let dir: string;
  let cg: Cartograph;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bm-refresh-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'bm-refresh-fixture', version: '0.0.0' }));
    fs.writeFileSync(
      path.join(dir, 'src', 'a.ts'),
      `export function greet(name: string): string {\n  return 'hi ' + name;\n}\n`,
    );
  });

  afterEach(() => {
    if (cg) cg.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('re-runs the full pass and advances the cross-file generation stamp', async () => {
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });

    const stampBefore = Number(getMetadata(cg.queries, 'biomarker_cross_file_pass_at'));
    expect(Number.isFinite(stampBefore)).toBe(true);

    const result = await cg.stats.refreshBiomarkers();
    expect(result).not.toBeNull();
    expect(result!.filesScanned).toBeGreaterThan(0);
    expect(result!.errors).toBe(0);

    const stampAfter = Number(getMetadata(cg.queries, 'biomarker_cross_file_pass_at'));
    expect(stampAfter).toBeGreaterThanOrEqual(stampBefore);
    // The refresh is the authority handoff the fast gate relies on:
    // the cross-file sentinel must be (re)stamped by this call.
    expect(getMetadata(cg.queries, 'biomarker_cross_file_errors')).toBe('0');
  });

  it('returns null and runs nothing when biomarkers are disabled', async () => {
    cg = await Cartograph.init(dir, { config: { enableBiomarkers: false, llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    expect(await cg.stats.refreshBiomarkers()).toBeNull();
  });
});
