import { parentPort, workerData } from 'node:worker_threads';
import { writeSync } from 'node:fs';
import type { ShimmerWorkerMessage } from './types.js';

// Write directly to fd 1 (stdout) instead of writeStdout().
// In Node.js worker threads, process.stdout is proxied through the main
// thread's event loop — so if the main thread is blocked (e.g. SQLite),
// stdout writes from the worker queue up and the animation freezes.
// fs.writeSync(1, ...) is a direct kernel syscall that bypasses this.
function writeStdout(s: string): void {
  writeSync(1, s);
}

const SPINNER_GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽'];
const ANIM_INTERVAL = 150;
const FRAMES_PER_GLYPH = 3;

const RST = '\x1b[0m';
const DM = '\x1b[2m';
const GRN = '\x1b[32m';
const BOLD = '\x1b[1m';

// Shimmer gradient endpoints — dim (rgb 160/100/9) and bright
// (rgb 251/191/36) triplets. Reused by both `shimmerColor` (sine-wave
// hue cycle) and `renderBar` (positional shimmer crest sweeping
// across the filled segment).
const SHIMMER_RGB_DIM = { r: 160, g: 100, b: 9 };
const SHIMMER_RGB_BRIGHT = { r: 251, g: 191, b: 36 };
/** Period of `shimmerColor`'s sine cycle in animation frames. */
const SHIMMER_HUE_PERIOD_FRAMES = 13;
/** Period of `renderBar`'s positional shimmer in animation frames. */
const BAR_SHIMMER_CYCLE_FRAMES = 24;
/** Half-width of the shimmer crest used by `renderBar`. */
const BAR_SHIMMER_WIDTH = 3;
/** Padding added to the shimmer's positional range so it slides off both ends of the bar. */
const BAR_SHIMMER_PAD_END = 6;
const BAR_SHIMMER_PAD_START = 3;

const startTime: number = workerData.startTime;

function animFrame(): number {
  return Math.floor((Date.now() - startTime) / ANIM_INTERVAL);
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

/** ANSI 24-bit foreground escape interpolating the shimmer gradient at parameter `t` ∈ [0, 1]. */
function shimmerEscape(t: number): string {
  const r = lerp(SHIMMER_RGB_DIM.r, SHIMMER_RGB_BRIGHT.r, t);
  const g = lerp(SHIMMER_RGB_DIM.g, SHIMMER_RGB_BRIGHT.g, t);
  const b = lerp(SHIMMER_RGB_DIM.b, SHIMMER_RGB_BRIGHT.b, t);
  return `\x1b[38;2;${r};${g};${b}m${BOLD}`;
}

function shimmerColor(frame: number): string {
  const t = (Math.sin((frame * 2 * Math.PI) / SHIMMER_HUE_PERIOD_FRAMES) + 1) / 2;
  return shimmerEscape(t);
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function renderBar(frame: number, filled: number, empty: number): string {
  if (filled === 0) return `${DM}${'░'.repeat(empty)}${RST}`;
  const shimmerPos =
    ((frame % BAR_SHIMMER_CYCLE_FRAMES) / BAR_SHIMMER_CYCLE_FRAMES) * (filled + BAR_SHIMMER_PAD_END) -
    BAR_SHIMMER_PAD_START;
  let bar = '';
  for (let i = 0; i < filled; i++) {
    const dist = Math.abs(i - shimmerPos);
    const t = Math.max(0, 1 - dist / BAR_SHIMMER_WIDTH);
    bar += `${shimmerEscape(t)}█`;
  }
  bar += `${RST}${DM}${'░'.repeat(empty)}${RST}`;
  return bar;
}

// Mutable state
let currentMessage = '';
let currentPercent = -1;
let currentCount = 0;

function render(): void {
  if (!currentMessage) return;
  const frame = animFrame();
  const glyphIdx = Math.floor(frame / FRAMES_PER_GLYPH) % SPINNER_GLYPHS.length;
  const glyph = SPINNER_GLYPHS[glyphIdx] ?? '·';
  const color = shimmerColor(frame);

  let line: string;
  if (currentPercent >= 0) {
    const barWidth = 25;
    const filled = Math.round((barWidth * currentPercent) / 100);
    const empty = barWidth - filled;
    line = `${DM}│${RST}  ${color}${glyph}${RST} ${currentMessage}  ${renderBar(frame, filled, empty)}  ${currentPercent}%`;
  } else if (currentCount > 0) {
    line = `${DM}│${RST}  ${color}${glyph}${RST} ${currentMessage}... ${formatNumber(currentCount)} found`;
  } else {
    line = `${DM}│${RST}  ${color}${glyph}${RST} ${currentMessage}...`;
  }

  writeStdout(`\r\x1b[K${line}`);
}

function finishPhase(): void {
  if (!currentMessage) return;
  writeStdout(`\r\x1b[K`);
  let detail = '';
  if (currentPercent >= 0) detail = ' — done';
  else if (currentCount > 0) detail = ` — ${formatNumber(currentCount)} found`;
  writeStdout(`${DM}│${RST}  ${GRN}◆${RST} ${currentMessage}${detail}\n`);
  currentMessage = '';
  currentPercent = -1;
  currentCount = 0;
}

// Render loop — independent of main thread
const tickInterval = setInterval(render, 50);

parentPort!.on('message', (msg: ShimmerWorkerMessage) => {
  if (msg.type === 'update') {
    currentMessage = msg.phaseName;
    currentPercent = msg.percent;
    currentCount = msg.count;
  } else if (msg.type === 'finish-phase') {
    finishPhase();
  } else if (msg.type === 'stop') {
    clearInterval(tickInterval);
    finishPhase();
    parentPort!.postMessage({ type: 'stopped' });
  }
});
