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
  await loadGrammarsForLanguages(['common_lisp']);
});

describe('Common Lisp extraction', () => {
  it('detects Common Lisp family files', () => {
    for (const ext of ['.lisp', '.lsp', '.l', '.cl', '.asd', '.ros']) {
      expect(detectLanguage(`core${ext}`)).toBe('common_lisp');
    }
    expect(isLanguageSupported('common_lisp')).toBe(true);
    expect(getSupportedLanguages()).toContain('common_lisp');
  });

  it('extracts package forms, constants, functions, macros, classes, and calls', () => {
    const source = `
(defpackage #:demo.core
  (:use #:cl)
  (:import-from #:demo.util #:helper))

(in-package #:demo.core)

(defparameter *default-name* "world")

(defun greet (name)
  (string-upcase (helper name)))

(defmacro with-log (expr)
  (list 'progn expr))

(defclass user ()
  ((name :initarg :name)))
`;

    const result = extractFromSource('src/demo/core.lisp', source, 'common_lisp');

    expect(result.errors).toEqual([]);

    const nodesByKind = new Map(result.nodes.map((node) => [`${node.kind}:${node.name}`, node]));
    expect(nodesByKind.get('namespace:demo.core')?.signature).toContain('(defpackage #:demo.core');
    expect(nodesByKind.get('import:cl')?.signature).toBe(':cl');
    expect(nodesByKind.get('import:demo.util')?.signature).toBe(':demo.util');
    expect(nodesByKind.get('constant:*default-name*')?.signature).toBe('*default-name*');
    expect(nodesByKind.get('function:greet')?.signature).toBe('(name)');
    expect(nodesByKind.get('function:with-log')?.signature).toBe('(expr)');
    expect(nodesByKind.get('class:user')?.signature).toBe('user');

    const refs = result.unresolvedReferences.map((ref) => `${ref.referenceKind}:${ref.referenceName}`);
    expect(refs).toEqual(
      expect.arrayContaining(['imports:cl', 'imports:demo.util', 'calls:string-upcase', 'calls:helper', 'calls:list']),
    );
    expect(refs).not.toContain('calls:defpackage');
    expect(refs).not.toContain('calls:defparameter');
  });
});
