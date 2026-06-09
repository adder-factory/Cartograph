/**
 * Legacy Node-version preflight.
 *
 * The supported CLI entry point runs under Bun because the default
 * storage adapter imports `bun:sqlite`. This guard remains for direct
 * Node invocations of built artifacts: it fails early with a clear
 * runtime message before Bun-only imports are reached.
 *
 * `bin/cartograph.ts` imports THIS module first — ahead of any import
 * that pulls in the db layer — so the clear message below prints, and
 * the process exits, before an unsupported-runtime failure can happen. The module has
 * no imports of its own (only `process`), so it cannot itself trip
 * the runtime failure it guards against.
 */

/** Minimum supported Node for direct Node-based fallback execution. */
const MIN_NODE: readonly [number, number, number] = [22, 5, 0];

function parseVersionPart(raw: string): number {
  if (!/^\d+$/u.test(raw)) return 0;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : 0;
}

function isNodeTooOld(): boolean {
  const cur = process.versions.node.split('.').map(parseVersionPart);
  for (let i = 0; i < MIN_NODE.length; i++) {
    const part = cur[i] ?? 0;
    if (part > MIN_NODE[i]!) return false; // newer at a higher-order part — OK
    if (part < MIN_NODE[i]!) return true; // older — too old
    // equal — fall through to the next part
  }
  return false; // exactly the minimum
}

if (isNodeTooOld()) {
  const min = MIN_NODE.join('.');
  process.stderr.write(
    `\ncartograph requires Node.js >= ${min} — you are running ${process.versions.node}.\n` +
      `The published CLI is a Bun program; direct Node execution is only supported\n` +
      `on modern Node compatibility runtimes. Install/run via Bun, or upgrade Node\n` +
      `(e.g. \`nvm install --lts\`) and re-run.\n\n`,
  );
  process.exit(1);
}
