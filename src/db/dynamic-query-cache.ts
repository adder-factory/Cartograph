import type { SqliteDatabase } from './sqlite-adapter.js';
import type { TypedQuery } from './typed-query.js';

interface GetOrBuildCachedQueryArgs<N extends string, P, R> {
  cache: WeakMap<SqliteDatabase, Map<string, TypedQuery<P, R>>>;
  db: SqliteDatabase;
  name: N;
  build: (name: N) => (db: SqliteDatabase) => TypedQuery<P, R>;
}

/**
 * Shared two-level cache for dynamic SQL query factories.
 *
 * Dynamic table names are whitelisted by the caller, then cached per
 * `(database connection, dynamic name)` so hot KNN/search loops do not
 * prepare the same statement repeatedly.
 */
export function getOrBuildCachedQuery<N extends string, P, R>(
  args: GetOrBuildCachedQueryArgs<N, P, R>,
): TypedQuery<P, R> {
  const { cache, db, name, build } = args;
  let perDb = cache.get(db);
  if (!perDb) {
    perDb = new Map();
    cache.set(db, perDb);
  }
  let q = perDb.get(name);
  if (!q) {
    q = build(name)(db);
    perDb.set(name, q);
  }
  return q;
}
