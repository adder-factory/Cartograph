interface ToolArgResult {
  ok: boolean;
  args?: Record<string, unknown>;
  error?: string;
}

interface ToolCallDeps {
  error: (message: string) => void;
  runViaMCP: (toolName: string, args: Record<string, unknown>, projectPath?: string) => Promise<void>;
}

export async function runMcpToolFamilyCall(args: {
  toolName: string;
  result: ToolArgResult;
  projectPath: string | undefined;
  deps: ToolCallDeps;
}): Promise<void> {
  const { toolName, result, projectPath, deps } = args;
  if (!result.ok) {
    deps.error(result.error ?? 'Invalid command arguments.');
    process.exitCode = 1;
    return;
  }
  await deps.runViaMCP(toolName, result.args ?? {}, projectPath);
}
