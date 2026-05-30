/**
 * Invariant: every biomarker severity-threshold table must satisfy
 * `info ≤ warning ≤ error`.
 *
 * `severityFor(value, t)` in `src/biomarkers/engine.ts` returns the
 * first match top-down (`error` → `warning` → `info`), so an
 * out-of-order set silently breaks classification:
 *   `T = { info: 25, warning: 15, error: 35 }` would NEVER return
 *   `warning` — every value ≥ 15 hits the `info` band first when read
 *   from the top, except severityFor checks error first. Actually
 *   inverted thresholds break in different ways depending on which
 *   tier was mis-keyed; either way, the result is a finding that
 *   never fires at the band the author intended. The bug class is
 *   silent: tests of the classifier still pass, the project just
 *   under-flags or over-flags. This invariant catches the typo at
 *   write time.
 *
 * Reads the source rather than importing the constants because the
 * threshold tables are module-private (`const T_LOC = ...`); a regex
 * over the file is a smaller diff than exporting six new module-level
 * symbols just for the test.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.join(__dirname, '..');
const ENGINE = path.join(REPO_ROOT, 'src/biomarkers/engine.ts');
const INDEX = path.join(REPO_ROOT, 'src/biomarkers/index.ts');

/** `const T_XXX = { info: N, warning: N, error: N };` — captures
 *  1=name, 2=info, 3=warning, 4=error. */
const TABLE_RE =
  /const\s+T_(\w+)\s*=\s*\{\s*info:\s*(\d+(?:\.\d+)?)\s*,\s*warning:\s*(\d+(?:\.\d+)?)\s*,\s*error:\s*(\d+(?:\.\d+)?)\s*\}/g;

describe('biomarker thresholds — info ≤ warning ≤ error', () => {
  it('every {info,warning,error} table in engine.ts is monotone', () => {
    const text = fs.readFileSync(ENGINE, 'utf-8');
    const offenders: Array<{ table: string; info: number; warning: number; error: number }> = [];
    let tableCount = 0;
    TABLE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TABLE_RE.exec(text)) !== null) {
      tableCount += 1;
      const info = Number(m[2]);
      const warning = Number(m[3]);
      const error = Number(m[4]);
      if (!(info <= warning && warning <= error)) {
        offenders.push({ table: `T_${m[1]}`, info, warning, error });
      }
    }
    // Sanity: if the regex finds zero tables, the test would vacuously
    // pass even if the source file became malformed. Anchor a floor.
    expect(tableCount).toBeGreaterThanOrEqual(4);
    expect(offenders).toEqual([]);
  });

  it('biomarkers/index.ts god_class T_GOD_* trio is monotone', () => {
    const text = fs.readFileSync(INDEX, 'utf-8');
    const valOf = (k: string): number => {
      const re = new RegExp(`const\\s+${k}\\s*=\\s*(\\d+)`);
      const m = re.exec(text);
      expect(m, `missing const ${k} in biomarkers/index.ts`).not.toBeNull();
      return Number(m![1]);
    };
    const info = valOf('T_GOD_INFO');
    const warning = valOf('T_GOD_WARN');
    const error = valOf('T_GOD_ERR');
    expect(info, `T_GOD_INFO ≤ T_GOD_WARN`).toBeLessThanOrEqual(warning);
    expect(warning, `T_GOD_WARN ≤ T_GOD_ERR`).toBeLessThanOrEqual(error);
  });
});
