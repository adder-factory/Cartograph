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
  await loadGrammarsForLanguages(['arkts', 'cuda']);
});

describe('ArkTS extraction', () => {
  it('detects ArkTS source', () => {
    expect(detectLanguage('entry/src/main/ets/pages/Index.ets')).toBe('arkts');
    expect(isLanguageSupported('arkts')).toBe(true);
    expect(getSupportedLanguages()).toContain('arkts');
  });

  it('extracts structs, classes, fields, methods, imports, signatures, and calls', () => {
    const source = `
import router from '@ohos.router';

@Component
struct CounterView {
  @State count: number = 0;
  build() {
    Button('Tap').onClick(() => {
      this.increment();
      router.pushUrl({ url: 'pages/Next' });
    });
  }
  increment(): void { this.count += 1; }
}

class WorkerService {
  run(): void { new Worker().start(); }
}
`;

    const result = extractFromSource('Index.ets', source, 'arkts');
    const byKindName = new Map(result.nodes.map((node) => [`${node.kind}:${node.name}`, node]));

    expect(byKindName.has('struct:CounterView')).toBe(true);
    expect(byKindName.has('field:count')).toBe(true);
    expect(byKindName.get('method:increment')?.signature).toBe('(): void');
    expect(byKindName.has('class:WorkerService')).toBe(true);
    expect(byKindName.get('method:run')?.signature).toBe('(): void');
    expect(byKindName.has('import:@ohos.router')).toBe(true);

    const calls = result.unresolvedReferences
      .filter((ref) => ref.referenceKind === 'calls')
      .map((ref) => ref.referenceName);
    expect(calls).toContain('Button().onClick');
    expect(calls).toContain('increment');
    expect(calls).toContain('router.pushUrl');
    expect(calls).toContain('start');
  });
});

describe('CUDA extraction', () => {
  it('detects CUDA source and headers', () => {
    expect(detectLanguage('kernels/fill.cu')).toBe('cuda');
    expect(detectLanguage('kernels/fill.cuh')).toBe('cuda');
    expect(isLanguageSupported('cuda')).toBe(true);
    expect(getSupportedLanguages()).toContain('cuda');
  });

  it('extracts kernels, host functions, includes, and kernel-launch calls', () => {
    const source = `
#include <cuda_runtime.h>

__global__ void fillKernel(float *out) {
  int idx = threadIdx.x;
  out[idx] = 1.0f;
}

void launchFill(float *out) {
  fillKernel<<<1, 32>>>(out);
  cudaDeviceSynchronize();
}
`;

    const result = extractFromSource('fill.cu', source, 'cuda');
    const byKindName = new Map(result.nodes.map((node) => [`${node.kind}:${node.name}`, node]));

    expect(byKindName.has('function:fillKernel')).toBe(true);
    expect(byKindName.get('function:launchFill')?.signature).toBe('void (float *out)');
    expect(byKindName.has('import:cuda_runtime.h')).toBe(true);

    const calls = result.unresolvedReferences
      .filter((ref) => ref.referenceKind === 'calls')
      .map((ref) => ref.referenceName);
    expect(calls).toContain('fillKernel');
    expect(calls).toContain('cudaDeviceSynchronize');
  });
});
