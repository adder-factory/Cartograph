import type { MigrationModule } from './types.js';

/**
 * B9 (2026-05-26) — Add `nodes.decorator_args` column for storing
 * decorator argument literals (typically string literals + bare
 * identifier args), alongside the existing `nodes.decorators` column
 * which carries only decorator NAMES.
 *
 * ## Why a separate column instead of extending `decorators`
 *
 * `nodes.decorators` is a `string[]` JSON array consumed by the role
 * classifier, search ranking, and the summarizer's filter on
 * `is_framework_glue`. Every reader expects the simple flat-name
 * shape. Adding a second NULLABLE column for the richer args data
 * is a backward-compatible additive change — existing readers keep
 * seeing the same `decorators` column unchanged; new framework
 * resolvers (NestJS routes, Spring `@RequestMapping('/path')`,
 * `@Value('${k}')`, microservice `@MessagePattern('topic')`, etc.)
 * read `decorator_args` for the args they need.
 *
 * ## Shape stored in the JSON column
 *
 * ```ts
 * Array<{
 *   name: string;              // decorator name, e.g. 'Get' for @Get('/x')
 *   argStrings: string[];      // string literal args, e.g. ['/x']
 *   argIdents: string[];       // bare identifier args, e.g. ['BaseAuth']
 * }>
 * ```
 *
 * **The array is NAME-KEYED, not positionally aligned with
 * `decorators`.** Bare decorators (`@Override`) and call decorators
 * with no parseable args (`@Foo()`) are OMITTED from this array, so
 * `decorator_args.length` can be less than `decorators.length` on
 * the same row. Consumers MUST find entries by `name` via
 * `arr.find((a) => a.name === X)`, NEVER by positional index. When
 * the symbol has zero call-form decorators (or pre-B9 row), the
 * column stays NULL — distinct from "no decorators at all."
 *
 * ## Backfill
 *
 * None. Existing rows keep `decorator_args = NULL`. The next
 * `indexAll` or per-file re-extract repopulates from source —
 * `EXTRACTION_LOGIC_VERSION` rolls forward when the spec-set hash
 * changes (this migration bumps it via the new
 * `ts-extract-calls.ts` spec-file edit, so the heal fires
 * automatically).
 *
 * ## Idempotent
 *
 * PRAGMA-guarded ADD COLUMN so re-running on an already-migrated DB
 * is a no-op. Partial-schema test setups without `nodes` skip
 * cleanly.
 */
export const MIGRATION: MigrationModule = {
  description: 'Add nodes.decorator_args column for decorator argument literals',
  up: (db) => {
    const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='nodes'").get();
    if (!tableExists) return;
    const cols = db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'decorator_args')) {
      db.exec('ALTER TABLE nodes ADD COLUMN decorator_args TEXT');
    }
  },
};
