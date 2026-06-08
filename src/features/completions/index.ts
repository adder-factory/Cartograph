export {
  registerCompletionsCommand,
  type CompletionCliCommand,
  type CompletionsCommandDeps,
} from './cli.js';
export {
  completeWords,
  COMPLETION_SHELLS,
  completionShellList,
  parseCompletionShell,
  renderCompletionScript,
  type CompletionCommandLike,
  type CompletionOptionLike,
  type CompletionShell,
} from './runtime.js';
