import { renderCompareToRefCapture, type CompareToRefCapture } from './runtime.js';

export interface CompareToRefRunnerDeps {
  runViaMCPCapture: (
    toolName: string,
    args: Record<string, unknown>,
    projectPath: string | undefined,
  ) => Promise<CompareToRefCapture>;
  writeStdout: (message: string) => void;
  writeStderr: (message: string) => void;
  exit: (code: number) => void;
}

export function makeCompareToRefMcpRunner(deps: CompareToRefRunnerDeps) {
  return async (toolName: string, args: Record<string, unknown>, projectPath: string | undefined): Promise<void> => {
    const rendered = renderCompareToRefCapture(await deps.runViaMCPCapture(toolName, args, projectPath));
    if (rendered.stream === 'stderr') {
      deps.writeStderr(rendered.text);
      deps.exit(rendered.exitCode);
      return;
    }
    deps.writeStdout(rendered.text);
  };
}
