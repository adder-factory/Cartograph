import { describe, expect, it } from 'vitest';
import {
  createComponentExtractorRuntime,
  extractComponentFile,
  mergeOffsetExtractionResult,
  type ComponentExtractorConfig,
  type ComponentExtractorState,
} from '../src/extraction/component-extractor-helpers.js';
import type { ExtractionResult } from '../src/types.js';

function config(overrides: Partial<ComponentExtractorConfig> = {}): ComponentExtractorConfig {
  return {
    extractionName: 'test-component',
    componentExtension: '.vue',
    componentLanguage: 'vue',
    templateExpressions: () => [],
    templateSkipNames: new Set(),
    ignoredReferenceNames: new Set(),
    ...overrides,
  };
}

function state(): ComponentExtractorState {
  return {
    filePath: 'src/App.vue',
    source: '<template></template>',
    nodes: [],
    edges: [],
    unresolvedReferences: [],
    errors: [],
  };
}

describe('component extractor helpers', () => {
  it('records a parse error when top-level component extraction throws', () => {
    const runtime = createComponentExtractorRuntime('src/App.vue', '<template>{{ broken() }}</template>');

    const result = extractComponentFile(
      runtime,
      config({
        templateExpressions: () => {
          throw new Error('template scanner failed');
        },
      }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.code).toBe('parse_error');
    expect(result.errors[0]!.message).toContain('test-component extraction error');
    expect(result.errors[0]!.message).toContain('template scanner failed');
  });

  it('offsets script extraction errors back to component source lines', () => {
    const st = state();
    const result: ExtractionResult = {
      nodes: [],
      edges: [],
      unresolvedReferences: [],
      errors: [{ message: 'script parse failed', severity: 'error', code: 'parse_error', line: 3 }],
      durationMs: 1,
    };

    mergeOffsetExtractionResult({
      st,
      result,
      blockStart: 10,
      componentNodeId: 'component:src/App.vue:App',
      language: 'vue',
    });

    expect(st.errors).toEqual([{ message: 'script parse failed', severity: 'error', code: 'parse_error', line: 13 }]);
  });
});
