import { errMsg } from '../../errors.js';
import { parseViewerPort } from './runtime.js';

interface CommandLike {
  command(name: string): CommandLike;
  description(text: string): CommandLike;
  option(...args: unknown[]): CommandLike;
  action(fn: (...args: any[]) => unknown): CommandLike;
}

export interface ViewerServerModule {
  startViewerServer: (
    projectPath: string,
    opts?: { port?: number },
  ) => Promise<{ url: string; close: () => Promise<void> }>;
  openInBrowser: (url: string) => void;
}

export interface ViewerCommandDeps {
  program: CommandLike;
  resolveProjectPath: (pathArg?: string) => string;
  isInitialized: (projectPath: string) => boolean;
  error: (message: string) => void;
  info: (message: string) => void;
  loadViewerServer: () => Promise<ViewerServerModule>;
}

export function registerViewerCommand(deps: ViewerCommandDeps): void {
  const { program, resolveProjectPath, isInitialized, error, info, loadViewerServer } = deps;
  program
    .command('viewer [path]')
    .description('Open the local web viewer for the indexed graph')
    .option('-p, --port <n>', `HTTP port (default 8765; pass 0 for an OS-picked port)`)
    .option('--no-open', 'Do not auto-open the URL in a browser')
    .action(async (pathArg: string | undefined, options: { port?: string; open?: boolean }) => {
      const projectPath = resolveProjectPath(pathArg);
      if (!isInitialized(projectPath)) {
        error(
          `No Cartograph index at ${projectPath}. Run \`cartograph admin init\` and \`cartograph admin index\` first.`,
        );
        process.exit(1);
      }

      const parsedPort = parseViewerPort(options.port);
      if (!parsedPort.ok) {
        error(parsedPort.error);
        process.exitCode = 1;
        return;
      }

      try {
        const { startViewerServer, openInBrowser } = await loadViewerServer();
        const handle = await startViewerServer(
          projectPath,
          parsedPort.value === undefined ? {} : { port: parsedPort.value },
        );
        info(`Viewer running at ${handle.url}`);
        info(`  project: ${projectPath}`);
        info(`  press Ctrl+C to stop`);
        // commander auto-inverts `--no-open` -> options.open === false
        if (options.open !== false) openInBrowser(handle.url);
        // Park forever: keep the process alive until the user kills it.
        process.on('SIGINT', () => {
          handle.close().finally(() => process.exit(0));
        });
      } catch (err) {
        error(`Failed to start viewer: ${errMsg(err)}`);
        process.exit(1);
      }
    });
}
