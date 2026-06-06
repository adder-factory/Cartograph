/**
 * `cartograph summaries` family subcommands.
 *
 * Thin compatibility entry point: command behavior lives in
 * `features/summaries`, while this module preserves the historical
 * side-effecting import used by `bin/cartograph.ts`.
 */
import {
  summariesCmd,
  error,
  assignIntArg,
  runViaMCP,
  installFamilyActionAlias,
  attachUnknownActionHandler,
} from '../_cli-core.js';
import * as fs from 'node:fs';
import { registerSummariesCommand } from '../../features/summaries/index.js';

registerSummariesCommand({
  summariesCmd,
  installFamilyActionAlias,
  attachUnknownActionHandler,
  error,
  assignIntArg,
  runViaMCP,
  readFile: (filePath) => fs.readFileSync(filePath, 'utf-8'),
  readStdin: async () =>
    await new Promise<string>((resolve, reject) => {
      let buf = '';
      process.stdin.setEncoding('utf-8');
      process.stdin.on('data', (c) => (buf += c));
      process.stdin.on('end', () => resolve(buf));
      process.stdin.on('error', reject);
    }),
});
