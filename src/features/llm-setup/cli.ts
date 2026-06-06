interface CommandLike {
  command(name: string): CommandLike;
  description(text: string): CommandLike;
  action(fn: (...args: any[]) => unknown): CommandLike;
}

export interface LlmSetupCommandDeps {
  llmCmd: CommandLike;
  loadLlmSetupCli: () => Promise<{ runLlmSetupCli: (pathArg?: string) => Promise<void> }>;
}

export function registerLlmSetupCommand(deps: LlmSetupCommandDeps): void {
  const { llmCmd, loadLlmSetupCli } = deps;
  llmCmd
    .command('setup [path]')
    .description('Interactive LLM provider setup — picks chat + embeddings backends and writes them into config.json')
    .action(async (pathArg: string | undefined) => {
      const { runLlmSetupCli } = await loadLlmSetupCli();
      await runLlmSetupCli(pathArg);
    });
}
