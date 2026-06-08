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
  await loadGrammarsForLanguages(['clojure']);
});

describe('Clojure extraction', () => {
  it('detects Clojure family files', () => {
    for (const ext of ['.clj', '.cljs', '.cljc', '.edn', '.bb']) {
      expect(detectLanguage(`core${ext}`)).toBe('clojure');
    }
    expect(isLanguageSupported('clojure')).toBe(true);
    expect(getSupportedLanguages()).toContain('clojure');
  });

  it('extracts namespace imports, defs, functions, macros, and call references', () => {
    const source = `
(ns demo.core
  (:require [clojure.string :as str]
            [demo.util :refer [helper]]))

(defonce default-name "world")

(defn greet
  "Greets a user."
  [name]
  (str/upper-case (helper name)))

(defn- hidden [x] (+ x 1))

(defmacro with-log [expr]
  (list 'do expr))
`;

    const result = extractFromSource('src/demo/core.clj', source, 'clojure');

    expect(result.errors).toEqual([]);

    const nodesByKind = new Map(result.nodes.map((node) => [`${node.kind}:${node.name}`, node]));
    expect(nodesByKind.get('import:clojure.string')?.signature).toBe('[clojure.string :as str]');
    expect(nodesByKind.get('import:demo.util')?.signature).toBe('[demo.util :refer [helper]]');
    expect(nodesByKind.get('constant:default-name')?.signature).toBe('default-name');
    expect(nodesByKind.get('function:greet')?.signature).toBe('[name]');
    expect(nodesByKind.get('function:greet')?.visibility).toBe('public');
    expect(nodesByKind.get('function:hidden')?.visibility).toBe('private');
    expect(nodesByKind.get('function:with-log')?.signature).toBe('[expr]');

    const refs = result.unresolvedReferences.map((ref) => `${ref.referenceKind}:${ref.referenceName}`);
    expect(refs).toEqual(
      expect.arrayContaining([
        'imports:clojure.string',
        'imports:demo.util',
        'calls:str/upper-case',
        'calls:helper',
        'calls:+',
        'calls:list',
      ]),
    );
    expect(refs).not.toContain('calls:ns');
  });
});
