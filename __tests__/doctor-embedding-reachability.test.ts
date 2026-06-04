/**
 * Doctor's `Embedding endpoint` check + the `Detected LLM backends`
 * informational line — pinned via `runDoctor` end-to-end with the
 * scanner's `scanForLlmBackends` real implementation. We exercise it
 * by spinning up a Bun.serve mock and pointing the project's
 * `embeddingLlm.endpoint` at the mock's URL.
 *
 * The mock URL lives at an OS-assigned port (`port: 0`), so it lands
 * outside the scanner's well-known port list. The scanner picks it
 * up via the `extraEndpoints` parameter that the doctor passes for
 * the configured endpoint.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runDoctor } from '../src/installer/doctor.js';

interface MockServer {
  url: string;
  stop(): void;
}

function startEmbeddingMock(): MockServer {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/v1/models') {
        return Response.json({ data: [{ id: 'jina-embeddings-v2-base-code', object: 'model' }] });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return { url: `http://localhost:${server.port}`, stop: () => server.stop() };
}

describe('runDoctor — embedding endpoint reachability', () => {
  const servers: MockServer[] = [];
  let projectPath: string;

  beforeEach(async () => {
    projectPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'cg-doctor-test-'));
    await fsp.mkdir(path.join(projectPath, '.cartograph'));
  });

  afterEach(async () => {
    while (servers.length > 0) servers.pop()!.stop();
    if (fs.existsSync(projectPath)) await fsp.rm(projectPath, { recursive: true, force: true });
  });

  async function writeConfig(embeddingLlm: Record<string, unknown>): Promise<void> {
    await fsp.writeFile(
      path.join(projectPath, '.cartograph', 'config.json'),
      JSON.stringify({ llm: { embeddingLlm } }, null, 2),
    );
  }

  async function writeLlmConfig(llm: Record<string, unknown>): Promise<void> {
    await fsp.writeFile(path.join(projectPath, '.cartograph', 'config.json'), JSON.stringify({ llm }, null, 2));
  }

  it('reports ok when configured openai-compat endpoint responds', async () => {
    const mock = startEmbeddingMock();
    servers.push(mock);
    await writeConfig({ provider: 'openai-compat', endpoint: mock.url, model: 'jina' });

    const result = await runDoctor({ projectPath });
    const embCheck = result.checks.find((c) => c.name === 'Embedding endpoint');
    expect(embCheck).toBeDefined();
    expect(embCheck!.status).toBe('ok');
    expect(embCheck!.detail).toContain(mock.url);
    expect(embCheck!.detail).toMatch(/1 model loaded/);
  });

  it('reports warn when configured openai-compat endpoint is unreachable', async () => {
    // Don't start a mock — point at an unbound port.
    await writeConfig({ provider: 'openai-compat', endpoint: 'http://localhost:1', model: 'jina' });

    const result = await runDoctor({ projectPath });
    const embCheck = result.checks.find((c) => c.name === 'Embedding endpoint');
    expect(embCheck).toBeDefined();
    expect(embCheck!.status).toBe('warn');
    expect(embCheck!.detail).toContain('http://localhost:1');
    expect(embCheck!.detail).toMatch(/not responding/);
    expect(embCheck!.remediation).toBeDefined();
  });

  it('reports warn when openai-compat provider has no endpoint set', async () => {
    const prior = process.env.OPENAI_API_KEY;
    try {
      delete process.env.OPENAI_API_KEY;
      await writeConfig({ provider: 'openai-compat', model: 'jina' });

      const result = await runDoctor({ projectPath });
      const embCheck = result.checks.find((c) => c.name === 'Embedding endpoint');
      expect(embCheck).toBeDefined();
      expect(embCheck!.status).toBe('warn');
      expect(embCheck!.detail).toMatch(/not set/);
    } finally {
      if (prior === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prior;
    }
  });

  it('reports ok for endpoint-less cloud OpenAI config when OPENAI_API_KEY is set', async () => {
    const prior = process.env.OPENAI_API_KEY;
    try {
      process.env.OPENAI_API_KEY = 'sk-test';
      await writeConfig({ provider: 'openai-compat', model: 'text-embedding-3-small' });

      const result = await runDoctor({ projectPath });
      const embCheck = result.checks.find((c) => c.name === 'Embedding endpoint');
      expect(embCheck).toBeDefined();
      expect(embCheck!.status).toBe('ok');
      expect(embCheck!.detail).toContain('OPENAI_API_KEY');
    } finally {
      if (prior === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prior;
    }
  });

  it('reports ok for endpoint-less cloud OpenAI config with configured apiKey', async () => {
    await writeConfig({ provider: 'openai-compat', model: 'text-embedding-3-small', apiKey: 'sk-configured' });

    const result = await runDoctor({ projectPath });
    const embCheck = result.checks.find((c) => c.name === 'Embedding endpoint');
    expect(embCheck).toBeDefined();
    expect(embCheck!.status).toBe('ok');
    expect(embCheck!.detail).toContain('configured apiKey');
  });

  it('skips the reachability check when provider is something other than `openai-compat`', async () => {
    // Pre-2026-05-24c this branch covered the in-process `'local'`
    // pathway; that pathway is gone. The skip branch still applies
    // to any future / unknown provider value.
    await writeConfig({ provider: 'unknown-future-backend', model: 'm' });

    const result = await runDoctor({ projectPath });
    const embCheck = result.checks.find((c) => c.name === 'Embedding endpoint');
    expect(embCheck).toBeUndefined();
  });

  it('always emits the `Detected LLM backends` informational line', async () => {
    const result = await runDoctor({ projectPath, skipProjectChecks: true });
    const line = result.checks.find((c) => c.name === 'Detected LLM backends');
    expect(line).toBeDefined();
    expect(line!.status).toBe('ok'); // informational — always ok
  });

  it('honors CARTOGRAPH_MODELS_DIR for the LLM models check', async () => {
    const modelsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cg-doctor-models-dir-'));
    const prior = process.env.CARTOGRAPH_MODELS_DIR;
    try {
      process.env.CARTOGRAPH_MODELS_DIR = modelsDir;
      await fsp.writeFile(path.join(modelsDir, 'custom.gguf'), '');

      const result = await runDoctor({ projectPath, skipProjectChecks: true });
      const modelsCheck = result.checks.find((c) => c.name === 'LLM models');
      expect(modelsCheck).toBeDefined();
      expect(modelsCheck!.status).toBe('ok');
      expect(modelsCheck!.detail).toContain(modelsDir);
    } finally {
      if (prior === undefined) delete process.env.CARTOGRAPH_MODELS_DIR;
      else process.env.CARTOGRAPH_MODELS_DIR = prior;
      await fsp.rm(modelsDir, { recursive: true, force: true });
    }
  });

  it('warns when a configured local model file is missing', async () => {
    const existingModel = path.join(projectPath, 'embed.gguf');
    const missingAskModel = path.join(projectPath, 'missing-ask.gguf');
    await fsp.writeFile(existingModel, '');
    await writeLlmConfig({
      embeddingLlm: { provider: 'openai-compat', endpoint: 'http://localhost:1', model: existingModel },
      summarizeLlm: { provider: 'openai-compat', endpoint: 'http://localhost:2', model: missingAskModel },
    });

    const result = await runDoctor({ projectPath });
    const filesCheck = result.checks.find((c) => c.name === 'Configured model files');
    expect(filesCheck).toBeDefined();
    expect(filesCheck!.status).toBe('warn');
    expect(filesCheck!.detail).toContain('summarizeLlm');
    expect(filesCheck!.detail).toContain(missingAskModel);
    expect(filesCheck!.remediation).toContain('--minimal --write-config');
  });

  it('success wording is explicit when project checks are skipped', async () => {
    const modelsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cg-doctor-models-dir-'));
    const prior = process.env.CARTOGRAPH_MODELS_DIR;
    try {
      process.env.CARTOGRAPH_MODELS_DIR = modelsDir;
      await fsp.writeFile(path.join(modelsDir, 'custom.gguf'), '');

      const { formatDoctorReport } = await import('../src/installer/doctor.js');
      const result = await runDoctor({ projectPath, skipProjectChecks: true });
      const text = formatDoctorReport(result);
      expect(text).toContain('Project init/config checks were skipped');
      expect(text).not.toContain('cartograph is ready to use');
    } finally {
      if (prior === undefined) delete process.env.CARTOGRAPH_MODELS_DIR;
      else process.env.CARTOGRAPH_MODELS_DIR = prior;
      await fsp.rm(modelsDir, { recursive: true, force: true });
    }
  });
});
