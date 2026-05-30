/**
 * Regression tests for the project-identity anchor in the directory-
 * summary prompt (added 2026-05-14).
 *
 * Without an anchor, the LLM is free to invent project identity.
 * Observed failures (same session, both wrong):
 *   - granite-1b on `src/installer`: Cartograph is "an AI-powered tool
 *     for generating agent instructions".
 *   - qwen-3b on `src/installer`: Cartograph is "a tool for generating
 *     code from text".
 *
 * Both are hallucinations — Cartograph extracts FROM code, it does not
 * generate code. The fix prepends a "## Project Overview" block taken
 * from the project's own CLAUDE.md (preferred) or README.md (fallback)
 * so the model sees the project's purpose statement before describing
 * a sub-directory.
 *
 * These tests cover:
 *   - `extractClaudeMdAnchor` / `extractReadmeAnchor` pure helpers.
 *   - `loadProjectAnchor` precedence (CLAUDE.md > README.md > none).
 *   - `buildPrompt` includes the anchor block when present, omits the
 *     anchor heading when empty.
 *   - `_resetProjectAnchorCache` lets fixture tests re-read after edit.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetProjectAnchorCache,
  buildPrompt,
  extractClaudeMdAnchor,
  extractReadmeAnchor,
  loadProjectAnchor,
  type DirGroupItem,
} from '../src/llm/dir-summarizer.js';

function item(name: string, kind: string, filePath: string, summary?: string): DirGroupItem {
  return { name, kind, summary: summary ?? `Summary for ${name}.`, filePath };
}

describe('extractClaudeMdAnchor', () => {
  it('returns the "## Project Overview" section verbatim when present', () => {
    const content = [
      '# CLAUDE.md',
      '',
      'This file provides guidance to Claude Code.',
      '',
      '## Project Overview',
      '',
      'Cartograph is a local-first code intelligence system that builds a',
      'semantic knowledge graph from any codebase.',
      '',
      '## Build and Development Commands',
      '',
      '```bash',
      'npm run build',
      '```',
    ].join('\n');
    const out = extractClaudeMdAnchor(content);
    expect(out).not.toBeNull();
    expect(out).toContain('## Project Overview');
    expect(out).toContain('local-first code intelligence system');
    // Must stop at the next `## ` heading — Build section must not leak in.
    expect(out).not.toContain('Build and Development Commands');
    expect(out).not.toContain('npm run build');
  });

  it('is case-insensitive on the "Project Overview" match', () => {
    const content = [
      '# Title',
      '',
      '## project overview',
      '',
      'Lowercase-heading project body.',
      '',
      '## Other',
      'Other body.',
    ].join('\n');
    const out = extractClaudeMdAnchor(content);
    expect(out).toContain('Lowercase-heading project body.');
    expect(out).not.toContain('Other body.');
  });

  it('falls back to the first `## ` heading section when no Project Overview exists', () => {
    const content = [
      '# Title',
      '',
      '## What This Is',
      '',
      'First section body.',
      '',
      '## Next',
      '',
      'Next section body.',
    ].join('\n');
    const out = extractClaudeMdAnchor(content);
    expect(out).toContain('What This Is');
    expect(out).toContain('First section body.');
    expect(out).not.toContain('Next section body.');
  });

  it('returns null on empty content', () => {
    expect(extractClaudeMdAnchor('')).toBeNull();
    expect(extractClaudeMdAnchor('   \n\n   ')).toBeNull();
  });

  it('returns null when the file has no `## ` headings at all', () => {
    expect(extractClaudeMdAnchor('# Just a title\n\nSome plain prose.')).toBeNull();
  });

  it('clamps a giant Project Overview section to MAX_ANCHOR_LINES (~80 lines)', () => {
    const body = Array.from({ length: 200 }, (_, i) => `Line ${i}`).join('\n');
    const content = `## Project Overview\n\n${body}\n\n## Next\n\nOther.`;
    const out = extractClaudeMdAnchor(content);
    expect(out).not.toBeNull();
    const lineCount = out!.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(80);
    // Must not bleed into the Next section.
    expect(out).not.toContain('## Next');
  });
});

describe('extractReadmeAnchor', () => {
  it('returns the first ~3 paragraphs of the README', () => {
    // Four blank-line-separated paragraphs; only the first three must
    // appear in the anchor.
    const content = [
      '# Cartograph',
      '',
      'A local-first code intelligence system.',
      '',
      'Paragraph three with more detail.',
      '',
      'Paragraph four that must NOT be included.',
    ].join('\n');
    const out = extractReadmeAnchor(content);
    expect(out).not.toBeNull();
    expect(out).toContain('# Cartograph');
    expect(out).toContain('local-first code intelligence');
    expect(out).toContain('Paragraph three');
    expect(out).not.toContain('Paragraph four');
  });

  it('returns null on empty content', () => {
    expect(extractReadmeAnchor('')).toBeNull();
    expect(extractReadmeAnchor('   ')).toBeNull();
  });

  it('clamps a long single paragraph to MAX_ANCHOR_LINES', () => {
    const body = Array.from({ length: 200 }, (_, i) => `Line ${i}`).join('\n');
    const out = extractReadmeAnchor(body);
    expect(out).not.toBeNull();
    expect(out!.split('\n').length).toBeLessThanOrEqual(80);
  });
});

describe('loadProjectAnchor', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-anchor-'));
    _resetProjectAnchorCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    _resetProjectAnchorCache();
  });

  it('prefers CLAUDE.md when both files exist', () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '## Project Overview\n\nFrom CLAUDE.md.\n\n## Next\nSkip.');
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Title\n\nFrom README.md.');
    const anchor = loadProjectAnchor(tmpDir);
    expect(anchor.source).toBe('CLAUDE.md');
    expect(anchor.text).toContain('From CLAUDE.md.');
    expect(anchor.text).not.toContain('From README.md.');
  });

  it('falls back to README.md when CLAUDE.md is missing', () => {
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Project Title\n\nFirst paragraph from README.md.');
    const anchor = loadProjectAnchor(tmpDir);
    expect(anchor.source).toBe('README.md');
    expect(anchor.text).toContain('First paragraph from README.md.');
  });

  it('falls back to README.md when CLAUDE.md exists but is empty / heading-free', () => {
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Just a title\n\nNo h2 sections.');
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Title\n\nFrom README.md.');
    const anchor = loadProjectAnchor(tmpDir);
    expect(anchor.source).toBe('README.md');
    expect(anchor.text).toContain('From README.md.');
  });

  it('returns the empty anchor when neither file exists', () => {
    const anchor = loadProjectAnchor(tmpDir);
    expect(anchor.source).toBe('none');
    expect(anchor.text).toBe('');
  });
});

describe('buildPrompt — anchor wiring', () => {
  const items: DirGroupItem[] = [
    item('writeMcpConfig', 'function', 'src/installer/config-writer.ts'),
    item('writeClaudeMd', 'function', 'src/installer/config-writer.ts'),
    item('runInstaller', 'function', 'src/installer/index.ts'),
  ];
  const group = { dir: 'src/installer', items };

  it('prepends the "## Project Overview" block when an anchor is provided', () => {
    const anchor = '## Project Overview\n\nCartograph is a local-first code intelligence system.';
    const prompt = buildPrompt(group, anchor);
    expect(prompt).toContain('## Project Overview (for grounding only — do not paraphrase verbatim)');
    expect(prompt).toContain('Cartograph is a local-first code intelligence system');
    // Anchor must come BEFORE the symbols block so the model reads identity first.
    const anchorIdx = prompt.indexOf('local-first code intelligence');
    const symbolsIdx = prompt.indexOf('## Symbols in this module');
    expect(anchorIdx).toBeGreaterThan(-1);
    expect(symbolsIdx).toBeGreaterThan(anchorIdx);
  });

  it('warns the LLM not to invent functionality outside the symbol summaries', () => {
    const prompt = buildPrompt(group, '## Project Overview\n\nGrounding text.');
    // The warning may wrap across multiple lines in the prompt — normalize
    // whitespace before matching so the assertion is robust to formatting.
    const flat = prompt.replaceAll(/\s+/g, ' ');
    expect(flat).toMatch(/do not invent functionality/i);
  });

  it('omits the anchor block (no Project Overview heading) when anchor is empty', () => {
    const prompt = buildPrompt(group, '');
    expect(prompt).not.toContain('## Project Overview (for grounding only');
    // Symbols block must still be present.
    expect(prompt).toContain('## Symbols in this module');
  });

  it('includes every symbol summary in the prompt', () => {
    const prompt = buildPrompt(group, 'anchor');
    for (const it of items) {
      expect(prompt).toContain(it.name);
      expect(prompt).toContain(it.summary);
    }
  });
});

describe('buildPrompt — full fixture project (regression for 2026-05-14)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-anchor-fixture-'));
    _resetProjectAnchorCache();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    _resetProjectAnchorCache();
  });

  it('threads a real CLAUDE.md through loadProjectAnchor into buildPrompt', () => {
    // Fixture mirrors Cartograph's own CLAUDE.md shape — the case that
    // motivated this change.
    const claudeMd = [
      '# CLAUDE.md',
      '',
      'This file provides guidance to Claude Code.',
      '',
      '## Project Overview',
      '',
      'Cartograph is a local-first code intelligence system that builds a',
      'semantic knowledge graph from any codebase. It provides structural',
      'understanding of code relationships using tree-sitter for AST parsing',
      'and SQLite for storage.',
      '',
      '## Build and Development Commands',
      '',
      '```bash',
      'npm run build',
      '```',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), claudeMd);

    const anchor = loadProjectAnchor(tmpDir);
    expect(anchor.source).toBe('CLAUDE.md');

    const items: DirGroupItem[] = [
      item('writeMcpConfig', 'function', 'src/installer/config-writer.ts'),
      item('writeClaudeMd', 'function', 'src/installer/config-writer.ts'),
      item('runInstaller', 'function', 'src/installer/index.ts'),
    ];
    const prompt = buildPrompt({ dir: 'src/installer', items }, anchor.text);

    // The grounding line must be present — this is what stops the LLM
    // from inventing "AI-powered tool for generating agent instructions".
    // The CLAUDE.md fixture hard-wraps the overview across lines, so
    // normalize whitespace before matching.
    const flat = prompt.replaceAll(/\s+/g, ' ');
    expect(flat).toContain('local-first code intelligence system');
    expect(flat).toContain('structural understanding of code relationships');
    // Build section must NOT leak into the prompt — heading boundary respected.
    expect(prompt).not.toContain('npm run build');
  });

  it('falls back to README.md when only README exists', () => {
    const readme = [
      '# Some Project',
      '',
      'A tool for extracting structural information from source code.',
      '',
      'Indexes symbols and relationships into a queryable knowledge graph.',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, 'README.md'), readme);

    const anchor = loadProjectAnchor(tmpDir);
    expect(anchor.source).toBe('README.md');

    const prompt = buildPrompt({ dir: 'src/x', items: [item('foo', 'function', 'src/x/foo.ts')] }, anchor.text);
    expect(prompt).toContain('extracting structural information from source code');
  });
});
