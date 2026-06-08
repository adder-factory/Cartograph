import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction/index.js';
import {
  detectLanguage,
  getSupportedLanguages,
  initGrammars,
  isLanguageSupported,
  loadGrammarsForLanguages,
} from '../src/extraction/grammars.js';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['glsl', 'hlsl']);
});

describe('shader extraction', () => {
  it('detects common GLSL shader extensions', () => {
    for (const ext of ['.glsl', '.vert', '.frag', '.comp', '.geom', '.tesc', '.tese']) {
      expect(detectLanguage(`shader${ext}`)).toBe('glsl');
    }
    expect(isLanguageSupported('glsl')).toBe(true);
    expect(getSupportedLanguages()).toContain('glsl');
  });

  it('detects common HLSL shader extensions', () => {
    for (const ext of ['.hlsl', '.hlsli', '.fx', '.fxh']) {
      expect(detectLanguage(`shader${ext}`)).toBe('hlsl');
    }
    expect(isLanguageSupported('hlsl')).toBe(true);
    expect(getSupportedLanguages()).toContain('hlsl');
  });

  it('extracts GLSL shader structs, functions, signatures, and local call references', () => {
    const source = `
struct Light {
  vec3 position;
  float intensity;
};

float square(float x) {
  return x * x;
}

vec3 computeNormal(vec3 n) {
  return normalize(n);
}

void main() {
  float v = square(2.0);
}
`;

    const result = extractFromSource('shader.frag', source, 'glsl');
    const namesByKind = new Map(result.nodes.map((node) => [`${node.kind}:${node.name}`, node]));

    expect(namesByKind.has('struct:Light')).toBe(true);
    expect(namesByKind.get('function:square')?.signature).toBe('float (float x)');
    expect(namesByKind.get('function:computeNormal')?.signature).toBe('vec3 (vec3 n)');
    expect(namesByKind.get('function:main')?.signature).toBe('void ()');

    const callNames = result.unresolvedReferences
      .filter((ref) => ref.referenceKind === 'calls')
      .map((ref) => ref.referenceName);
    expect(callNames).toContain('square');
    expect(callNames).toContain('normalize');
  });

  it('extracts HLSL shader structs, functions, signatures, and call references', () => {
    const source = `
struct VSInput {
  float4 pos : POSITION;
};

float helper(float x) {
  return x;
}

float4 main(float4 pos : POSITION) : SV_Position {
  return helper(pos.x).xxxx;
}
`;

    const result = extractFromSource('shader.hlsl', source, 'hlsl');
    const namesByKind = new Map(result.nodes.map((node) => [`${node.kind}:${node.name}`, node]));

    expect(namesByKind.has('struct:VSInput')).toBe(true);
    expect(namesByKind.get('function:helper')?.signature).toBe('float (float x)');
    expect(namesByKind.get('function:main')?.signature).toBe('float4 (float4 pos : POSITION)');

    const callNames = result.unresolvedReferences
      .filter((ref) => ref.referenceKind === 'calls')
      .map((ref) => ref.referenceName);
    expect(callNames).toContain('helper');
  });
});
