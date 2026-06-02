import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractStringImports, scanStringImports } from '../src/string-imports/index.js';

describe('string import lexer', () => {
  it('finds import-shaped specifiers in string and template literals while skipping code comments and regexes', () => {
    const refs = scanStringImports(
      'src/codegen.ts',
      [
        "// `import hidden from './commented';`",
        '/* const x = "require(\'./block-comment\')"; */',
        'const re = /import\\s+from\\s+[\'"]\\.\\/regex[\'"]/g;',
        'const fixture = `',
        "import defaultExport from './default';",
        "import { named } from './named';",
        "import './side-effect';",
        '${(() => "const nested = require(\'./nested\');")()}',
        "const dyn = await import('./dynamic');",
        '`;',
        'const quoted = "const cjs = require(\'./quoted-cjs\');";',
        'const duplicate = "const cjs = require(\'./quoted-cjs\');";',
      ].join('\n'),
    );

    expect(refs.map((ref) => [ref.moduleName, ref.containerKind])).toEqual([
      ['./nested', 'string_literal'],
      ['./default', 'template_string'],
      ['./named', 'template_string'],
      ['./side-effect', 'template_string'],
      ['./dynamic', 'template_string'],
      ['./quoted-cjs', 'string_literal'],
      ['./quoted-cjs', 'string_literal'],
    ]);
    expect(refs.map((ref) => ref.moduleName)).not.toContain('./commented');
    expect(refs.map((ref) => ref.moduleName)).not.toContain('./block-comment');
    expect(refs.map((ref) => ref.moduleName)).not.toContain('./regex');
  });

  it('extracts only supported readable files under the project root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-string-imports-'));
    try {
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, 'src', 'fixture.ts'), 'const s = `import thing from "./literal";`;');
      fs.writeFileSync(path.join(root, 'src', 'no-import.ts'), 'const s = "plain text";');
      fs.writeFileSync(path.join(root, 'src', 'python.py'), 'code = "import x from \\"./python\\""');

      const refs = extractStringImports(root, [
        { path: 'src/fixture.ts', language: 'typescript' },
        { path: 'src/no-import.ts', language: 'typescript' },
        { path: 'src/python.py', language: 'python' },
        { path: '../outside.ts', language: 'typescript' },
        { path: 'src/missing.ts', language: 'typescript' },
      ]);

      expect(refs).toEqual([
        {
          filePath: 'src/fixture.ts',
          line: 1,
          moduleName: './literal',
          raw: 'import thing from "./literal"',
          containerKind: 'template_string',
        },
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
