import { describe, expect, it } from 'vitest';
import { renderBackendStartCommand } from '../src/features/backend/runtime.js';

describe('backend feature runtime', () => {
  it('shell-quotes backend command arguments with spaces and quotes', () => {
    expect(
      renderBackendStartCommand({
        id: 'embed',
        labels: ['embedding'],
        endpoint: 'http://localhost:8080',
        command: 'llama-server',
        args: ['-m', "/models/jina embed's.gguf", '--port', '8080'],
        modelPath: "/models/jina embed's.gguf",
      }),
    ).toBe("llama-server -m '/models/jina embed'\\''s.gguf' --port 8080");
  });
});
