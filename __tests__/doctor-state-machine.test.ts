import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { formatDoctorReport, runDoctor, type DoctorResultWithFix } from '../src/installer/doctor.js';
import {
  checkConfiguredModelFiles,
  checkModels,
  checkProjectConfig,
  readLlmFromConfig,
} from '../src/installer/doctor/model-checks.js';
import { isolateBunInstall } from './support/bun-install-isolation.js';

interface DoctorStateCase {
  readonly name: string;
  readonly setup: () => Promise<{ projectPath: string; skipProjectChecks?: boolean }>;
  readonly expect: (result: DoctorResultWithFix) => void;
}

const tempRoots: string[] = [];
const LOOPBACK_ENDPOINT = ['http://', 'localhost:1'].join('');
const LOCAL_ENDPOINT_PREFIX = ['http://', 'localhost:'].join('');
const PARTIAL_MODEL_BYTES = 1280;
const PORT_EMBED = 8080;
const PORT_CHAT = 8081;
const PORT_ASK = 8082;
const PORT_RERANK = 8083;
const processEnv = process['env'];
const originalModelsDir = processEnv.CARTOGRAPH_MODELS_DIR;

function findCheck(result: DoctorResultWithFix, name: string) {
  const check = result.checks.find((item) => item.name === name);
  if (!check) throw new Error(`Doctor check not found: ${name}`);
  return check;
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function makeProject(
  prefix: string,
  config?: Record<string, unknown>,
  options: { databaseFile?: boolean } = {},
): Promise<string> {
  const projectPath = await makeTempDir(prefix);
  await fsp.mkdir(path.join(projectPath, '.cartograph'), { recursive: true });
  if (options.databaseFile !== false) {
    await fsp.writeFile(path.join(projectPath, '.cartograph', 'cartograph.db'), '');
  }
  if (config !== undefined) {
    await fsp.writeFile(path.join(projectPath, '.cartograph', 'config.json'), JSON.stringify(config, null, 2));
  }
  return projectPath;
}

async function pointModelsDirAtGguf(): Promise<string> {
  const modelsDir = await makeTempDir('cg-doctor-models-');
  await fsp.writeFile(path.join(modelsDir, 'fixture.gguf'), '');
  processEnv.CARTOGRAPH_MODELS_DIR = modelsDir;
  return modelsDir;
}

async function pointModelsDirAtMissingPath(): Promise<string> {
  const root = await makeTempDir('cg-doctor-no-models-');
  const modelsDir = path.join(root, 'missing-models');
  processEnv.CARTOGRAPH_MODELS_DIR = modelsDir;
  return modelsDir;
}

function singleEndpointConfig(endpoint: string): Record<string, unknown> {
  return {
    llm: {
      summarizeLlm: { provider: 'openai-compat', endpoint, model: 'qwen2.5-coder:3b' },
      localLlm: { provider: 'openai-compat', endpoint, model: 'qwen2.5-coder:3b' },
      embeddingLlm: { provider: 'openai-compat', endpoint, model: 'nomic-embed-text' },
    },
  };
}

function localModelConfig(projectPath: string, includeMissing = false): Record<string, unknown> {
  const embed = path.join(projectPath, 'embed.gguf');
  const chat = path.join(projectPath, 'chat.gguf');
  const ask = path.join(projectPath, includeMissing ? 'missing-ask.gguf' : 'ask.gguf');
  fs.writeFileSync(embed, '');
  fs.writeFileSync(chat, '');
  if (!includeMissing) fs.writeFileSync(ask, '');
  return {
    llm: {
      summarizeLlm: { provider: 'openai-compat', endpoint: LOOPBACK_ENDPOINT, model: chat },
      localLlm: { provider: 'openai-compat', endpoint: LOOPBACK_ENDPOINT, model: chat },
      askLlm: { provider: 'openai-compat', endpoint: LOOPBACK_ENDPOINT, model: ask },
      embeddingLlm: { provider: 'openai-compat', endpoint: LOOPBACK_ENDPOINT, model: embed },
    },
  };
}

afterEach(async () => {
  if (originalModelsDir === undefined) delete processEnv.CARTOGRAPH_MODELS_DIR;
  else processEnv.CARTOGRAPH_MODELS_DIR = originalModelsDir;
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop()!;
    if (fs.existsSync(dir)) await fsp.rm(dir, { recursive: true, force: true });
  }
});

describe('runDoctor installer state machine', () => {
  // These cases exercise PROJECT state, not the global install, and run
  // the full `runDoctor` — isolate BUN_INSTALL so the host machine's real
  // `bun link` state cannot leak into overallStatus or the report text.
  isolateBunInstall();

  it('emits stable check ids alongside human-readable names', async () => {
    await pointModelsDirAtGguf();
    const result = await runDoctor({
      projectPath: await makeTempDir('cg-doctor-stable-ids-'),
      skipProjectChecks: true,
    });

    expect(result.checks.every((check) => typeof check.id === 'string' && check.id.length > 0)).toBe(true);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'bun-runtime', name: 'Bun runtime' }),
        expect.objectContaining({ id: 'project-checks', name: 'Project checks' }),
        expect.objectContaining({ id: 'llm-models', name: 'LLM models' }),
        expect.objectContaining({ id: 'detected-llm-backends', name: 'Detected LLM backends' }),
        expect.objectContaining({ id: 'recommended-tuning', name: 'Recommended tuning' }),
      ]),
    );
  });

  const cases: DoctorStateCase[] = [
    {
      name: 'uninitialized project',
      setup: async () => {
        await pointModelsDirAtGguf();
        return { projectPath: await makeTempDir('cg-doctor-uninitialized-') };
      },
      expect: (result) => {
        expect(result.overallStatus).toBe('fail');
        expect(findCheck(result, 'Project init').status).toBe('fail');
        expect(result.checks.some((item) => item.name === 'Project config')).toBe(false);
        expect(findCheck(result, 'LLM models').status).toBe('ok');
      },
    },
    {
      name: 'initialized without database storage',
      setup: async () => {
        await pointModelsDirAtGguf();
        return { projectPath: await makeProject('cg-doctor-no-db-', {}, { databaseFile: false }) };
      },
      expect: (result) => {
        expect(result.overallStatus).toBe('fail');
        const storage = findCheck(result, 'Database storage');
        expect(storage.status).toBe('fail');
        expect(storage.detail).toContain('No SQLite database');
      },
    },
    {
      name: 'initialized without config',
      setup: async () => {
        await pointModelsDirAtGguf();
        return { projectPath: await makeProject('cg-doctor-no-config-') };
      },
      expect: (result) => {
        expect(result.overallStatus).toBe('warn');
        expect(findCheck(result, 'Project init').status).toBe('ok');
        expect(findCheck(result, 'Project config').detail).toContain('No config.json');
      },
    },
    {
      name: 'initialized config without llm block',
      setup: async () => {
        await pointModelsDirAtGguf();
        return { projectPath: await makeProject('cg-doctor-no-llm-', {}) };
      },
      expect: (result) => {
        expect(result.overallStatus).toBe('warn');
        const config = findCheck(result, 'Project config');
        expect(config.status).toBe('warn');
        expect(config.detail).toContain('no `llm` block');
      },
    },
    {
      name: 'bring-your-own OpenAI-compatible backend with no local models',
      setup: async () => {
        await pointModelsDirAtMissingPath();
        return {
          projectPath: await makeProject('cg-doctor-byo-backend-', singleEndpointConfig(LOOPBACK_ENDPOINT)),
        };
      },
      expect: (result) => {
        expect(result.overallStatus).toBe('warn');
        const models = findCheck(result, 'LLM models');
        expect(models.status).toBe('ok');
        expect(models.detail).toContain('no local GGUF model directory is required');
        expect(result.checks.some((item) => item.name === 'Configured model files')).toBe(false);
        expect(findCheck(result, 'Embedding endpoint').status).toBe('warn');
      },
    },
    {
      name: 'minimal/full local model config with existing GGUF paths',
      setup: async () => {
        await pointModelsDirAtMissingPath();
        const projectPath = await makeProject('cg-doctor-local-models-');
        await fsp.writeFile(
          path.join(projectPath, '.cartograph', 'config.json'),
          JSON.stringify(localModelConfig(projectPath), null, 2),
        );
        return { projectPath };
      },
      expect: (result) => {
        expect(findCheck(result, 'LLM models').status).toBe('ok');
        expect(findCheck(result, 'LLM models').detail).toContain('configured local model file path');
        expect(findCheck(result, 'Configured model files').status).toBe('ok');
        const backendCommands = findCheck(result, 'Backend start commands');
        expect(backendCommands.status).toBe('ok');
        expect(backendCommands.detail).toContain('llama-server -m');
        expect(backendCommands.detail).toContain('--embeddings');
        expect(backendCommands.detail).toContain('--port 1');
        expect(formatDoctorReport(result)).toContain('Backend start commands');
      },
    },
    {
      name: 'configured local model file missing',
      setup: async () => {
        await pointModelsDirAtMissingPath();
        const projectPath = await makeProject('cg-doctor-missing-model-file-');
        await fsp.writeFile(
          path.join(projectPath, '.cartograph', 'config.json'),
          JSON.stringify(localModelConfig(projectPath, true), null, 2),
        );
        return { projectPath };
      },
      expect: (result) => {
        const files = findCheck(result, 'Configured model files');
        expect(files.status).toBe('warn');
        expect(files.detail).toContain('missing-ask.gguf');
      },
    },
    {
      name: 'configured local model file missing with interrupted partial download',
      setup: async () => {
        await pointModelsDirAtMissingPath();
        const projectPath = await makeProject('cg-doctor-partial-model-file-');
        await fsp.writeFile(
          path.join(projectPath, '.cartograph', 'config.json'),
          JSON.stringify(localModelConfig(projectPath, true), null, 2),
        );
        await fsp.writeFile(path.join(projectPath, 'missing-ask.gguf.partial'), Buffer.alloc(PARTIAL_MODEL_BYTES));
        return { projectPath };
      },
      expect: (result) => {
        const files = findCheck(result, 'Configured model files');
        expect(files.status).toBe('warn');
        expect(files.detail).toContain('missing-ask.gguf');
        expect(files.detail).toContain('partial download found');
        expect(files.detail).toContain('missing-ask.gguf.partial');
        expect(files.detail).toContain('1.3 KB');
        expect(files.remediation).toContain('previous model download was interrupted');
        expect(files.remediation).toContain('cartograph admin install-models');
      },
    },
    {
      name: 'skip project checks',
      setup: async () => {
        await pointModelsDirAtGguf();
        return { projectPath: await makeTempDir('cg-doctor-skip-project-'), skipProjectChecks: true };
      },
      expect: (result) => {
        expect(result.projectChecksSkipped).toBe(true);
        expect(findCheck(result, 'Project checks').status).toBe('ok');
        expect(result.checks.some((item) => item.name === 'Project init')).toBe(false);
        expect(formatDoctorReport(result)).toContain('Project init/config checks were skipped');
      },
    },
  ];

  for (const entry of cases) {
    it(entry.name, async () => {
      const setup = await entry.setup();
      const result = await runDoctor({
        projectPath: setup.projectPath,
        skipProjectChecks: setup.skipProjectChecks,
      });
      expect(result.checks.length).toBeGreaterThan(0);
      entry.expect(result);
    });
  }
});

describe('doctor model/config checks', () => {
  it('reports unmanaged model directories without requiring a full doctor run', async () => {
    const emptyModelsDir = await makeTempDir('cg-doctor-empty-models-');
    processEnv.CARTOGRAPH_MODELS_DIR = emptyModelsDir;

    const noGgufs = await checkModels(null);
    expect(noGgufs.status).toBe('warn');
    expect(noGgufs.detail).toContain('contains no .gguf files');

    await fsp.writeFile(path.join(emptyModelsDir, 'embed.gguf'), '');
    await fsp.writeFile(path.join(emptyModelsDir, 'chat.gguf'), '');
    const present = await checkModels(null);
    expect(present.status).toBe('ok');
    expect(present.detail).toContain('2 models present');
  });

  it('validates project config JSON, runtime config, and llm extraction paths', async () => {
    const invalidJsonProject = await makeProject('cg-doctor-invalid-json-');
    await fsp.writeFile(path.join(invalidJsonProject, '.cartograph', 'config.json'), '{not json');
    const invalidJson = await checkProjectConfig(invalidJsonProject);
    expect(invalidJson.status).toBe('fail');
    expect(invalidJson.detail).toContain('not valid JSON');
    expect(await readLlmFromConfig(invalidJsonProject)).toBeNull();

    const invalidRuntimeProject = await makeProject('cg-doctor-invalid-runtime-', {
      llm: {
        summarizeLlm: { provider: 'bad-provider' },
      },
    });
    const invalidRuntime = await checkProjectConfig(invalidRuntimeProject);
    expect(invalidRuntime.status).toBe('fail');
    expect(invalidRuntime.detail).toContain('runtime validation');

    const validProject = await makeProject('cg-doctor-valid-runtime-', singleEndpointConfig(LOOPBACK_ENDPOINT));
    const valid = await checkProjectConfig(validProject);
    expect(valid.status).toBe('ok');
    expect(await readLlmFromConfig(validProject)).toMatchObject({
      embeddingLlm: expect.objectContaining({ model: 'nomic-embed-text' }),
    });
  });

  it('summarizes missing configured model files with truncation and partial downloads', async () => {
    const projectPath = await makeProject('cg-doctor-many-missing-models-');
    const llm = fiveMissingLocalModelTiers(projectPath);
    await fsp.writeFile(path.join(projectPath, 'ask.gguf.partial'), Buffer.alloc(PARTIAL_MODEL_BYTES));

    const check = await checkConfiguredModelFiles(llm);

    expect(check).toMatchObject({
      id: 'configured-model-files',
      name: 'Configured model files',
      status: 'warn',
    });
    expect(check?.detail).toContain('5 configured local model files missing');
    expect(check?.detail).toContain('+1 more');
    expect(check?.detail).toContain('ask.gguf.partial');
    expect(check?.remediation).toContain('previous model download was interrupted');
    expect(await checkConfiguredModelFiles(null)).toBeNull();
  });
});

function fiveMissingLocalModelTiers(projectPath: string): Record<string, unknown> {
  return {
    summarizeLlm: localModelTier(path.join(projectPath, 'summary.gguf'), PORT_CHAT),
    localLlm: localModelTier(path.join(projectPath, 'local.gguf'), PORT_CHAT),
    askLlm: localModelTier(path.join(projectPath, 'ask.gguf'), PORT_ASK),
    embeddingLlm: localModelTier(path.join(projectPath, 'embed.gguf'), PORT_EMBED),
    rerankerLlm: localModelTier(path.join(projectPath, 'rerank.gguf'), PORT_RERANK),
  };
}

function localModelTier(model: string, port: number): Record<string, unknown> {
  return {
    provider: 'openai-compat',
    endpoint: `${LOCAL_ENDPOINT_PREFIX}${port}`,
    model,
  };
}
