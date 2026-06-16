import { errMsg } from '../../errors.js';
import { parseViewerPort } from './runtime.js';
import type { CliOptionCommand } from '../shared/cli-command.js';

type CommandLike = CliOptionCommand;

export interface ViewerServerModule {
  startViewerServer: (
    projectPath: string,
    opts?: { port?: number; session?: string; allowConfigEdit?: boolean },
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
    .description('Open the local web viewer (graph visualization, impact tools, health) for the indexed graph')
    .option('-p, --port <n>', `HTTP port (default 8765; pass 0 for an OS-picked port)`)
    .option('--no-open', 'Do not auto-open the URL in a browser')
    .option(
      '--session <idOrLabel>',
      'Scope this viewer to one recorded MCP session (id or label); run one per agent on its own port',
    )
    .option(
      '--allow-config-edit',
      'Enable the in-viewer config editor (edit .cartograph/config.json + re-index) even on a non-loopback bind; loopback binds enable it by default',
    )
    .action(
      async (
        pathArg: string | undefined,
        options: { port?: string; open?: boolean; session?: string; allowConfigEdit?: boolean },
      ) => {
        const projectPath = resolveProjectPath(pathArg);
        if (!isInitialized(projectPath)) {
          error(`No Cartograph index at ${projectPath}. Run \`cartograph index ${projectPath}\` first.`);
          process.exit(1);
        }

        const parsedPort = parseViewerPort(options.port);
        if (!parsedPort.ok) {
          error(parsedPort.error);
          process.exitCode = 1;
          return;
        }

        if (options.session?.trim() === '') {
          error('--session requires a session id or label (an empty value would silently serve every session)');
          process.exitCode = 1;
          return;
        }

        try {
          const { startViewerServer, openInBrowser } = await loadViewerServer();
          const startOpts = {
            ...(parsedPort.value === undefined ? {} : { port: parsedPort.value }),
            ...(options.session ? { session: options.session } : {}),
            ...(options.allowConfigEdit ? { allowConfigEdit: true } : {}),
          };
          let handle: Awaited<ReturnType<typeof startViewerServer>>;
          try {
            handle = await startViewerServer(projectPath, startOpts);
          } catch (startErr) {
            const code = (startErr as NodeJS.ErrnoException | null)?.code;
            // One viewer per project: when the DEFAULT port is taken
            // (most likely another project's viewer), pick a free one
            // instead of erroring. An explicit -p stays strict.
            if (code !== 'EADDRINUSE' || parsedPort.value !== undefined) throw startErr;
            info('Port 8765 is taken (another viewer?) — picking a free port.');
            handle = await startViewerServer(projectPath, { ...startOpts, port: 0 });
          }
          info(`Viewer running at ${handle.url}`);
          info(`  project: ${projectPath}`);
          if (options.session) info(`  session: ${options.session} (scoped — other sessions are not served)`);
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
      },
    );
}
