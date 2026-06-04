/**
 * MCP `cartograph_status` parity additions (B14):
 *  - Pending Changes section: add/modify/remove breakdown when files
 *    have drifted since the last index. Surfaces detail beyond the
 *    freshness section's count.
 *  - LLM Enrichment hint: when no LLM is configured, surface an
 *    install-Ollama prompt so the agent knows why semantic / ask
 *    would fail.
 *
 * Both already exist in the CLI status; bringing parity to MCP per
 * the B11 audit.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]!.text;
}

describe('cartograph_status B14 — Pending Changes section', () => {
  let tempDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-status-pending-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src/a.ts'), 'export function alpha() {}\n');
    cg = await Cartograph.init(tempDir, { index: true });
    handler = new ToolHandler(cg, { profile: 'full' });
  });

  afterEach(() => {
    try {
      if (cg) cg.close();
    } catch {
      /* ignore */
    }
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('omits the section when no files have drifted', async () => {
    const text = textOf(await handler.runHandler('cartograph_status', {}));
    expect(text).not.toContain('### 📂 Pending changes');
  });

  it('surfaces add/modify/remove split when files drift', async () => {
    // Make different kinds of drift in one go.
    fs.writeFileSync(path.join(tempDir, 'src/b.ts'), 'export function beta() {}\n'); // added
    fs.writeFileSync(path.join(tempDir, 'src/a.ts'), 'export function alphaModified() { return 99; }\n'); // modified
    fs.writeFileSync(path.join(tempDir, 'src/c.ts'), 'export function gamma() {}\n'); // added
    const text = textOf(await handler.runHandler('cartograph_status', {}));
    // The freshness banner now owns the count + sync hint; the
    // Pending Changes section only carries the per-bucket breakdown.
    expect(text).toContain('### 📂 Pending changes');
    expect(text).toContain('+2 added');
    expect(text).toContain('~1 modified');
    // Freshness banner reports the content-hash drift inline using
    // wording that distinguishes it from git-side commit-count drift
    // (FRICTION-status-changed_since-semantic-disagreement 2026-05-14).
    expect(text).toMatch(/1 file content-changed since index/);
    expect(text).toMatch(/cartograph admin sync/);
    // Cross-reference to `cartograph_changed_since` so the reader can
    // jump to the per-file path list without guessing which tool owns
    // that view.
    expect(text).toContain('cartograph_changed_since');
  });

  it('counts removed files in the breakdown', async () => {
    fs.unlinkSync(path.join(tempDir, 'src/a.ts'));
    const text = textOf(await handler.runHandler('cartograph_status', {}));
    expect(text).toContain('### 📂 Pending changes');
    expect(text).toContain('-1 removed');
  });

  it('does not label added-only drift as content-changed', async () => {
    fs.writeFileSync(path.join(tempDir, 'src/b.ts'), 'export function beta() {}\n');
    const text = textOf(await handler.runHandler('cartograph_status', {}));
    expect(text).toContain('### 📂 Pending changes');
    expect(text).toContain('+1 added');
    expect(text).not.toMatch(/files? content-changed since index/);
  });

  // FRICTION-status-changed_since-semantic-disagreement (2026-05-14):
  // when content-hash drift is present, status must point the reader at
  // the per-file tool — otherwise `cartograph_status` reporting one
  // count and `cartograph_changed_since` reporting another reads as
  // self-contradictory.
  it('cross-references cartograph_changed_since when drift is present', async () => {
    fs.writeFileSync(path.join(tempDir, 'src/a.ts'), 'export function alphaModified() { return 99; }\n');
    const text = textOf(await handler.runHandler('cartograph_status', {}));
    // The italicised hint sits inline under the freshness banner so
    // it stays in the same scroll-region as the count.
    expect(text).toMatch(/_For the per-file content-hash list.*cartograph_changed_since/);
  });

  it('omits the cross-reference when the index is green', async () => {
    // No drift: banner says "🟢 in sync with HEAD" and the cross-
    // reference would be confusing pointing at a tool with nothing to
    // show.
    const text = textOf(await handler.runHandler('cartograph_status', {}));
    expect(text).not.toMatch(/_For the per-file content-hash list/);
  });

  it('omits the breakdown section but flags drift in the banner when only modifications', async () => {
    // Modify-only drift: freshness banner carries the count, but the
    // breakdown section is suppressed because "~N modified" duplicates
    // what the banner already implies.
    fs.writeFileSync(path.join(tempDir, 'src/a.ts'), 'export function alphaModified() { return 99; }\n');
    const text = textOf(await handler.runHandler('cartograph_status', {}));
    expect(text).not.toContain('### 📂 Pending changes');
    // New wording: "1 file content-changed since index" (singular
    // grammar) instead of "1 uncommitted edit". The replacement makes
    // the semantic — on-disk SHA vs `files.content_hash` — readable
    // without diving into the source comment.
    expect(text).toMatch(/1 file content-changed since index/);
    expect(text).not.toContain('🟢 in sync with HEAD');
  });

  // FRICTION-A 2026-05-14: a heal-flagged file with NO on-disk drift
  // used to surface as "N files content-changed since index" — a lie
  // (nothing changed on disk) that put `cartograph_status` at 615× odds
  // with `cartograph_changed_since`'s SHA recompute. The fix splits the
  // banner so heal-flag pressure gets its own (🔵) line and the
  // content-changed line stays exclusive to true on-disk drift.
  it('renders heal-flagged drift as a distinct 🔵 line, NOT "content-changed", on a clean tree', async () => {
    // Seed needs_reextract on the indexed file without modifying any
    // disk content. The freshness banner should switch from "🟢 in
    // sync" to the heal-flag line — and crucially NOT show the
    // "content-changed since index" wording.
    cg.db.getDb().prepare('UPDATE files SET needs_reextract = 1 WHERE path = ?').run('src/a.ts');
    const text = textOf(await handler.runHandler('cartograph_status', {}));
    expect(text).toMatch(/🔵 1 file flagged for re-extraction by extraction-logic-version drift/);
    expect(text).toMatch(/cartograph admin sync/);
    // The on-disk content is unchanged — the content-changed wording
    // would be a lie. Guard against regressions that re-collapse the
    // two states into a single line.
    expect(text).not.toMatch(/files? content-changed since index/);
    // changed_since cross-reference doesn't make sense for heal-only
    // pressure (changed_since won't see those files), so it should be
    // omitted to avoid sending the reader on a goose chase.
    expect(text).not.toMatch(/_For the per-file content-hash list/);
    // The breakdown section is also skipped because heal-only entries
    // have no on-disk add/remove/modify category.
    expect(text).not.toContain('### 📂 Pending changes');
    expect(text).not.toContain('🟢 in sync with HEAD');
  });

  it('renders BOTH lines when content drift and heal-flag pressure coexist', async () => {
    // Real on-disk modification PLUS a heal flag on a DIFFERENT indexed
    // file. The freshness banner should render two distinct status
    // lines — content-drift counts the on-disk delta only (1), and
    // the heal-flag line counts the rest (1). Crucially the heal flag
    // must not be folded into the content-changed count.
    fs.writeFileSync(path.join(tempDir, 'src/b.ts'), 'export function beta() { return 0; }\n');
    // Index again so src/b.ts becomes part of the tracked set with a
    // legitimate content_hash, then heal-flag it without modifying.
    await cg.indexAll({ summarize: false });
    // Now modify src/a.ts (real drift) and heal-flag src/b.ts.
    fs.writeFileSync(path.join(tempDir, 'src/a.ts'), 'export function alphaModified() { return 99; }\n');
    cg.db.getDb().prepare('UPDATE files SET needs_reextract = 1 WHERE path = ?').run('src/b.ts');
    const text = textOf(await handler.runHandler('cartograph_status', {}));
    expect(text).toMatch(/🟡 1 file content-changed since index/);
    expect(text).toMatch(/🔵 1 file flagged for re-extraction by extraction-logic-version drift/);
  });
});

describe('cartograph_status B14 — LLM Enrichment hint when no LLM', () => {
  let tempDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-status-llm-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src/a.ts'), 'export function alpha() {}\n');
    // Empty LLM config — explicit "no provider" so the auto-detect
    // path can't accidentally pick up Ollama from the dev machine.
    cg = await Cartograph.init(tempDir, { config: { llm: { endpoint: '' } }, index: true });
    handler = new ToolHandler(cg, { profile: 'full' });
  });

  afterEach(() => {
    try {
      if (cg) cg.close();
    } catch {
      /* ignore */
    }
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('surfaces "no LLM configured" in the LLM providers section', async () => {
    const text = textOf(await handler.runHandler('cartograph_status', {}));
    expect(text).toContain('### 🤖 LLM providers');
    expect(text).toMatch(/No LLM configured/);
    expect(text).toMatch(/cartograph llm setup|[Ss]et `config\.llm`|install-models/);
    // Should name the agent-facing tools that won't work.
    expect(text).toContain('cartograph_ask');
    expect(text).toContain('cartograph_admin({action: "summarize"})');
  });
});
