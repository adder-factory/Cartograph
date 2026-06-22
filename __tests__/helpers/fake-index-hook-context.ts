import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_CONFIG } from '../../src/default-config.js';
import { DatabaseConnection } from '../../src/db/index.js';
import { QueryBuilder } from '../../src/db/queries.js';
import type { IndexHookContext } from '../../src/index-hooks/registry.js';

interface FakeIndexHookContextHandle {
  readonly ctx: IndexHookContext;
  close(): void;
}

function createFakeIndexHookContext(): FakeIndexHookContextHandle {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-index-hooks-'));
  const db = DatabaseConnection.initialize(path.join(projectRoot, '.cartograph', 'graph.db'));
  let closed = false;
  const ctx: IndexHookContext = {
    projectRoot,
    config: { ...DEFAULT_CONFIG, rootDir: projectRoot },
    queries: new QueryBuilder(db.getDb(), db.hasVecExtension()),
    db,
  };
  return {
    ctx,
    close() {
      if (closed) return;
      closed = true;
      db.close();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    },
  };
}

export async function withFakeIndexHookContext<T>(fn: (ctx: IndexHookContext) => T | Promise<T>): Promise<T> {
  const handle = createFakeIndexHookContext();
  try {
    return await fn(handle.ctx);
  } finally {
    handle.close();
  }
}
