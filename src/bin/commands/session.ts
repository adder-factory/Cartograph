/**
 * `cartograph session` family subcommands.
 *
 * Thin compatibility entry point: the command family's behavior lives
 * in `features/session`.
 */
import { registerSessionCommand, type SessionCommandDeps } from '../../features/session/index.js';
import { sessionCmd, attachUnknownActionHandler, error, assignIntArg, runViaMCP } from '../_cli-core.js';

const defaultSessionCommandDeps: SessionCommandDeps = {
  sessionCmd,
  attachUnknownActionHandler,
  error,
  assignIntArg,
  runViaMCP,
};

export function registerSessionCommands(deps: SessionCommandDeps = defaultSessionCommandDeps): void {
  registerSessionCommand(deps);
}
