import { describe, expect, it } from 'vitest';
import { buildSecretsEvaluationInput } from '../src/biomarkers/per-file-shared.js';

describe('biomarker per-file shared helpers', () => {
  it('retains source language in the shared main and worker secrets input', () => {
    const result = buildSecretsEvaluationInput(
      {
        id: 'function:src/example.py:sanitize_credentials',
        name: 'sanitize_credentials',
        language: 'python',
        signature: '(password: str) -> str',
        docstring: 'Redacts a credential.',
      },
      'return password.replace(password, "***")',
    );

    expect(result).toEqual({
      id: 'function:src/example.py:sanitize_credentials',
      name: 'sanitize_credentials',
      language: 'python',
      signature: '(password: str) -> str',
      docstring: 'Redacts a credential.',
      summary: null,
      body: 'return password.replace(password, "***")',
    });
  });
});
