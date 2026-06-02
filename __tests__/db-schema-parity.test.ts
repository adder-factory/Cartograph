/**
 * Parity test: every table created by a migration (and not later
 * dropped) must also be declared in `src/db/schema.sql`.
 *
 * The bug class this catches is documented in `.claude/reviewer-memo.md`
 * item 5 ("Schema entry only in migration, not in schema.sql"). Fresh
 * databases initialise from `schema.sql` directly, NOT by replaying
 * the migration chain — so a `CREATE TABLE` that lands only in a
 * migration file works for incremental-upgrade users but breaks every
 * fresh install with a "no such table" error. The reviewer memo says
 * this has been caught more than once; this test makes the mistake
 * un-mergeable instead of un-noticed.
 *
 * Direction: migration ⊆ schema. The reverse (schema.sql carrying a
 * table no migration creates) is a different concern — dead schema
 * entries — and is out of scope here.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.join(__dirname, '..');
const SCHEMA_SQL = path.join(REPO_ROOT, 'src/db/schema.sql');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'src/db/migrations');

/** `CREATE [VIRTUAL] TABLE [IF NOT EXISTS] <name>` followed by a
 *  column-list `(` OR a `USING` clause (virtual tables). The
 *  trailing-`(` requirement is what rejects English-prose false
 *  positives like `CREATE TABLE for ${name}` in an error string. */
const CREATE_TABLE_RE = /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*(?:\(|USING\s)/gi;
const DROP_TABLE_RE = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(\w+)/gi;
const RENAME_TO_RE = /ALTER\s+TABLE\s+(\w+)\s+RENAME\s+TO\s+(\w+)/gi;
const byName = (a: string, b: string): number => a.localeCompare(b);

/** Strip JS block + full-line comments so a `CREATE TABLE …` in a
 *  JSDoc / `//`-prefixed comment doesn't false-positive. Trailing
 *  inline `//` comments on code lines are kept (the regex won't match
 *  them anyway — no realistic code line carries the full SQL DDL). */
function stripJsComments(text: string): string {
  return text.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '');
}

function captureGroup1(source: string, re: RegExp): Set<string> {
  const out = new Set<string>();
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.add(m[1]!.toLowerCase());
  return out;
}

describe('migrations <-> schema.sql parity', () => {
  it('every table live after the migration chain is declared in schema.sql', () => {
    const schemaSqlText = fs.readFileSync(SCHEMA_SQL, 'utf-8');
    const schemaTables = captureGroup1(schemaSqlText, CREATE_TABLE_RE);

    // Ordered traversal: maintain a `live` set and apply each
    // migration's CREATEs, DROPs, and RENAMEs in numbered order. A
    // table that's created and then renamed away (the standard
    // `*_new` / `*_tmp` SQLite-strict-rebuild pattern) ends up out
    // of `live` and so is correctly NOT required in schema.sql.
    const live = new Set<string>();
    const migrationFiles = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d+-.*\.ts$/.test(f))
      .sort(byName);
    for (const f of migrationFiles) {
      const text = stripJsComments(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf-8'));
      for (const t of captureGroup1(text, CREATE_TABLE_RE)) live.add(t);
      for (const t of captureGroup1(text, DROP_TABLE_RE)) live.delete(t);
      RENAME_TO_RE.lastIndex = 0;
      let rm: RegExpExecArray | null;
      while ((rm = RENAME_TO_RE.exec(text)) !== null) {
        live.delete(rm[1]!.toLowerCase());
        live.add(rm[2]!.toLowerCase());
      }
    }
    const missingFromSchema = [...live].filter((t) => !schemaTables.has(t)).sort(byName);
    expect(missingFromSchema).toEqual([]);
  });
});
