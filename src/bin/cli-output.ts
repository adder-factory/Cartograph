// ANSI Color Helpers (avoid chalk ESM issues)
type ColorName = 'reset' | 'bold' | 'dim' | 'red' | 'green' | 'yellow' | 'blue' | 'cyan' | 'magenta' | 'white' | 'gray';

const ANSI_CODES: Readonly<Record<ColorName, string>> = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};

export function shouldUseColor(stream: NodeJS.WriteStream = process.stdout): boolean {
  if (process.argv.includes('--no-color')) return false;
  if (process.env['NO_COLOR'] !== undefined) return false;
  const force = process.env['FORCE_COLOR'];
  if (force === '0' || force === 'false') return false;
  if (force !== undefined && force !== '') return true;
  return stream.isTTY === true;
}

function code(name: ColorName): string {
  return shouldUseColor() ? ANSI_CODES[name] : '';
}

export const colors = {
  get reset(): string {
    return code('reset');
  },
  get bold(): string {
    return code('bold');
  },
  get dim(): string {
    return code('dim');
  },
  get red(): string {
    return code('red');
  },
  get green(): string {
    return code('green');
  },
  get yellow(): string {
    return code('yellow');
  },
  get blue(): string {
    return code('blue');
  },
  get cyan(): string {
    return code('cyan');
  },
  get magenta(): string {
    return code('magenta');
  },
  get white(): string {
    return code('white');
  },
  get gray(): string {
    return code('gray');
  },
};

export const chalk = {
  bold: (s: string) => `${colors.bold}${s}${colors.reset}`,
  dim: (s: string) => `${colors.dim}${s}${colors.reset}`,
  red: (s: string) => `${colors.red}${s}${colors.reset}`,
  green: (s: string) => `${colors.green}${s}${colors.reset}`,
  yellow: (s: string) => `${colors.yellow}${s}${colors.reset}`,
  blue: (s: string) => `${colors.blue}${s}${colors.reset}`,
  cyan: (s: string) => `${colors.cyan}${s}${colors.reset}`,
  magenta: (s: string) => `${colors.magenta}${s}${colors.reset}`,
  white: (s: string) => `${colors.white}${s}${colors.reset}`,
  gray: (s: string) => `${colors.gray}${s}${colors.reset}`,
};

/**
 * Format a number with commas.
 */
export function formatNumber(n: number): string {
  return n.toLocaleString();
}

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

/** Multiplier converting a 0..1 fraction to a 0..100 integer percent. */
const FRACTION_TO_PERCENT = 100;

/**
 * Per-step percentage delta required before logging a new progress
 * line in --verbose mode. Logging every increment floods the
 * terminal; 5% strikes a balance between resolution and noise.
 */
const VERBOSE_PROGRESS_PCT_STEP = 5;

/**
 * Scanning-phase log cadence: emit a line every N files when no
 * total is known yet. Smaller values flood, larger values look hung
 * on slow scans.
 */
const VERBOSE_SCANNING_LOG_INTERVAL = 1000;

/**
 * Format duration in milliseconds to human readable.
 */
export function formatDuration(ms: number): string {
  if (ms < MS_PER_SECOND) {
    return `${ms}ms`;
  }
  const seconds = ms / MS_PER_SECOND;
  if (seconds < SECONDS_PER_MINUTE) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  const remainingSeconds = seconds % SECONDS_PER_MINUTE;
  return `${minutes}m ${remainingSeconds.toFixed(0)}s`;
}

/**
 * Create a plain-text progress callback for --verbose mode.
 * No animations, no ANSI tricks — just timestamped lines to stdout.
 */
export function createVerboseProgress(): (progress: {
  phase: string;
  current: number;
  total: number;
  currentFile?: string;
}) => void {
  let lastPhase = '';
  let lastPct = -1;
  const startTime = Date.now();

  return (progress) => {
    const elapsed = ((Date.now() - startTime) / MS_PER_SECOND).toFixed(1);

    if (progress.phase !== lastPhase) {
      lastPhase = progress.phase;
      lastPct = -1;
      process.stdout.write(`[${elapsed}s] Phase: ${progress.phase}\n`);
    }

    if (progress.total > 0) {
      const pct = Math.floor((progress.current / progress.total) * FRACTION_TO_PERCENT);
      // Log every VERBOSE_PROGRESS_PCT_STEP percent to keep output manageable
      if (pct >= lastPct + VERBOSE_PROGRESS_PCT_STEP || progress.current === progress.total) {
        lastPct = pct;
        const currentFileSuffix = progress.currentFile ? ` — ${progress.currentFile}` : '';
        process.stdout.write(`[${elapsed}s]   ${progress.current}/${progress.total} (${pct}%)${currentFileSuffix}\n`);
      }
    } else if (progress.current > 0) {
      // Scanning phase (no total yet) — log periodically
      if (progress.current % VERBOSE_SCANNING_LOG_INTERVAL === 0 || progress.current === 1) {
        process.stdout.write(`[${elapsed}s]   ${formatNumber(progress.current)} files found\n`);
      }
    }
  };
}

/**
 * Print success message.
 */
export function success(message: string): void {
  console.log(chalk.green('✓') + ' ' + message);
}

/**
 * Print error message.
 */
export function error(message: string): void {
  console.error(chalk.red('✗') + ' ' + message);
}

/**
 * Print info message.
 */
export function info(message: string): void {
  console.log(chalk.blue('ℹ') + ' ' + message);
}

/**
 * Print warning message.
 */
export function warn(message: string): void {
  console.log(chalk.yellow('⚠') + ' ' + message);
}
