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
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.join(__dirname, '..');
const ENGINE = path.join(REPO_ROOT, 'src/biomarkers/engine.ts');
const INDEX = path.join(REPO_ROOT, 'src/biomarkers/index.ts');

/** `const T_XXX = { ... }` — captures 1=name, 2=table body. */
const TABLE_RE = /const\s+T_(\w+)\s*=\s*\{([^}]*)\}/g;
const LEADING_WHITESPACE_RE = /\s*/y;
const TABLE_FIELD_VALUE_RE = /\s*(\d+(?:\.\d+)?)\s*/y;
const TABLE_FIELD_ORDER = ['info', 'warning', 'error'] as const;

function parseThresholdTable(
  name: string,
  body: string,
): { table: string; info: number; warning: number; error: number } | null {
  const values: Partial<Record<(typeof TABLE_FIELD_ORDER)[number], number>> = {};
  let offset = 0;

  for (const [index, field] of TABLE_FIELD_ORDER.entries()) {
    LEADING_WHITESPACE_RE.lastIndex = offset;
    LEADING_WHITESPACE_RE.exec(body);
    offset = LEADING_WHITESPACE_RE.lastIndex;

    const fieldPrefix = `${field}:`;
    if (!body.startsWith(fieldPrefix, offset)) return null;
    offset += fieldPrefix.length;

    TABLE_FIELD_VALUE_RE.lastIndex = offset;
    const match = TABLE_FIELD_VALUE_RE.exec(body);
    if (match === null) return null;

    values[field] = Number(match[1]);
    offset = TABLE_FIELD_VALUE_RE.lastIndex;

    if (index < TABLE_FIELD_ORDER.length - 1) {
      if (body[offset] !== ',') return null;
      offset += 1;
    } else if (body.slice(offset).trim() !== '') {
      return null;
    }
  }

  return { table: `T_${name}`, info: values.info!, warning: values.warning!, error: values.error! };
}

describe('biomarker thresholds — info ≤ warning ≤ error', () => {
  it('every {info,warning,error} table in engine.ts is monotone', () => {
    const text = fs.readFileSync(ENGINE, 'utf-8');
    const offenders: Array<{ table: string; info: number; warning: number; error: number }> = [];
    let tableCount = 0;
    TABLE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TABLE_RE.exec(text)) !== null) {
      const table = parseThresholdTable(m[1], m[2]);
      if (table === null) continue;
      tableCount += 1;
      if (!(table.info <= table.warning && table.warning <= table.error)) {
        offenders.push(table);
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
      const re = new RegExp(String.raw`const\s+${k}\s*=\s*(\d+)`);
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
