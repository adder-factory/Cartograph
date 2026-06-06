/**
 * `cartograph review` family subcommands + the `similar` command.
 *
 * Thin composition wrapper: the feature implementation lives in
 * `src/features/review`.
 */
import {
  program as cliProgram,
  reviewCmd as cliReviewCmd,
  error as cliError,
  assignIntArg as cliAssignIntArg,
  assignFloatArg as cliAssignFloatArg,
  runViaMCP as cliRunViaMCP,
  installFamilyActionAlias as cliInstallFamilyActionAlias,
  attachUnknownActionHandler as cliAttachUnknownActionHandler,
} from '../_cli-core.js';
import {
  registerReviewCommands as registerReviewFeatureCommands,
  type ReviewCommandDeps,
} from '../../features/review/index.js';

const defaultReviewCommandDeps: ReviewCommandDeps = {
  program: cliProgram,
  reviewCmd: cliReviewCmd,
  error: cliError,
  assignIntArg: cliAssignIntArg,
  assignFloatArg: cliAssignFloatArg,
  runViaMCP: cliRunViaMCP,
  installFamilyActionAlias: cliInstallFamilyActionAlias,
  attachUnknownActionHandler: cliAttachUnknownActionHandler,
};

export function registerReviewCommands(deps: ReviewCommandDeps = defaultReviewCommandDeps): void {
  registerReviewFeatureCommands(deps);
}

registerReviewCommands();
