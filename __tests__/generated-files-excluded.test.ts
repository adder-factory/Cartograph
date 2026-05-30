// Regression test for the generated-code globs in the default exclude
// list (backlog #38 — the small worthwhile slice).
//
// Codegen output (protobuf stubs, build_runner output, `.generated.*`
// files) routinely lands INSIDE source trees, so the directory globs
// (`vendor/`, `dist/`, …) miss it and it gets indexed + summarised +
// embedded like real source. These suffix globs drop it — while
// leaving the hand-written sibling file (`foo.go` next to `foo.pb.go`)
// indexed.

import { describe, it, expect } from 'vitest';
import { createDefaultConfig, shouldIncludeFile } from '../src/config.js';
// The extractor keeps its own copy of shouldIncludeFile — co-verify so
// drift between the two implementations is caught.
import { shouldIncludeFile as shouldIncludeFileExtractor } from '../src/extraction/index.js';

describe('default exclude — generated-code globs (#38)', () => {
  const cfg = createDefaultConfig('/test/project');

  it('excludes generated files but keeps their hand-written siblings', () => {
    const generated = [
      'src/api/service.pb.go',
      'src/api/service_pb2.py',
      'src/api/service_pb2_grpc.py',
      'src/api/service.pb.cc',
      'src/api/service.pb.h',
      'src/api/service_pb.js',
      'src/gql/schema.generated.ts',
      'src/gql/schema.generated.js',
      'lib/model.g.dart',
      'lib/model.freezed.dart',
    ];
    for (const f of generated) {
      expect(shouldIncludeFile(f, cfg), `${f} should be excluded`).toBe(false);
    }

    // Hand-written siblings sharing the base extension stay indexed.
    const handWritten = [
      'src/api/service.go',
      'src/api/service.py',
      'src/api/service.cc',
      'src/api/service.h',
      'src/api/service.js',
      'src/gql/schema.ts',
      'lib/model.dart',
    ];
    for (const f of handWritten) {
      expect(shouldIncludeFile(f, cfg), `${f} should be indexed`).toBe(true);
    }
  });

  it('indexer-side shouldIncludeFile agrees with the config-side answer', () => {
    expect(shouldIncludeFileExtractor('src/api/service.pb.go', cfg)).toBe(false);
    expect(shouldIncludeFileExtractor('src/gql/schema.generated.ts', cfg)).toBe(false);
    expect(shouldIncludeFileExtractor('src/api/service.go', cfg)).toBe(true);
  });
});
