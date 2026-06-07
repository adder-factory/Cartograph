import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction/index.js';
import { detectLanguage, initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars.js';
import type { Language, NodeKind } from '../src/types.js';

const NEW_LANGUAGES = [
  'css',
  'embedded_template',
  'haskell',
  'html',
  'jsdoc',
  'json',
  'julia',
  'ocaml',
  'ocaml_interface',
  'regex',
  'verilog',
] as const satisfies readonly Language[];

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages([...NEW_LANGUAGES]);
});

interface SymbolNamesArgs {
  source: string;
  filePath: string;
  language: Language;
  kind?: NodeKind;
}

function symbolNames(args: SymbolNamesArgs): string[] {
  const { source, filePath, language, kind } = args;
  const result = extractFromSource(filePath, source, language);
  expect(result.errors).toEqual([]);
  return result.nodes.filter((n) => n.kind !== 'file' && (!kind || n.kind === kind)).map((n) => n.name);
}

describe('upstream tree-sitter parser tranche', () => {
  it('detects the newly registered file extensions', () => {
    expect(detectLanguage('style.css')).toBe('css');
    expect(detectLanguage('view.erb')).toBe('embedded_template');
    expect(detectLanguage('view.ejs')).toBe('embedded_template');
    expect(detectLanguage('Main.hs')).toBe('haskell');
    expect(detectLanguage('index.html')).toBe('html');
    expect(detectLanguage('api.jsdoc')).toBe('jsdoc');
    expect(detectLanguage('package.json')).toBe('json');
    expect(detectLanguage('main.jl')).toBe('julia');
    expect(detectLanguage('lib.ml')).toBe('ocaml');
    expect(detectLanguage('lib.mli')).toBe('ocaml_interface');
    expect(detectLanguage('pattern.regex')).toBe('regex');
    expect(detectLanguage('top.sv')).toBe('verilog');
  });

  it('preserves Liquid front-matter detection for HTML files', () => {
    const source = '---\nlayout: default\n---\n<section>{{ title }}</section>\n';
    expect(detectLanguage('index.html', source)).toBe('liquid');
  });

  it('parses parser-only markup and data grammars without syntax errors', () => {
    const cases: Array<[Language, string, string]> = [
      ['css', 'style.css', '.button { color: red; }\n'],
      ['embedded_template', 'show.erb', '<%= user.name %>\n'],
      ['html', 'index.html', '<main><h1>Hello</h1></main>\n'],
      ['jsdoc', 'api.jsdoc', '/** Adds one. */\n'],
      ['json', 'package.json', '{ "name": "demo" }\n'],
      ['regex', 'pattern.regex', '^[a-z]+$\n'],
    ];

    for (const [language, filePath, source] of cases) {
      const result = extractFromSource(filePath, source, language);
      expect(result.errors, `${language} parse errors`).toEqual([]);
      expect(result.nodes.map((n) => n.kind)).toEqual(['file']);
    }
  });

  it('extracts baseline Haskell symbols through tags queries', () => {
    const names = symbolNames({
      source: 'module M where\nfoo x = x + 1\ndata User = User Int\nclass C a where\n  run :: a -> Int\n',
      filePath: 'Main.hs',
      language: 'haskell',
    });

    expect(names).toEqual(expect.arrayContaining(['M', 'foo', 'User', 'C', 'run']));
  });

  it('extracts baseline Julia symbols and call references through tags queries', () => {
    const result = extractFromSource(
      'main.jl',
      'module M\nstruct User\n  name::String\nend\nfunction greet(name)\n  show(name)\nend\nmacro m(x) x end\nend\n',
      'julia',
    );

    expect(result.errors).toEqual([]);
    expect(result.nodes.map((n) => n.name)).toEqual(expect.arrayContaining(['M', 'User', 'greet', 'm']));
    expect(result.unresolvedReferences.map((r) => r.referenceName)).toContain('show');
  });

  it('extracts OCaml implementation and interface symbols with distinct grammars', () => {
    expect(
      symbolNames({
        source: 'let f x = x + 1\ntype user = { name : string }\n',
        filePath: 'lib.ml',
        language: 'ocaml',
      }),
    ).toEqual(expect.arrayContaining(['f', 'user', 'name']));
    expect(
      symbolNames({
        source: 'val f : int -> int\ntype user\n',
        filePath: 'lib.mli',
        language: 'ocaml_interface',
      }),
    ).toEqual(expect.arrayContaining(['f', 'user']));
  });

  it('extracts baseline Verilog/SystemVerilog symbols through tags queries', () => {
    const names = symbolNames({
      source:
        'module top;\nfunction int add; endfunction\ntask run; endtask\nendmodule\npackage P; endpackage\ninterface I; endinterface\nclass C; endclass\n',
      filePath: 'top.sv',
      language: 'verilog',
    });

    expect(names).toEqual(expect.arrayContaining(['top', 'add', 'run', 'P', 'I', 'C']));
  });
});
