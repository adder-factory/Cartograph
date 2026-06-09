import { describe, expect, it } from 'vitest';
import { buildHostDiagnostics, renderHostDiagnostics } from '../src/features/host-diagnostics/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]!.text;
}

describe('host diagnostics', () => {
  it('renders profile/tool and install-target signals', () => {
    const report = buildHostDiagnostics({
      profile: 'core',
      writeToolsEnabled: true,
      lowTokensDefault: false,
      advertisedTools: ['cartograph_context', 'cartograph_explore', 'cartograph_session'],
      targets: [
        {
          id: 'codex',
          displayName: 'Codex CLI',
          location: 'global',
          installed: true,
          alreadyConfigured: true,
          configPath: '/tmp/config.toml',
        },
      ],
    });

    const text = renderHostDiagnostics(report);
    expect(text).toContain('Host Diagnostics');
    expect(text).toContain('session analytics visible:** yes');
    expect(text).toContain('Codex CLI');
    expect(text).toContain('Sub-agent tool visibility is host-specific');
  });

  it('runs through the MCP adapter without install-target filesystem detection', async () => {
    const handler = new ToolHandler(null, { profile: 'core' });
    const text = textOf(
      await handler.execute('cartograph_host_diagnostics', {
        includeInstallTargets: false,
        lowTokens: true,
      }),
    );
    handler.closeAll();

    expect(text).toContain('host profile=core');
    expect(text).toContain('session=yes');
    expect(text).toContain('configured=none');
  });
});
