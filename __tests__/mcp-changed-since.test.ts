/**
 * Tests for `cartograph_changed_since` (#11a, reviewer-suggested
 * 2026-05-03). Validates:
 *  - clean tree: no drift, "no changes" sentinel
 *  - modify a file post-index: appears under "Modified"
 *  - delete a file post-index: appears under "Deleted"
 *  - add a new file post-index: appears under "Added" (filesystem
 *    walk surfaces files not in the indexed set)
 *  - explicit `since` arg: ISO date + numeric-string forms both work
 *  - bad `since` arg: returns a clean error
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import Cartograph from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('cartograph_changed_since (#11a)', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-changed-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function a() { return 1; }\n');
    fs.writeFileSync(path.join(dir, 'src', 'b.ts'), 'export function b() { return 2; }\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), '.cartograph/\n');
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (handler) handler.closeAll();
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('clean tree: reports no drift', async () => {
    const result = await handler.execute('cartograph_changed_since', {});
    const text = result.content[0]?.text ?? '';
    // Header now disambiguates "content-changed since index" from the
    // git-side commit-count drift surfaced by `cartograph_status`
    // (FRICTION-status-changed_since-semantic-disagreement 2026-05-14).
    expect(text).toMatch(/Changed since index \(0 files content-changed since index\)/);
    expect(text).toContain('No drift');
  });

  it('modified file (real content change) appears under Content-changed', async () => {
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function a() { return 999; }\n');
    // Bump mtime to ensure the freshness-check fires.
    const future = Math.floor(Date.now() / 1000) + 60;
    fs.utimesSync(path.join(dir, 'src', 'a.ts'), future, future);
    const result = await handler.execute('cartograph_changed_since', {});
    const text = result.content[0]?.text ?? '';
    // Section header renamed from "Modified" → "Content-changed" so the
    // semantic (SHA differs from `files.content_hash`) reads off the
    // header directly. The old "Modified" label was the source of
    // friction reconciling counts against `cartograph_status`'s
    // commit-count drift signal.
    expect(text).toMatch(/### Content-changed \(1\)/);
    expect(text).toContain('src/a.ts');
  });

  it('deleted file appears under Deleted', async () => {
    fs.unlinkSync(path.join(dir, 'src', 'b.ts'));
    const result = await handler.execute('cartograph_changed_since', {});
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/### Deleted \(1\)/);
    expect(text).toContain('src/b.ts');
  });

  it('added file (un-indexed, present on disk) appears under Added', async () => {
    fs.writeFileSync(path.join(dir, 'src', 'c.ts'), 'export function c() { return 3; }\n');
    const result = await handler.execute('cartograph_changed_since', {});
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/### Added \(\d+\)/);
    expect(text).toContain('src/c.ts');
  });

  it('skips noise directories (.git / .cartograph) when listing Added', async () => {
    // Create an "added" file inside .git — should NOT be reported.
    fs.writeFileSync(path.join(dir, '.git', 'noise.txt'), 'should be skipped');
    const result = await handler.execute('cartograph_changed_since', {});
    const text = result.content[0]?.text ?? '';
    expect(text).not.toContain('.git/noise.txt');
  });

  it('explicit `since` (ISO date) flags files newer than the threshold', async () => {
    // Set an old threshold so even the index's own files appear modified.
    const old = new Date(Date.now() - 10 * 365 * 86400000).toISOString();
    const result = await handler.execute('cartograph_changed_since', { since: old });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Comparing on-disk file mtime against `since` threshold/);
    // audit Group 2 #3: the `since` path compares wall-clock mtime, NOT
    // content-hash — an mtime bump after a checkout is not a content
    // change. The bucket must be labelled by what it actually measures,
    // so the explicit-`since` section is "Modified after threshold (by
    // mtime)", distinct from the content-hash "Content-changed" bucket
    // of the no-arg path. The two paths must NOT share a label.
    expect(text).toMatch(/### Modified after threshold \(by mtime\) \(\d+\)/);
    expect(text).not.toMatch(/### Content-changed/);
  });

  it("no-arg path keeps the content-hash 'Content-changed' bucket label", async () => {
    // Guard the other side of the audit Group 2 #3 fix: the no-arg path
    // genuinely compares SHA256 against `files.content_hash`, so its
    // bucket correctly says "Content-changed".
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function a() { return 999; }\n');
    const future = Math.floor(Date.now() / 1000) + 60;
    fs.utimesSync(path.join(dir, 'src', 'a.ts'), future, future);
    const result = await handler.execute('cartograph_changed_since', {});
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/### Content-changed \(1\)/);
    expect(text).not.toMatch(/Modified after threshold/);
  });

  it('explicit `since` (numeric-string unix ms) works the same', async () => {
    const futureMs = Date.now() + 86400000; // tomorrow
    const result = await handler.execute('cartograph_changed_since', {
      since: String(futureMs),
    });
    const text = result.content[0]?.text ?? '';
    // Future threshold → no file is "newer than tomorrow", so 0 files
    // newer than the threshold. When `since` is explicit, the header
    // says "newer than threshold" — distinct from the indexed-snapshot
    // case which says "content-changed since index".
    expect(text).toMatch(/Changed since threshold \(0 files newer than threshold\)/);
  });

  it('rejects malformed `since` with a discoverable error', async () => {
    const result = await handler.execute('cartograph_changed_since', { since: 'banana' });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/`since` must be an ISO date string or a (?:non-negative )?unix-ms integer/);
  });

  // FRICTION-status-changed_since-semantic-disagreement (2026-05-14):
  // changed_since must point the reader at status so callers who land
  // here from the small per-file count don't miss the larger commit-
  // count drift signal that status owns.
  it('cross-references cartograph_status (no `since` arg)', async () => {
    const result = await handler.execute('cartograph_changed_since', {});
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/_For commit-count drift vs the indexed HEAD.*cartograph_status/);
  });

  it('surfaces the indexed-HEAD relationship in the freshness header', async () => {
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function a() { return 999; }\n');
    const result = await handler.execute('cartograph_changed_since', {});
    const text = result.content[0]?.text ?? '';
    // The header surfaces "Indexed HEAD: <sha>" with either an "ahead
    // of" segment (commits landed) or the in-sync wording — both shapes
    // are valid here since the test repo committed once before
    // indexing and made no further commits.
    expect(text).toMatch(/\*\*Indexed HEAD:\*\* `[0-9a-f]{12}`/);
  });

  it('omits the cartograph_status cross-reference when `since` is explicit', async () => {
    const futureMs = Date.now() + 86400000;
    const result = await handler.execute('cartograph_changed_since', { since: String(futureMs) });
    const text = result.content[0]?.text ?? '';
    // Caller in threshold mode is asking a different question (wall-
    // clock newer-than), not "is the index stale" — so pointing at
    // status would be misleading.
    expect(text).not.toMatch(/_For commit-count drift vs the indexed HEAD/);
  });
});
