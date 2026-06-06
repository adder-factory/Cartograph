/**
 * `cartograph session` family subcommands.
 *
 * Thin compatibility entry point: the command family's behavior lives
 * in `features/session`, while this module preserves the historical
 * side-effecting import used by `bin/cartograph.ts`.
 */
import { registerSessionCommand } from '../../features/session/index.js';
import { sessionCmd, attachUnknownActionHandler, error, assignIntArg, runViaMCP } from '../_cli-core.js';

registerSessionCommand({ sessionCmd, attachUnknownActionHandler, error, assignIntArg, runViaMCP });
