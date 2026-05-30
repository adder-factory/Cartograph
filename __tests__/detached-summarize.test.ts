/**
 * Detached background summarization — pidfile state + double-spawn guard.
 *
 * The real `spawn` is not exercised here (it would load a GGUF in a
 * child process); a manual `admin index` smoke test covers that. These
 * tests pin the observable contract: liveness detection and the
 * "already running → don't spawn a second" guard.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { getDetachedSummarizeState, spawnDetachedSummarize } from '../src/llm/detached-summarize.js';

describe('detached-summarize — pidfile state', () => {
  let projectDir: string;
  let pidfile: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-detached-'));
    fs.mkdirSync(path.join(projectDir, '.cartograph'), { recursive: true });
    pidfile = path.join(projectDir, '.cartograph', 'summarize.pid');
  });

  afterEach(() => {
    if (fs.existsSync(projectDir)) fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('reports idle when no pidfile exists', () => {
    expect(getDetachedSummarizeState(projectDir)).toEqual({ running: false, pid: null });
  });

  it('reports idle for a pidfile pointing at a dead process', () => {
    // A pid that is essentially never live — well past any real pid.
    fs.writeFileSync(pidfile, '2147480000', 'utf-8');
    const state = getDetachedSummarizeState(projectDir);
    expect(state.running).toBe(false);
    expect(state.pid).toBe(2147480000);
  });

  it('reports running for a pidfile pointing at a live process', () => {
    // This test process is, by definition, alive.
    fs.writeFileSync(pidfile, String(process.pid), 'utf-8');
    expect(getDetachedSummarizeState(projectDir)).toEqual({ running: true, pid: process.pid });
  });

  it('treats a garbage pidfile as idle', () => {
    fs.writeFileSync(pidfile, 'not-a-pid', 'utf-8');
    expect(getDetachedSummarizeState(projectDir)).toEqual({ running: false, pid: null });
  });

  it('does not spawn a second summarizer when one is already running', () => {
    // A live pid in the pidfile → spawnDetachedSummarize must skip.
    fs.writeFileSync(pidfile, String(process.pid), 'utf-8');
    const result = spawnDetachedSummarize(projectDir);
    expect(result.spawned).toBe(false);
    expect(result.pid).toBe(process.pid);
    expect(result.reason).toMatch(/already running/);
  });
});
