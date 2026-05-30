/**
 * Node-version preflight.
 *
 * cartograph's storage layer uses the built-in `node:sqlite` module,
 * which Node added in 22.5.0. On an older Node a static import of
 * `node:sqlite` (reached transitively from almost every entry point)
 * fails with a cryptic `ERR_UNKNOWN_BUILTIN_MODULE` before any
 * cartograph code runs — leaving the user with no idea what's wrong.
 *
 * `bin/cartograph.ts` imports THIS module first — ahead of any import
 * that pulls in the db layer — so the clear message below prints, and
 * the process exits, before that failure can happen. The module has
 * no imports of its own (only `process`), so it cannot itself trip
 * the old-Node failure it guards against.
 */

/** Minimum supported Node — the version that shipped `node:sqlite`. */
const MIN_NODE: readonly [number, number, number] = [22, 5, 0];

function isNodeTooOld(): boolean {
  const cur = process.versions.node.split('.').map((n) => Number.parseInt(n, 10));
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
      `Node ${min} introduced the built-in \`node:sqlite\` module that cartograph's\n` +
      `storage layer depends on. Upgrade Node (e.g. \`nvm install --lts\`) and re-run.\n\n`,
  );
  process.exit(1);
}
