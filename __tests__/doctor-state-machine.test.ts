import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { formatDoctorReport, runDoctor, type DoctorResultWithFix } from '../src/installer/doctor.js';

interface DoctorStateCase {
  readonly name: string;
  readonly setup: () => Promise<{ projectPath: string; skipProjectChecks?: boolean }>;
  readonly expect: (result: DoctorResultWithFix) => void;
}

const tempRoots: string[] = [];
const LOOPBACK_ENDPOINT = ['http://', 'localhost:1'].join('');
const PARTIAL_MODEL_BYTES = 1280;
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

async function makeProject(prefix: string, config?: Record<string, unknown>): Promise<string> {
  const projectPath = await makeTempDir(prefix);
  await fsp.mkdir(path.join(projectPath, '.cartograph'), { recursive: true });
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
