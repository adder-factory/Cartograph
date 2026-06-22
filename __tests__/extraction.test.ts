/**
 * Extraction Tests
 *
 * Tests for the tree-sitter extraction system.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { getAllFiles, getFileByPath } from '../src/db/queries-files.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Cartograph } from '../src/index.js';
import { extractFromSource, scanDirectory } from '../src/extraction/index.js';
import {
  detectLanguage,
  isLanguageSupported,
  getSupportedLanguages,
  initGrammars,
  loadAllGrammars,
} from '../src/extraction/grammars.js';
import { normalizePath } from '../src/utils.js';
import { DEFAULT_CONFIG } from '../src/types.js';

const byString = (a: string, b: string): number => a.localeCompare(b);

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

// Create a temporary directory for each test
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-test-'));
}

// Clean up temporary directory
function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function typeRefNamesFor(code: string, file = 'consumer.ts'): string[] {
  const result = extractFromSource(file, code);
  return result.unresolvedReferences.filter((r) => r.referenceKind === 'type_of').map((r) => r.referenceName);
}

function fieldAccessNamesFor(code: string, file = 'consumer.ts'): string[] {
  const result = extractFromSource(file, code);
  return result.unresolvedReferences.filter((r) => r.referenceKind === 'field_access').map((r) => r.referenceName);
}

function refsByKind(code: string, kind: string, file = 'fixture.ts'): Array<{ from: string; name: string }> {
  const result = extractFromSource(file, code);
  return result.unresolvedReferences
    .filter((r) => r.referenceKind === kind)
    .map((r) => {
      const owner = result.nodes.find((n) => n.id === r.fromNodeId);
      return { from: owner?.name ?? r.fromNodeId, name: r.referenceName };
    });
}

function nodeNamesByKind(result: ReturnType<typeof extractFromSource>, kind: 'variable' | 'constant'): string[] {
  return result.nodes.filter((n) => n.kind === kind).map((n) => n.name);
}

function findExtractedNodeByName(result: ReturnType<typeof extractFromSource>, name: string) {
  return result.nodes.find((n) => n.name === name);
}

function findExtractedFieldByName(result: ReturnType<typeof extractFromSource>, name: string) {
  return result.nodes.find((n) => n.kind === 'field' && n.name === name);
}

describe('Language Detection', () => {
  it('should detect TypeScript files', () => {
    expect(detectLanguage('src/index.ts')).toBe('typescript');
    expect(detectLanguage('components/Button.tsx')).toBe('tsx');
  });

  it('should detect JavaScript files', () => {
    expect(detectLanguage('index.js')).toBe('javascript');
    expect(detectLanguage('App.jsx')).toBe('jsx');
    expect(detectLanguage('config.mjs')).toBe('javascript');
    expect(detectLanguage('server/bootstrap.xsjs')).toBe('javascript');
    expect(detectLanguage('server/lib/session.xsjslib')).toBe('javascript');
  });

  it('should detect Python files', () => {
    expect(detectLanguage('main.py')).toBe('python');
  });

  it('should detect Go files', () => {
    expect(detectLanguage('main.go')).toBe('go');
  });

  it('should detect Rust files', () => {
    expect(detectLanguage('lib.rs')).toBe('rust');
  });

  it('should detect Java files', () => {
    expect(detectLanguage('Main.java')).toBe('java');
  });

  it('should detect C files', () => {
    expect(detectLanguage('main.c')).toBe('c');
    expect(detectLanguage('utils.h')).toBe('c');
  });

  it('should detect C++ files', () => {
    expect(detectLanguage('main.cpp')).toBe('cpp');
    expect(detectLanguage('class.hpp')).toBe('cpp');
  });

  it('should detect C# files', () => {
    expect(detectLanguage('Program.cs')).toBe('csharp');
  });

  it('should detect PHP files', () => {
    expect(detectLanguage('index.php')).toBe('php');
  });

  it('should detect Ruby files', () => {
    expect(detectLanguage('app.rb')).toBe('ruby');
  });

  it('should detect Swift files', () => {
    expect(detectLanguage('ViewController.swift')).toBe('swift');
  });

  it('should detect Kotlin files', () => {
    expect(detectLanguage('MainActivity.kt')).toBe('kotlin');
    expect(detectLanguage('build.gradle.kts')).toBe('kotlin');
  });

  it('should detect Dart files', () => {
    expect(detectLanguage('main.dart')).toBe('dart');
  });

  it('should detect Jupyter notebooks', () => {
    expect(detectLanguage('analysis.ipynb')).toBe('jupyter');
  });

  it('should return unknown for unsupported extensions', () => {
    expect(detectLanguage('styles.unsupported')).toBe('unknown');
    expect(detectLanguage('data.nope')).toBe('unknown');
  });
});

describe('Language Support', () => {
  it('should report supported languages', () => {
    expect(isLanguageSupported('typescript')).toBe(true);
    expect(isLanguageSupported('python')).toBe(true);
    expect(isLanguageSupported('go')).toBe(true);
    expect(isLanguageSupported('unknown')).toBe(false);
  });

  it('should list all supported languages', () => {
    const languages = getSupportedLanguages();
    expect(languages).toContain('typescript');
    expect(languages).toContain('javascript');
    expect(languages).toContain('python');
    expect(languages).toContain('go');
    expect(languages).toContain('rust');
    expect(languages).toContain('java');
    expect(languages).toContain('csharp');
    expect(languages).toContain('php');
    expect(languages).toContain('ruby');
    expect(languages).toContain('swift');
    expect(languages).toContain('kotlin');
    expect(languages).toContain('dart');
    expect(languages).toContain('jupyter');
  });
});

describe('TypeScript Extraction', () => {
  it('should extract function declarations', () => {
    const code = `
export function processPayment(amount: number): Promise<Receipt> {
  return stripe.charge(amount);
}
`;
    const result = extractFromSource('payment.ts', code);

    // File node + function node
    const fileNode = result.nodes.find((n) => n.kind === 'file');
    expect(fileNode).toBeDefined();
    expect(fileNode?.name).toBe('payment.ts');

    const funcNode = result.nodes.find((n) => n.kind === 'function');
    expect(funcNode).toMatchObject({
      kind: 'function',
      name: 'processPayment',
      language: 'typescript',
      isExported: true,
    });
    expect(funcNode?.signature).toContain('amount: number');
  });

  it('attaches preceding JSDoc to `export function` declarations', () => {
    // Regression: tree-sitter's previousNamedSibling on the inner
    // function_declaration is null because it's the only named child of
    // export_statement, so the JSDoc (sibling of the export_statement)
    // was being missed entirely. Of 19 functions in src/utils.ts at
    // diagnosis time, only the 2 non-exported ones had docstrings.
    const code = `
/**
 * Charge the customer card and return a receipt.
 * Wraps the upstream Stripe SDK error into our domain type.
 */
export function processPayment(amount: number): Promise<Receipt> {
  return stripe.charge(amount);
}

/** Bare export-const docstring. */
export const HARD_CAP = 100;

/**
 * Internal stash; not exported.
 */
function helper(x: number): number { return x + 1; }
`;
    const result = extractFromSource('payment.ts', code);
    const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'processPayment');
    expect(fn?.docstring).toContain('Charge the customer card');
    const helper = result.nodes.find((n) => n.kind === 'function' && n.name === 'helper');
    expect(helper?.docstring).toContain('Internal stash');
    const cap = result.nodes.find((n) => n.name === 'HARD_CAP');
    expect(cap?.docstring).toContain('Bare export-const');
  });

  it('does not treat a decorative `//` section banner as a docstring', () => {
    // Regression (friction sweep 2026-05-16): a `// ──── Handler ────`
    // file-section divider above a function was captured verbatim as
    // its docstring, feeding `------\nHandler\n------` to the role
    // classifier (→ misclassified). Pure rule lines must be stripped;
    // a banner with no prose leaves no docstring at all.
    const code = `
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
function bannerOnly(x: number): number { return x; }

// ===========================================================================
// Charge the customer card.
// ===========================================================================
function withProse(amount: number): Promise<unknown> { return Promise.resolve(amount); }
`;
    const result = extractFromSource('banners.ts', code);
    const bare = result.nodes.find((n) => n.kind === 'function' && n.name === 'bannerOnly');
    expect(bare?.docstring).toBeUndefined();
    const prose = result.nodes.find((n) => n.kind === 'function' && n.name === 'withProse');
    expect(prose?.docstring).toBe('Charge the customer card.');
  });

  it('attaches preceding JSDoc to `export class` and `export interface`', () => {
    const code = `
/** A service that talks to Stripe. */
export class PaymentService {
  charge(amount: number): Promise<unknown> { return Promise.resolve(amount); }
}

/** A user record. */
export interface User { id: string }
`;
    const result = extractFromSource('domain.ts', code);
    const cls = result.nodes.find((n) => n.kind === 'class' && n.name === 'PaymentService');
    expect(cls?.docstring).toContain('talks to Stripe');
    const iface = result.nodes.find((n) => n.kind === 'interface' && n.name === 'User');
    expect(iface?.docstring).toContain('A user record');
  });

  it('should extract class declarations', () => {
    const code = `
export class PaymentService {
  private stripe: StripeClient;

  constructor(apiKey: string) {
    this.stripe = new StripeClient(apiKey);
  }

  async charge(amount: number): Promise<Receipt> {
    return this.stripe.charge(amount);
  }
}
`;
    const result = extractFromSource('service.ts', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    const methodNodes = result.nodes.filter((n) => n.kind === 'method');

    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('PaymentService');
    expect(classNode?.isExported).toBe(true);

    expect(methodNodes.length).toBeGreaterThanOrEqual(1);
    const chargeMethod = methodNodes.find((m) => m.name === 'charge');
    expect(chargeMethod).toBeDefined();
  });

  it('attributes calls inside wrapped class-field function bodies to the method node', () => {
    const code = `
function memo(fn: () => void) { return fn; }
function track(): void {}

export class Widget {
  handler = memo(() => {
    track();
  });
}
`;
    const result = extractFromSource('widget.ts', code);
    const method = result.nodes.find((n) => n.kind === 'method' && n.name === 'handler');
    expect(method).toBeDefined();
    const trackRef = result.unresolvedReferences.find(
      (ref) => ref.fromNodeId === method?.id && ref.referenceName === 'track' && ref.referenceKind === 'calls',
    );
    expect(trackRef).toBeDefined();
  });

  it('classifies PascalCase function declarations returning JSX as components', () => {
    const code = `
function formatTitle(): string { return 'Cartograph'; }

export function ProfileCard() {
  return <section>{formatTitle()}</section>;
}
`;
    const result = extractFromSource('ProfileCard.tsx', code);
    const component = result.nodes.find((n) => n.kind === 'component' && n.name === 'ProfileCard');
    expect(component).toBeDefined();
    // Issue #9 — components must carry the same metadata as the plain
    // function path, not land with isExported=false / no signature.
    expect(component?.isExported).toBe(true);
    expect(component?.signature).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'function' && n.name === 'ProfileCard')).toBeUndefined();
    const formatRef = result.unresolvedReferences.find(
      (ref) => ref.fromNodeId === component?.id && ref.referenceName === 'formatTitle' && ref.referenceKind === 'calls',
    );
    expect(formatRef).toBeDefined();
  });

  it('populates isExported/docstring/signature for `export default function` components (issue #9)', () => {
    const code = `
/** Page-level header shown on every route. */
export default function Header(): JSX.Element {
  return <header>Cartograph</header>;
}
`;
    const result = extractFromSource('Header.tsx', code);
    const component = result.nodes.find((n) => n.kind === 'component' && n.name === 'Header');
    expect(component).toBeDefined();
    expect(component?.isExported).toBe(true);
    expect(component?.docstring).toContain('Page-level header');
    expect(component?.signature).toBeDefined();
  });

  it('flags `export default` declarations with isDefaultExport, keeping their local name (issue #50)', () => {
    // TS: a default component (kind=component) and a default non-component
    // function both keep their local name and are marked isDefaultExport;
    // named exports are not. This is the signal the unused_export
    // framework-convention filter keys on for React Router default exports.
    const ts = `
export async function loader() { return null; }
export default function Dashboard() { return <main/>; }
function localOnly() { return 1; }
`;
    const tsResult = extractFromSource('app/routes/dashboard.tsx', ts);
    const byName = (n: string) => tsResult.nodes.find((x) => x.name === n);
    expect(byName('Dashboard')?.isDefaultExport).toBe(true);
    expect(byName('loader')?.isDefaultExport).toBeFalsy();
    expect(byName('localOnly')?.isDefaultExport).toBeFalsy();

    // A default export whose declaration is a plain (non-component) function
    // keeps its arbitrary local name — the only marker that it is the
    // default export is the flag.
    const entry = `
export const streamTimeout = 5000;
export default function serverEntry() { return new Response('x'); }
`;
    const entryResult = extractFromSource('app/entry.server.tsx', entry);
    expect(entryResult.nodes.find((n) => n.name === 'serverEntry')?.isDefaultExport).toBe(true);
    expect(entryResult.nodes.find((n) => n.name === 'streamTimeout')?.isDefaultExport).toBeFalsy();

    // JS extractor populates the flag too (route modules may be .jsx/.js).
    const js = `
export default function Page() { return null; }
export function Sidebar() { return null; }
`;
    const jsResult = extractFromSource('app/routes/page.jsx', js);
    expect(jsResult.nodes.find((n) => n.name === 'Page')?.isDefaultExport).toBe(true);
    expect(jsResult.nodes.find((n) => n.name === 'Sidebar')?.isDefaultExport).toBeFalsy();
  });

  it('captures Rust #[…] attributes as decorators (issue #11)', () => {
    const code = [
      '#[test]',
      'fn test_foo() {}',
      '',
      '#[tauri::command]',
      'fn browser_create() {}',
      '',
      '#[allow(dead_code)]',
      'fn helper() {}',
    ].join('\n');
    const result = extractFromSource('src/lib.rs', code, 'rust');
    const byName = (n: string) => result.nodes.find((x) => x.name === n);
    expect(byName('test_foo')?.decorators).toContain('test');
    // Scoped attribute `tauri::command` collapses to its last segment.
    expect(byName('browser_create')?.decorators).toContain('command');
    expect(byName('helper')?.decorators).toContain('allow');
  });

  it('should extract interfaces', () => {
    const code = `
export interface User {
  id: string;
  name: string;
  email: string;
}
`;
    const result = extractFromSource('types.ts', code);

    const fileNode = result.nodes.find((n) => n.kind === 'file');
    expect(fileNode).toBeDefined();

    const ifaceNode = result.nodes.find((n) => n.kind === 'interface');
    expect(ifaceNode).toMatchObject({
      kind: 'interface',
      name: 'User',
      isExported: true,
    });
  });

  it('should track function calls', () => {
    const code = `
function main() {
  const result = processData();
  console.log(result);
}
`;
    const result = extractFromSource('main.ts', code);

    expect(result.unresolvedReferences.length).toBeGreaterThan(0);
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
    expect(calls.some((c) => c.referenceName === 'processData')).toBe(true);
  });

  // F#45 (2026-05-26): TS `interface Dog extends Animal` parses as
  // `interface_declaration > extends_type_clause > type_identifier`.
  // Pre-fix, the dispatcher had no handler for `extends_type_clause`
  // so every interface-extends-interface relationship was silently
  // dropped (vue-core: 292 interfaces, 4 extends edges; 131
  // patterns in source).
  it('emits extends edges for `interface Dog extends Animal` (F#45)', () => {
    const code = `
interface Animal { name: string; }
interface Dog extends Animal { breed: string; }
`;
    const result = extractFromSource('animals.ts', code);
    const extendsRefs = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'extends')
      .map((r) => r.referenceName);
    expect(extendsRefs).toContain('Animal');
  });

  it('emits one extends edge per parent for multi-extends interfaces (F#45)', () => {
    // `extends_type_clause` holds the parents as DIRECT named children
    // (no `type_list` wrapper, unlike Java's `extends_interfaces`).
    // The dedicated handler walks every named child to catch all of
    // them; the generic handler's `[namedChild(0)]` fallback would
    // truncate to only `Animal`.
    const code = `
interface Animal { name: string; }
interface Mammal { warmBlooded: boolean; }
interface Cat extends Animal, Mammal { meow: () => void; }
`;
    const result = extractFromSource('animals.ts', code);
    const extendsRefs = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'extends')
      .map((r) => r.referenceName);
    expect(extendsRefs).toContain('Animal');
    expect(extendsRefs).toContain('Mammal');
  });

  // F#47 (2026-05-26) — Vue SFC support. Extraction strips template/style
  // blocks and routes `<script>` content through TS or JS tree-sitter
  // depending on `lang="ts"`. A `component` node is created per .vue
  // file; template `{{ … }}` expressions emit `calls` refs; PascalCase
  // template tags emit `references` refs.
  it('Vue: creates a component node per .vue file (F#47)', () => {
    const result = extractFromSource(
      'App.vue',
      `<script setup lang="ts">
import { ref } from 'vue'
const count = ref(0)
</script>

<template>
  <button>{{ count }}</button>
</template>
`,
    );
    const component = result.nodes.find((n) => n.kind === 'component');
    expect(component).toBeDefined();
    expect(component?.name).toBe('App');
    expect(component?.language).toBe('vue');
    expect(component?.isExported).toBe(true);
  });

  it('Vue: extracts script-block symbols with correct line offsets (F#47)', () => {
    const result = extractFromSource(
      'Counter.vue',
      `<template>
  <button>+</button>
</template>

<script setup lang="ts">
function increment(n: number): number {
  return n + 1
}
</script>
`,
    );
    const fn = result.nodes.find((n) => n.name === 'increment');
    expect(fn).toBeDefined();
    expect(fn?.language).toBe('vue');
    // Script block opens at line 5 (1-indexed); function declaration on line 6.
    expect(fn?.startLine).toBeGreaterThanOrEqual(5);
  });

  it('Vue: routes lang="ts" to typescript and bare script to javascript (F#47)', () => {
    const tsResult = extractFromSource(
      'TS.vue',
      `<script setup lang="ts">
interface Result { ok: boolean }
function f(x: Result): Result { return x }
</script>
`,
    );
    const jsResult = extractFromSource(
      'JS.vue',
      `<script>
function f(x) { return x }
</script>
`,
    );
    // TS variant produces a type_of ref (typed param) — JS variant does not.
    // (Returns refs are filtered against BUILTIN_TYPES, so non-builtin
    // user types like `Result` here go through.)
    const tsTypeOf = tsResult.unresolvedReferences.filter((r) => r.referenceKind === 'type_of');
    const jsTypeOf = jsResult.unresolvedReferences.filter((r) => r.referenceKind === 'type_of');
    expect(tsTypeOf.length).toBeGreaterThan(0);
    expect(jsTypeOf.length).toBe(0);
  });

  it('Vue: emits calls refs for `{{ fn() }}` mustache expressions (F#47)', () => {
    const result = extractFromSource(
      'Mustache.vue',
      `<template>
  <span>{{ format(date) }}</span>
</template>

<script setup>
const date = new Date()
function format(d) { return d.toString() }
</script>
`,
    );
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName);
    expect(calls).toContain('format');
  });

  it('Vue: emits references refs for PascalCase template tags (F#47)', () => {
    const result = extractFromSource(
      'Parent.vue',
      `<template>
  <div>
    <UserCard :user="u" />
    <Modal v-if="open" />
  </div>
</template>

<script setup>
import UserCard from './UserCard.vue'
import Modal from './Modal.vue'
const u = {}
const open = true
</script>
`,
    );
    const refs = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'references')
      .map((r) => r.referenceName);
    expect(refs).toContain('UserCard');
    expect(refs).toContain('Modal');
  });

  it('Vue: filters out compiler macros from the calls stream (F#47)', () => {
    // defineProps/defineEmits/withDefaults are Vue 3 compiler macros,
    // not real function calls. They should never surface as unresolved
    // refs (they have no resolvable target).
    const result = extractFromSource(
      'Macros.vue',
      `<script setup lang="ts">
const props = defineProps<{ msg: string }>()
const emit = defineEmits(['change'])
const x = withDefaults(defineProps<{ n?: number }>(), { n: 0 })
</script>
`,
    );
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName);
    expect(calls).not.toContain('defineProps');
    expect(calls).not.toContain('defineEmits');
    expect(calls).not.toContain('withDefaults');
  });

  it('Vue: template-only file (no <script>) still emits a component node (F#47)', () => {
    // Vue icon components are often pure-template (just an SVG inside
    // <template>). They should still produce a component node so
    // imports of them resolve in the graph.
    const result = extractFromSource(
      'IconClose.vue',
      `<template>
  <svg viewBox="0 0 24 24"><path d="M0 0L24 24"/></svg>
</template>
`,
    );
    const component = result.nodes.find((n) => n.kind === 'component');
    expect(component).toBeDefined();
    expect(component?.name).toBe('IconClose');
  });

  it('Vue: ignores template expressions inside script and style blocks', () => {
    const result = extractFromSource(
      'Styled.vue',
      `<script setup>
const literal = '{{ shouldNotCount() }}'
</script>

<template>
  <span>{{ visibleCall(user.name) }}</span>
</template>

<style>
.icon::after { content: "{{ alsoIgnored() }}"; }
</style>
`,
    );
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName);
    expect(calls).toContain('visibleCall');
    expect(calls).not.toContain('shouldNotCount');
    expect(calls).not.toContain('alsoIgnored');
  });

  it('Vue: skips empty and directive-like mustache expressions', () => {
    const result = extractFromSource(
      'DirectiveLike.vue',
      `<template>
  <span>{{ }}</span>
  <span>{{ #internalCall() }}</span>
  <span>{{ /closingCall() }}</span>
  <span>{{ realCall() }}</span>
</template>
`,
    );
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName);
    expect(calls).toContain('realCall');
    expect(calls).not.toContain('internalCall');
    expect(calls).not.toContain('closingCall');
  });

  it('Vue: offsets script refs, edges, and errors back to component source lines', () => {
    const result = extractFromSource(
      'Offset.vue',
      `<template>
  <Widget />
</template>

<script setup lang="ts">
import { helper } from './helper'
interface User { name: string }
function render(user: User): string {
  return helper(user.name)
}
</script>
`,
    );
    const render = result.nodes.find((n) => n.name === 'render');
    expect(render?.startLine).toBeGreaterThanOrEqual(8);
    expect(result.edges.some((edge) => edge.kind === 'contains' && edge.target === render?.id)).toBe(true);
    const helperCall = result.unresolvedReferences.find(
      (r) => r.referenceName === 'helper' && r.referenceKind === 'calls',
    );
    expect(helperCall?.line).toBeGreaterThanOrEqual(9);
    const userType = result.unresolvedReferences.find(
      (r) => r.referenceName === 'User' && r.referenceKind === 'type_of',
    );
    expect(userType?.language).toBe('vue');
    expect(userType?.filePath).toBe('Offset.vue');
  });

  it('Svelte: extracts script symbols, template calls, and component tags', () => {
    const result = extractFromSource(
      'Panel.svelte',
      `<script lang="ts">
  import Child from './Child.svelte';
  export let user: User;
  function formatName(name: string): string {
    return name.toUpperCase();
  }
</script>

<section>
  <Child />
  <p>{formatName(user.name)}</p>
</section>
`,
    );
    expect(result.nodes.find((n) => n.kind === 'component')?.name).toBe('Panel');
    expect(result.nodes.find((n) => n.name === 'formatName')?.language).toBe('svelte');
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName);
    const refs = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'references')
      .map((r) => r.referenceName);
    expect(calls).toContain('formatName');
    expect(refs).toContain('Child');
  });

  it('Svelte: filters runes and block syntax from template call references', () => {
    const result = extractFromSource(
      'Runes.svelte',
      `<script>
  const count = $state(0);
</script>

{#if count > 0}
  <button>{buttonLabel(count)}</button>
{/if}
`,
    );
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName);
    expect(calls).toContain('buttonLabel');
    expect(calls).not.toContain('$state');
    expect(calls).not.toContain('if');
  });

  it('emits the head identifier on a generic extends `interface X extends Map<K, V>` (F#45)', () => {
    // Generic shapes wrap the head in `generic_type` — the handler
    // walks INTO `generic_type` to find the inner `type_identifier`.
    // The resolver matches by bare name so the generic-arg list is
    // intentionally dropped from the ref.
    const code = `
interface Foo<K, V> extends Map<K, V> { extra: number; }
`;
    const result = extractFromSource('generic.ts', code);
    const extendsRefs = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'extends')
      .map((r) => r.referenceName);
    expect(extendsRefs).toContain('Map');
  });

  it('normalizes generic class supertypes before unresolved inheritance refs are stored', () => {
    const result = extractFromSource(
      'repo.ts',
      `
class BaseRepo<T> {}
interface Disposable<T> {}
class UserRepo extends BaseRepo<User> implements Disposable<User> {}
`,
    );
    const inheritanceRefs = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'extends' || r.referenceKind === 'implements')
      .map((r) => r.referenceName);
    expect(inheritanceRefs).toContain('BaseRepo');
    expect(inheritanceRefs).toContain('Disposable');
    expect(inheritanceRefs).not.toContain('BaseRepo<User>');
    expect(inheritanceRefs).not.toContain('Disposable<User>');
  });

  it('normalizes JVM generic supertypes in shared extends/implements handlers', () => {
    const result = extractFromSource(
      'UserRepo.java',
      `
class BaseRepo<T> {}
interface Handler<T> {}
class UserRepo extends BaseRepo<User> implements Handler<User> {}
`,
    );
    const inheritanceRefs = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'extends' || r.referenceKind === 'implements')
      .map((r) => r.referenceName);
    expect(inheritanceRefs).toContain('BaseRepo');
    expect(inheritanceRefs).toContain('Handler');
    expect(inheritanceRefs).not.toContain('BaseRepo<User>');
    expect(inheritanceRefs).not.toContain('Handler<User>');
  });
});

describe('Arrow Function Export Extraction', () => {
  it('should extract exported arrow functions assigned to const', () => {
    const code = `
export const useAuth = (): AuthContextValue => {
  return useContext(AuthContext);
};
`;
    const result = extractFromSource('hooks.ts', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'useAuth');
    expect(funcNode).toBeDefined();
    expect(funcNode).toMatchObject({
      kind: 'function',
      name: 'useAuth',
      isExported: true,
    });
  });

  it('should extract exported function expressions assigned to const', () => {
    const code = `
export const processData = function(input: string): string {
  return input.trim();
};
`;
    const result = extractFromSource('utils.ts', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'processData');
    expect(funcNode).toBeDefined();
    expect(funcNode).toMatchObject({
      kind: 'function',
      name: 'processData',
      isExported: true,
    });
  });

  it('should not extract non-exported arrow functions as exported', () => {
    const code = `
const internalHelper = () => {
  return 42;
};
`;
    const result = extractFromSource('internal.ts', code);

    const helperNode = result.nodes.find((n) => n.name === 'internalHelper');
    expect(helperNode).toBeDefined();
    expect(helperNode?.isExported).toBeFalsy();
  });

  it('should still skip truly anonymous arrow functions', () => {
    const code = `
const items = [1, 2, 3].map((x) => x * 2);
`;
    const result = extractFromSource('anon.ts', code);

    // The inline arrow function passed to .map() has no variable_declarator parent
    // and should remain anonymous (skipped)
    const anonFunctions = result.nodes.filter((n) => n.kind === 'function' && n.name === '<anonymous>');
    expect(anonFunctions).toHaveLength(0);
  });

  it('should extract multiple exported arrow functions from the same file', () => {
    const code = `
export const add = (a: number, b: number): number => a + b;

export const subtract = (a: number, b: number): number => a - b;

const internal = () => 'not exported';
`;
    const result = extractFromSource('math.ts', code);

    const exported = result.nodes.filter((n) => n.kind === 'function' && n.isExported);
    expect(exported).toHaveLength(2);
    expect(exported.map((n) => n.name).sort(byString)).toEqual(['add', 'subtract']);

    const internalNode = result.nodes.find((n) => n.name === 'internal');
    expect(internalNode).toBeDefined();
    expect(internalNode?.isExported).toBeFalsy();
  });

  it('should extract arrow functions in JavaScript files', () => {
    const code = `
export const fetchData = async () => {
  const response = await fetch('/api/data');
  return response.json();
};
`;
    const result = extractFromSource('api.js', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function' && n.name === 'fetchData');
    expect(funcNode).toBeDefined();
    expect(funcNode).toMatchObject({
      kind: 'function',
      name: 'fetchData',
      isExported: true,
    });
  });

  // #61 Gap 1 regression: calls inside arrow functions buried in an
  // array/object initializer of a top-level const must be attributed
  // to the enclosing constant. Without the value-subtree walk in
  // extractTsJsVariables, these calls are silently dropped — they don't
  // even land in unresolvedReferences.
  it('attributes calls inside arrow values of array-of-objects to the enclosing const', () => {
    const code = `
export const RULES = [
  { kind: 'unused_export', produce: (queries) => findUnusedExports(queries) },
  { kind: 'god_class', produce: (queries) => findGodClasses(queries) },
];
`;
    const result = extractFromSource('rules.ts', code);

    const constNode = result.nodes.find((n) => n.name === 'RULES');
    expect(constNode).toBeDefined();

    const callsFromConst = result.unresolvedReferences.filter(
      (r) => r.fromNodeId === constNode!.id && r.referenceKind === 'calls',
    );
    const calleeNames = callsFromConst.map((r) => r.referenceName).sort(byString);
    expect(calleeNames).toEqual(['findGodClasses', 'findUnusedExports']);
  });

  it('attributes calls inside arrow values of object literals to the enclosing const', () => {
    const code = `
export const handlers = {
  onSave: () => persistData(),
  onLoad: () => fetchData(),
};
`;
    const result = extractFromSource('handlers.ts', code);

    const constNode = result.nodes.find((n) => n.name === 'handlers');
    expect(constNode).toBeDefined();

    const calleeNames = result.unresolvedReferences
      .filter((r) => r.fromNodeId === constNode!.id && r.referenceKind === 'calls')
      .map((r) => r.referenceName)
      .sort(byString);
    expect(calleeNames).toEqual(['fetchData', 'persistData']);
  });

  it('attributes a bare call_expression initializer as a `calls` edge from the const', () => {
    const code = `
export const transformer = buildTransformer(config);
`;
    const result = extractFromSource('factory.ts', code);

    const constNode = result.nodes.find((n) => n.name === 'transformer');
    expect(constNode).toBeDefined();

    const calleeNames = result.unresolvedReferences
      .filter((r) => r.fromNodeId === constNode!.id && r.referenceKind === 'calls')
      .map((r) => r.referenceName);
    expect(calleeNames).toContain('buildTransformer');
  });
});

describe('F#12 slice 1 — eager nested-function extraction', () => {
  // Each test sets the env var explicitly + restores afterwards so a
  // mid-suite leak can't poison sibling tests. Defaults match production
  // shape: env unset → threshold 500 → eager mode for small fixtures.
  const SAVED = process.env['CARTOGRAPH_LARGE_FUNCTION_THRESHOLD'];
  afterEach(() => {
    if (SAVED === undefined) {
      delete process.env['CARTOGRAPH_LARGE_FUNCTION_THRESHOLD'];
    } else {
      process.env['CARTOGRAPH_LARGE_FUNCTION_THRESHOLD'] = SAVED;
    }
  });

  it('extracts a nested function_declaration inside a function body', () => {
    const code = `
export function outer() {
  function helper(x) {
    return x + 1;
  }
  return helper(41);
}
`;
    const result = extractFromSource('nested-decl.ts', code);
    const outer = result.nodes.find((n) => n.kind === 'function' && n.name === 'outer');
    const helper = result.nodes.find((n) => n.kind === 'function' && n.name === 'helper');
    expect(outer).toBeDefined();
    expect(helper).toBeDefined();
    // contains edge from outer → helper
    const containsEdge = result.edges.find(
      (e) => e.kind === 'contains' && e.source === outer!.id && e.target === helper!.id,
    );
    expect(containsEdge).toBeDefined();
  });

  it('extracts arrow-bound nested fns (const foo = () => {})', () => {
    const code = `
export function outer() {
  const helper = (x) => x + 1;
  return helper(41);
}
`;
    const result = extractFromSource('nested-arrow.ts', code);
    const outer = result.nodes.find((n) => n.kind === 'function' && n.name === 'outer');
    const helper = result.nodes.find((n) => n.kind === 'function' && n.name === 'helper');
    expect(outer).toBeDefined();
    expect(helper).toBeDefined();
    const containsEdge = result.edges.find(
      (e) => e.kind === 'contains' && e.source === outer!.id && e.target === helper!.id,
    );
    expect(containsEdge).toBeDefined();
  });

  it('extracts function_expression-bound nested fns (const foo = function() {})', () => {
    const code = `
export function outer() {
  const helper = function(x) { return x + 1; };
  return helper(41);
}
`;
    const result = extractFromSource('nested-fexpr.ts', code);
    const helper = result.nodes.find((n) => n.kind === 'function' && n.name === 'helper');
    expect(helper).toBeDefined();
  });

  it('recurses transitively (nested fn inside a nested fn)', () => {
    const code = `
export function outer() {
  function mid() {
    function inner(x) { return x + 1; }
    return inner(41);
  }
  return mid();
}
`;
    const result = extractFromSource('nested-deep.ts', code);
    const mid = result.nodes.find((n) => n.kind === 'function' && n.name === 'mid');
    const inner = result.nodes.find((n) => n.kind === 'function' && n.name === 'inner');
    expect(mid).toBeDefined();
    expect(inner).toBeDefined();
    const containsEdge = result.edges.find(
      (e) => e.kind === 'contains' && e.source === mid!.id && e.target === inner!.id,
    );
    expect(containsEdge).toBeDefined();
  });

  it('does NOT extract inline anonymous callbacks (passed to .map / setTimeout / .then)', () => {
    const code = `
export function outer() {
  return [1, 2, 3].map((x) => x * 2);
}
`;
    const result = extractFromSource('callback.ts', code);
    const anon = result.nodes.filter((n) => n.kind === 'function' && n.name === '<anonymous>');
    expect(anon).toHaveLength(0);
    // The inline arrow is intentionally not a binding-name, so it
    // shouldn't appear as a named function either.
    const fns = result.nodes.filter((n) => n.kind === 'function');
    expect(fns.map((f) => f.name).sort(byString)).toEqual(['outer']);
  });

  it('SKIPS eager extraction when a function body crosses the threshold', () => {
    // Make the threshold artificially tiny so a short fixture trips
    // the "mega file" path. The outer function body is 10 lines, well
    // above 3.
    process.env['CARTOGRAPH_LARGE_FUNCTION_THRESHOLD'] = '3';
    const code = `
export function megaFn() {
  function helper() {
    return 1;
  }
  helper();
  helper();
  helper();
  helper();
  helper();
  return helper();
}
`;
    const result = extractFromSource('mega.ts', code);
    // The outer fn extracts as usual; the nested helper does NOT because
    // the file is in manifest-mode territory (slice 2). The body walker
    // still attributes the `helper()` calls to the outer fn via
    // unresolvedReferences, so slice 1 doesn't regress call attribution.
    expect(result.nodes.find((n) => n.kind === 'function' && n.name === 'megaFn')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'function' && n.name === 'helper')).toBeUndefined();
  });

  it('Infinity threshold forces eager extraction even on huge bodies', () => {
    process.env['CARTOGRAPH_LARGE_FUNCTION_THRESHOLD'] = 'Infinity';
    const padding = Array.from({ length: 600 }, (_, i) => `  const v${i} = ${i};`).join('\n');
    const code = `
export function huge() {
${padding}
  function helper() { return 1; }
  return helper();
}
`;
    const result = extractFromSource('huge.ts', code);
    expect(result.nodes.find((n) => n.kind === 'function' && n.name === 'helper')).toBeDefined();
  });

  it('threshold = 0 disables eager extraction entirely', () => {
    process.env['CARTOGRAPH_LARGE_FUNCTION_THRESHOLD'] = '0';
    const code = `
export function outer() {
  function helper() { return 1; }
  return helper();
}
`;
    const result = extractFromSource('opt-out.ts', code);
    expect(result.nodes.find((n) => n.kind === 'function' && n.name === 'outer')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'function' && n.name === 'helper')).toBeUndefined();
  });

  it('also fires inside arrow functions assigned at the top level', () => {
    const code = `
export const outer = () => {
  function helper() { return 1; }
  return helper();
};
`;
    const result = extractFromSource('arrow-outer.ts', code);
    const outer = result.nodes.find((n) => n.kind === 'function' && n.name === 'outer');
    const helper = result.nodes.find((n) => n.kind === 'function' && n.name === 'helper');
    expect(outer).toBeDefined();
    expect(helper).toBeDefined();
    const containsEdge = result.edges.find(
      (e) => e.kind === 'contains' && e.source === outer!.id && e.target === helper!.id,
    );
    expect(containsEdge).toBeDefined();
  });

  it('extracts nested fns inside methods', () => {
    const code = `
export class Worker {
  run() {
    function helper(x) { return x + 1; }
    return helper(41);
  }
}
`;
    const result = extractFromSource('method-nested.ts', code);
    const run = result.nodes.find((n) => n.kind === 'method' && n.name === 'run');
    const helper = result.nodes.find((n) => n.kind === 'function' && n.name === 'helper');
    expect(run).toBeDefined();
    expect(helper).toBeDefined();
    const containsEdge = result.edges.find(
      (e) => e.kind === 'contains' && e.source === run!.id && e.target === helper!.id,
    );
    expect(containsEdge).toBeDefined();
  });
});

describe('F#12 slice 2 — manifest extraction (mega-file mode)', () => {
  const SAVED = process.env['CARTOGRAPH_LARGE_FUNCTION_THRESHOLD'];
  afterEach(() => {
    if (SAVED === undefined) {
      delete process.env['CARTOGRAPH_LARGE_FUNCTION_THRESHOLD'];
    } else {
      process.env['CARTOGRAPH_LARGE_FUNCTION_THRESHOLD'] = SAVED;
    }
  });

  it('mines a manifest row for each nested function declaration', () => {
    process.env['CARTOGRAPH_LARGE_FUNCTION_THRESHOLD'] = '3';
    const code = `
export function megaFn() {
  function getTypeOfSymbol(s) {
    return s.type;
  }
  function checkSourceFile(f) {
    return f.path;
  }
  return getTypeOfSymbol(checkSourceFile({}));
}
`;
    const result = extractFromSource('mega.ts', code);
    const manifest = result.nestedFunctionManifest ?? [];
    const names = manifest.map((r) => r.name).sort(byString);
    expect(names).toEqual(['checkSourceFile', 'getTypeOfSymbol']);
    const outer = result.nodes.find((n) => n.kind === 'function' && n.name === 'megaFn')!;
    for (const row of manifest) {
      expect(row.parentNodeId).toBe(outer.id);
      expect(row.filePath).toBe('mega.ts');
      expect(row.bodyHash).toMatch(/^[0-9a-f]{32}$/);
      expect(row.startLine).toBeGreaterThan(0);
      expect(row.endLine).toBeGreaterThanOrEqual(row.startLine);
    }
  });

  it('mines manifest rows for arrow-bound nested fns', () => {
    process.env['CARTOGRAPH_LARGE_FUNCTION_THRESHOLD'] = '3';
    const code = `
export function megaFn() {
  const helper = (x) => {
    return x + 1;
  };
  const tighter = function(y) {
    return y * 2;
  };
  return helper(tighter(1));
}
`;
    const result = extractFromSource('mega-arrow.ts', code);
    const names = (result.nestedFunctionManifest ?? []).map((r) => r.name).sort(byString);
    expect(names).toEqual(['helper', 'tighter']);
  });

  it('mines nested-nested rows with the closest real-node ancestor as parent', () => {
    process.env['CARTOGRAPH_LARGE_FUNCTION_THRESHOLD'] = '3';
    const code = `
export function megaFn() {
  function outer() {
    function inner() {
      return 1;
    }
    return inner();
  }
  return outer();
}
`;
    const result = extractFromSource('mega-deep.ts', code);
    const manifest = result.nestedFunctionManifest ?? [];
    const inner = manifest.find((r) => r.name === 'inner');
    const outer = manifest.find((r) => r.name === 'outer');
    expect(inner).toBeDefined();
    expect(outer).toBeDefined();
    // Both rows' parent is `megaFn` — `outer` is itself only a manifest
    // row (not a real node), so the closest real ancestor wins.
    const megaFn = result.nodes.find((n) => n.kind === 'function' && n.name === 'megaFn')!;
    expect(inner!.parentNodeId).toBe(megaFn.id);
    expect(outer!.parentNodeId).toBe(megaFn.id);
  });

  it('skips inline anonymous callbacks (no name to manifest)', () => {
    process.env['CARTOGRAPH_LARGE_FUNCTION_THRESHOLD'] = '3';
    const code = `
export function megaFn() {
  [1, 2, 3].map((x) => x * 2);
  setTimeout(function () { return 1; }, 0);
  return 0;
}
`;
    const result = extractFromSource('mega-callback.ts', code);
    expect(result.nestedFunctionManifest ?? []).toHaveLength(0);
  });

  it('eager-mode files produce no manifest rows', () => {
    const code = `
export function outer() {
  function helper() { return 1; }
  return helper();
}
`;
    const result = extractFromSource('eager.ts', code);
    expect(result.nestedFunctionManifest ?? []).toHaveLength(0);
    expect(result.nodes.find((n) => n.kind === 'function' && n.name === 'helper')).toBeDefined();
  });
});

describe('Body-position type-of edges (consumer-side type usage)', () => {
  // Without these edges, an exported type whose only consumer is a
  // test that casts/parameterises with it gets falsely flagged as
  // unused_export. Each `it` block exercises one body-position shape.

  it('emits type_of for `value as Foo` casts inside a body', () => {
    const refs = typeRefNamesFor(`
function consumer(input: unknown): void {
  const cast = input as MyExportedType;
  void cast;
}
`);
    expect(refs).toContain('MyExportedType');
  });

  it('emits type_of for `value satisfies Foo` inside a body', () => {
    const refs = typeRefNamesFor(`
function consumer(): void {
  const obj = { kind: 'A' } satisfies MySatisfiedShape;
  void obj;
}
`);
    expect(refs).toContain('MySatisfiedShape');
  });

  it('emits type_of for generic instantiation `new Map<K, V>()` inside a body', () => {
    const refs = typeRefNamesFor(`
function consumer(): void {
  const m = new Map<MyKeyType, MyValueType>();
  void m;
}
`);
    expect(refs).toContain('MyKeyType');
    expect(refs).toContain('MyValueType');
  });

  it('emits type_of for inner-arrow-fn parameter annotations', () => {
    // The arrow is anonymous and inlined into a callback — the existing
    // anonymous-arrow body walk attributes its calls to the enclosing
    // function, but param type annotations on the arrow itself must
    // also flow up to the enclosing scope.
    const refs = typeRefNamesFor(`
function consumer(): void {
  const handler = (input: MyInputType, opts?: MyOptsType) => input;
  void handler;
}
`);
    expect(refs).toContain('MyInputType');
    expect(refs).toContain('MyOptsType');
  });

  it('still emits type_of for the existing variable_declarator case', () => {
    // Regression guard: the original `let x: Foo` path must keep
    // working after the dispatcher refactor.
    const refs = typeRefNamesFor(`
function consumer(): void {
  let x: MyLocalType | null = null;
  void x;
}
`);
    expect(refs).toContain('MyLocalType');
  });

  it('does not double-emit when type_arguments are nested under a declaration annotation', () => {
    // Regression guard for the parent-type guard on the `type_arguments`
    // branch. `let x: Map<K, V>` should emit `Map` / `MyKey` / `MyValue`
    // exactly once each, not twice. The variable_declarator walk handles
    // the whole type subtree; the standalone type_arguments branch is
    // call-site-only.
    const result = extractFromSource(
      'consumer.ts',
      `
function consumer(): void {
  let m: Map<MyKey, MyValue> | null = null;
  void m;
}
`,
    );
    const refs = result.unresolvedReferences.filter((r) => r.referenceKind === 'type_of');
    const counts = new Map<string, number>();
    for (const r of refs) counts.set(r.referenceName, (counts.get(r.referenceName) ?? 0) + 1);
    expect(counts.get('MyKey')).toBe(1);
    expect(counts.get('MyValue')).toBe(1);
  });
});

describe('field_access edges (data-access detection for ATFD/LAA)', () => {
  it('emits field_access for `obj.field` reads inside a body', () => {
    const refs = fieldAccessNamesFor(`
function consumer(order: any): number {
  return order.total + order.discount;
}
`);
    expect(refs).toContain('total');
    expect(refs).toContain('discount');
  });

  it('emits field_access for `this.field` inside a method body', () => {
    const refs = fieldAccessNamesFor(`
class Repo {
  size: number = 0;
  push(): number {
    return this.size + 1;
  }
}
`);
    expect(refs).toContain('size');
  });

  it('does NOT emit field_access for `obj.method()` call sites', () => {
    // Calls are already counted as `calls` edges; double-counting them
    // as field_access would inflate ATFD with method invocations.
    const refs = fieldAccessNamesFor(`
function consumer(order: any): number {
  return order.calculate();
}
`);
    expect(refs).not.toContain('calculate');
  });

  it('emits field_access on each link of a chain `a.b.c`', () => {
    // Chained access naturally produces multiple edges (one per level).
    // Matches LAA's "every distinct attribute access counts" semantics.
    const refs = fieldAccessNamesFor(`
function consumer(state: any): unknown {
  return state.config.timeout;
}
`);
    expect(refs).toContain('config');
    expect(refs).toContain('timeout');
  });

  it('does NOT emit field_access for `new ns.Foo()` constructor targets', () => {
    // Namespace-qualified constructors emit an `instantiates` edge —
    // counting them as field_access too would double-count the same
    // coupling and inflate ATFD for ATFD/LAA-based feature_envy.
    const refs = fieldAccessNamesFor(`
function consumer(): unknown {
  return new ns.Foo();
}
`);
    expect(refs).not.toContain('Foo');
  });

  // F#55 (2026-05-26) — JavaScript / JSX share the TS_FAMILY_FIELD_ACCESS
  // shape but were silently filtered out by a misuse of
  // TYPE_ANNOTATION_LANGUAGES as the dispatch gate (a type-system set
  // standing in for a grammar-level dispatch). On real corpora that
  // surfaced as Express, Svelte 5's JS+JSDoc runtime, and cartograph's
  // own .js sources all emitting ZERO field_access edges despite the
  // shape being registered. The fix dropped the early-return; the
  // shape-map lookup is the authoritative per-language gate.
  it('JavaScript: emits field_access for `obj.field` reads inside a body (F#55)', () => {
    const refs = fieldAccessNamesFor(
      `
function compute(order) {
  return order.total + order.discount;
}
`,
      'compute.js',
    );
    expect(refs).toContain('total');
    expect(refs).toContain('discount');
  });

  it('JavaScript: does NOT emit field_access for a method-call receiver (F#55 dedupe)', () => {
    const refs = fieldAccessNamesFor(
      `
function run(o) {
  o.save();
  const t = o.total;
}
`,
      'run.js',
    );
    expect(refs).toContain('total');
    expect(refs).not.toContain('save');
  });

  it('JSX: emits field_access for `props.x` reads inside a component body (F#55)', () => {
    // JSX shares the TS-family shape; the prior gate denied JSX too,
    // so a function-component reading `props.title` produced no
    // field_access edge. Component code is the dominant pattern that
    // ATFD/LAA-based feature_envy would want to evaluate on a React
    // codebase, so this is the canonical regression to lock in.
    const refs = fieldAccessNamesFor(
      `
function Card(props) {
  return <h1>{props.title}</h1>;
}
`,
      'Card.jsx',
    );
    expect(refs).toContain('title');
  });

  // F#26 slice 1 (2026-05-26) — Python's tree-sitter grammar uses an
  // `attribute` node (with the right-hand-side name on a child field
  // also named `attribute`) for `obj.field` access. Was missing from
  // the per-language dispatch in `captureBodyFieldAccess`; the prior
  // test asserted zero edges to lock in the gap. The negative test
  // is replaced here by positive coverage.
  it('emits field_access for `self.field` reads inside a Python method body (F#26)', () => {
    const result = extractFromSource(
      'foo.py',
      `
class Foo:
    def __init__(self):
        self.name = "x"

    def use(self):
        return self.name
`,
    );
    const fa = result.unresolvedReferences.filter((r) => r.referenceKind === 'field_access');
    const names = fa.map((r) => r.referenceName);
    expect(names).toContain('name');
  });

  it('Python: chained access emits one field_access per link (`self.bar.baz`)', () => {
    const result = extractFromSource(
      'foo.py',
      `
class Foo:
    def use(self):
        return self.bar.baz
`,
    );
    const names = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'field_access')
      .map((r) => r.referenceName);
    expect(names).toContain('bar');
    expect(names).toContain('baz');
  });

  it('Python: does NOT emit field_access for `self.method()` call sites', () => {
    const result = extractFromSource(
      'foo.py',
      `
class Foo:
    def use(self):
        return self.compute()
`,
    );
    const names = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'field_access')
      .map((r) => r.referenceName);
    expect(names).not.toContain('compute');
  });

  // F#27 (2026-05-26) — Java's tree-sitter grammar uses a `field_access`
  // node (matching the edge kind by coincidence). Same gap as F#26;
  // the per-language dispatch table now covers it.
  it('Java: emits field_access for `this.field` reads inside a method body (F#27)', () => {
    const result = extractFromSource(
      'Foo.java',
      `
class Foo {
  String name;
  String use() {
    return this.name;
  }
}
`,
    );
    const names = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'field_access')
      .map((r) => r.referenceName);
    expect(names).toContain('name');
  });

  it('Java: `this.bar.greet()` emits field_access for the receiver `bar`', () => {
    // Java's `method_invocation(object=this.bar, name=greet)` factors
    // the method name out of the field-access shape, so `this.bar` IS
    // a real field read at the call site (we touched the bar field to
    // dispatch on it). The receiver edge counts; the method name itself
    // never appears as a field_access in the Java AST.
    const result = extractFromSource(
      'Foo.java',
      `
class Foo {
  Bar bar;
  void use() {
    this.bar.greet();
  }
}
`,
    );
    const names = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'field_access')
      .map((r) => r.referenceName);
    expect(names).toContain('bar');
    expect(names).not.toContain('greet');
  });

  // F#42 (2026-05-26) — Go's tree-sitter grammar uses a
  // `selector_expression(operand, field=field_identifier)` node for
  // `obj.field` reads. Method-call shapes (`obj.M(...)`) wrap the
  // selector in a `call_expression`, so the parent-skip set covers
  // dedupe — same pattern as F#39 for C/C++. Was missing from the
  // per-language dispatch in `captureBodyFieldAccess`.
  it('Go: emits field_access for `obj.field` reads inside a function body (F#42)', () => {
    const result = extractFromSource(
      'consumer.go',
      `
package main

type Order struct {
  Total    int
  Discount int
}

func Compute(o *Order) int {
  return o.Total + o.Discount
}
`,
    );
    const names = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'field_access')
      .map((r) => r.referenceName);
    expect(names).toContain('Total');
    expect(names).toContain('Discount');
  });

  it('Go: does NOT emit field_access for a method-call receiver (F#42 dedupe)', () => {
    // `o.Save()` parses as `call_expression(function=selector_expression, ...)` —
    // the parent-skip set keeps the method name out of the
    // field_access stream because it's already a `calls` edge.
    const result = extractFromSource(
      'consumer.go',
      `
package main

type Order struct{ Total int }

func (o *Order) Save() {}

func Run(o *Order) {
  o.Save()
  _ = o.Total
}
`,
    );
    const names = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'field_access')
      .map((r) => r.referenceName);
    expect(names).toContain('Total');
    expect(names).not.toContain('Save');
  });

  it('Go: chained access emits one field_access per link (`a.b.c`)', () => {
    // Matches the Python / C / C++ chained-access semantics — each
    // distinct attribute access counts (LAA's "every link"
    // contract).
    const result = extractFromSource(
      'consumer.go',
      `
package main

type Inner struct{ Value int }
type Outer struct{ Child *Inner }

func Read(o *Outer) int {
  return o.Child.Value
}
`,
    );
    const names = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'field_access')
      .map((r) => r.referenceName);
    expect(names).toContain('Child');
    expect(names).toContain('Value');
  });

  // F#43 (2026-05-26) — Kotlin's tree-sitter grammar uses
  // `navigation_expression(operand, navigation_suffix(., leaf))` for
  // `obj.field`. The property leaf is NESTED inside `navigation_suffix`,
  // so the dispatch shape uses `propertyDescendantKind: 'simple_identifier'`
  // to descend through the intermediate node. Method calls wrap the
  // navigation_expression in a `call_expression` — dedupe via
  // `parentTypesToSkip: {call_expression}`.
  it('Kotlin: emits field_access for `obj.field` reads inside a function body (F#43)', () => {
    const result = extractFromSource(
      'Consumer.kt',
      `
package x

class Order(val total: Int, val discount: Int)

fun compute(o: Order): Int {
  return o.total + o.discount
}
`,
    );
    const names = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'field_access')
      .map((r) => r.referenceName);
    expect(names).toContain('total');
    expect(names).toContain('discount');
  });

  it('Kotlin: does NOT emit field_access for a method-call receiver (F#43 dedupe)', () => {
    // `o.save()` parses as `call_expression(navigation_expression, call_suffix)` —
    // the parent-skip keeps the method name out of the field_access
    // stream because it's already a `calls` edge.
    const result = extractFromSource(
      'Consumer.kt',
      `
package x

class Order(val total: Int) {
  fun save() {}
}

fun run(o: Order) {
  o.save()
  val unused = o.total
}
`,
    );
    const names = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'field_access')
      .map((r) => r.referenceName);
    expect(names).toContain('total');
    expect(names).not.toContain('save');
  });

  it('Kotlin: chained access emits one field_access per link (`a.b.c`)', () => {
    // Each navigation_expression in the chain triggers an emit; the
    // outermost `o.child.value` has TWO navigation_expression nodes
    // (one for `o.child`, one for `(o.child).value`).
    const result = extractFromSource(
      'Consumer.kt',
      `
package x

class Inner(val value: Int)
class Outer(val child: Inner)

fun read(o: Outer): Int {
  return o.child.value
}
`,
    );
    const names = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'field_access')
      .map((r) => r.referenceName);
    expect(names).toContain('child');
    expect(names).toContain('value');
  });

  // F#44 (2026-05-26) — Go struct literals `&Foo{X: 1}` and `Foo{X: 1}`
  // both parse to `composite_literal` and emit `instantiates`. Slice /
  // map / array literals share the same node kind but are gated out by
  // STRUCT_LITERAL_CTOR_KINDS (only type_identifier/qualified_type/
  // generic_type qualify).
  it('Go: emits instantiates for `&Foo{}` and `Foo{}` struct literals (F#44)', () => {
    const result = extractFromSource(
      'main.go',
      `
package main

type Order struct{ Total int }

func make() *Order {
  a := &Order{Total: 1}
  _ = Order{Total: 2}
  return a
}
`,
    );
    const insts = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'instantiates')
      .map((r) => r.referenceName);
    expect(insts).toContain('Order');
  });

  it('Go: emits references edge for bare PascalCase symbol read (F#44)', () => {
    // `return Form` / `value = DebugMode` style: a bare read of a
    // package-scope exported (PascalCase) symbol. The most common
    // shape in idiomatic Go for cross-symbol references that aren't
    // calls / instantiations / type-positions / field-accesses.
    const result = extractFromSource(
      'binding.go',
      `
package main

var Form = struct{}{}
var JSON = struct{}{}

func defaultBinder() any {
  return Form
}

func altBinder() any {
  return JSON
}
`,
    );
    const refs = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'references')
      .map((r) => r.referenceName);
    expect(refs).toContain('Form');
    expect(refs).toContain('JSON');
  });

  it('Go: does NOT emit references for binding positions or callees (F#44 gate)', () => {
    // Each construct below MUST NOT produce a references edge for the
    // tested name in the position it occupies — though the same name
    // appearing in a real read position elsewhere would still emit
    // (those edges are correct).
    // - `var DebugMode = "x"` — DebugMode is binding LHS.
    // - `Println(x)` — Println is callee, already a calls edge.
    // - `&Engine{}` — Engine is in instantiates position, already an instantiates edge.
    const result = extractFromSource(
      'main.go',
      `
package main

var DebugMode = "x"

func use() {
  Println("hello")
  e := &Engine{}
  _ = e
}
`,
    );
    const refs = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'references')
      .map((r) => r.referenceName);
    // DebugMode is the binding LHS → skipped (no read of DebugMode in the body).
    expect(refs).not.toContain('DebugMode');
    // Println is callee → already a calls edge.
    expect(refs).not.toContain('Println');
    // Engine is the composite-literal type → already an instantiates edge.
    expect(refs).not.toContain('Engine');
  });

  it('Go: short-var LHS bindings (`X, Y := pair()`) do NOT emit references for the LHS (F#44 gate)', () => {
    // X and Y at the LHS positions should be skipped; the RHS call to
    // `pair()` is a normal call edge. This isolates the multi-LHS
    // positional-skip code path.
    const result = extractFromSource(
      'main.go',
      `
package main

func use() {
  X, Y := pair()
  _ = X
  _ = Y
}
`,
    );
    const refs = result.unresolvedReferences.filter((r) => r.referenceKind === 'references');
    // X and Y DO appear in references because `_ = X` and `_ = Y` ARE
    // real reads (RHS of assignment). What we're proving is that
    // dedup-by-(fromNodeId, name, kind) collapses the LHS-binding
    // emit + the RHS-read emit into ONE ref — not two. So the count
    // for X equals 1 (the read), not 2 (the binding + the read).
    const xRefs = refs.filter((r) => r.referenceName === 'X');
    const yRefs = refs.filter((r) => r.referenceName === 'Y');
    expect(xRefs.length).toBe(1);
    expect(yRefs.length).toBe(1);
  });

  it('Go: does NOT emit instantiates for slice / map / array composite literals (F#44 gate)', () => {
    // `[]int{1,2,3}` and `map[string]int{}` are composite_literal nodes
    // but with `slice_type`/`map_type` as the type child — not a
    // project struct.
    const result = extractFromSource(
      'main.go',
      `
package main

func make() {
  _ = []int{1, 2, 3}
  _ = map[string]int{"a": 1}
  _ = [3]int{1, 2, 3}
}
`,
    );
    const insts = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'instantiates')
      .map((r) => r.referenceName);
    // None of `int`, `string`, slice/map type-prefixes leak through.
    expect(insts).not.toContain('int');
    expect(insts).not.toContain('string');
  });

  it('Kotlin: safe-call (`o?.field`) and non-null assertion (`o!!.field`) both emit field_access', () => {
    // tree-sitter-kotlin parses `o?.bar` and `o!!.bar` as the same
    // `navigation_expression(navigation_suffix(simple_identifier))`
    // shape — only the leading anonymous token inside navigation_suffix
    // differs (`?.` / `!!.` vs `.`). The shape entry catches all three.
    const result = extractFromSource(
      'Consumer.kt',
      `
package x

class Foo(val bar: Int)

fun use(maybe: Foo?, sure: Foo) {
  val a = maybe?.bar
  val b = sure!!.bar
}
`,
    );
    const names = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'field_access')
      .map((r) => r.referenceName);
    // Same target name from both shapes — dedupe by (fromNodeId, name, kind)
    // collapses them to one ref attributed to `use`.
    expect(names).toContain('bar');
  });
});

describe('In-file SCREAMING_SNAKE_CASE constant reads (references edges)', () => {
  // Friction F-B: module-scope constants used inside the SAME file
  // produced no caller edges because the body walker only saw
  // call / instantiation / type / field-access positions. Bare
  // identifier reads of named constants were a structural blind
  // spot — closed by `captureBodyConstantReads` in
  // `src/extraction/tree-sitter.ts`.
  it('emits references edge for SCREAMING_SNAKE constant read inside a function body', () => {
    const code = `
export const FOO_VERSION = 1;
function reads() {
  return FOO_VERSION;
}
`;
    const refs = refsByKind(code, 'references');
    expect(refs).toContainEqual({ from: 'reads', name: 'FOO_VERSION' });
  });

  it('emits references edge for SCREAMING_SNAKE constant read inside a method body', () => {
    const code = `
const MAX_RETRIES = 3;
class Worker {
  retry(): number { return MAX_RETRIES; }
}
`;
    const refs = refsByKind(code, 'references');
    expect(refs.some((r) => r.name === 'MAX_RETRIES' && r.from === 'retry')).toBe(true);
  });

  it('emits references edge for SCREAMING_SNAKE constant used as call argument', () => {
    const code = `
const STORAGE_KEY = 'k';
function set(qb: any) { setMetadata(qb, STORAGE_KEY); }
`;
    const refs = refsByKind(code, 'references');
    expect(refs.some((r) => r.name === 'STORAGE_KEY' && r.from === 'set')).toBe(true);
  });

  it('emits references edge for SCREAMING_SNAKE constant used as object-literal VALUE', () => {
    // `{ newVersion: EXTRACTION_LOGIC_VERSION }` — the bare identifier
    // is the VALUE side of a pair, which must fire as a read.
    const code = `
const FOO_VERSION = 1;
function emit() { return { newVersion: FOO_VERSION }; }
`;
    const refs = refsByKind(code, 'references');
    expect(refs.some((r) => r.name === 'FOO_VERSION' && r.from === 'emit')).toBe(true);
  });

  it('does NOT emit references for local-variable reads (no SCREAMING_SNAKE name)', () => {
    // Negative: only SCREAMING_SNAKE-named constants get the rule.
    // Local-camelCase / lowercase reads still pass through the existing
    // call/instantiation/type-annotation paths, but should not appear
    // as bare `references` edges here.
    const code = `
function reads() {
  const localFoo = 1;
  return localFoo;
}
`;
    const refs = refsByKind(code, 'references');
    expect(refs.some((r) => r.name === 'localFoo')).toBe(false);
  });

  it('does NOT emit references for single-word all-caps names (`URL`, `OK`)', () => {
    // Conservative naming filter: requires `_` or trailing digit so
    // common all-caps type names like `URL` / `HTML` / `OK` don't
    // create false-positive caller edges to types.
    const code = `
const URL = 'x';
const OK = true;
function reads() { return URL + (OK ? '' : ''); }
`;
    const refs = refsByKind(code, 'references');
    expect(refs.some((r) => r.name === 'URL')).toBe(false);
    expect(refs.some((r) => r.name === 'OK')).toBe(false);
  });

  it('does NOT double-emit when SCREAMING_SNAKE is the callee of a call', () => {
    // The callee position of `call_expression` is already covered by
    // `tsExtractCall` — emitting a `references` edge here too would
    // double-count.
    const code = `
const MY_FN = () => 1;
function caller() { return MY_FN(); }
`;
    const refs = refsByKind(code, 'references');
    // The function-call edge appears with kind 'calls'; the references
    // rule must NOT fire on the same identifier.
    expect(refs.some((r) => r.name === 'MY_FN')).toBe(false);
  });

  it('does NOT emit references when the identifier is the variable_declarator name', () => {
    // The DECLARATION site of `const FOO_VERSION = 1` is `FOO_VERSION`
    // itself — the rule must not attribute the constant to itself.
    const code = `
const FOO_VERSION = 1;
function noop() { return 0; }
`;
    const refs = refsByKind(code, 'references');
    expect(refs.some((r) => r.name === 'FOO_VERSION')).toBe(false);
  });

  it('does NOT emit references for unsupported languages (Python)', () => {
    // Supported languages are JS family + Rust (see captureBodyConstantReads).
    // Python uses the same SCREAMING_SNAKE convention but emit is gated
    // on language — it'll need its own branch + skip-list before opting in.
    const result = extractFromSource(
      'reads.py',
      `
FOO_VERSION = 1
def reads():
    return FOO_VERSION
`,
    );
    const refs = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'references')
      .map((r) => r.referenceName);
    expect(refs).not.toContain('FOO_VERSION');
  });

  it('emits references for `obj.FOO_VERSION` only as field_access, not references', () => {
    // Member-expression PROPERTY position is already covered by
    // `captureBodyFieldAccess`. The constant-read rule must skip it.
    const code = `
function reads(obj: any) { return obj.MAX_RETRIES; }
`;
    const result = extractFromSource('reads.ts', code);
    const refs = result.unresolvedReferences;
    expect(refs.some((r) => r.referenceKind === 'references' && r.referenceName === 'MAX_RETRIES')).toBe(false);
    expect(refs.some((r) => r.referenceKind === 'field_access' && r.referenceName === 'MAX_RETRIES')).toBe(true);
  });
});

describe('Type Alias Extraction', () => {
  it('should extract exported type aliases in TypeScript', () => {
    const code = `
export type AuthContextValue = {
  user: User | null;
  login: () => void;
  logout: () => void;
};
`;
    const result = extractFromSource('types.ts', code);

    const typeNode = result.nodes.find((n) => n.kind === 'type_alias');
    expect(typeNode).toMatchObject({
      kind: 'type_alias',
      name: 'AuthContextValue',
      isExported: true,
    });
  });

  it('should extract non-exported type aliases', () => {
    const code = `
type InternalState = {
  loading: boolean;
  error: string | null;
};
`;
    const result = extractFromSource('internal.ts', code);

    const typeNode = result.nodes.find((n) => n.kind === 'type_alias');
    expect(typeNode).toMatchObject({
      kind: 'type_alias',
      name: 'InternalState',
      isExported: false,
    });
  });

  it('should extract multiple type aliases from the same file', () => {
    const code = `
export type UnitSystem = 'metric' | 'imperial';
export type DateFormat = 'ISO' | 'US' | 'EU';
type Internal = string;
`;
    const result = extractFromSource('config.ts', code);

    const typeAliases = result.nodes.filter((n) => n.kind === 'type_alias');
    expect(typeAliases).toHaveLength(3);

    const exported = typeAliases.filter((n) => n.isExported);
    expect(exported).toHaveLength(2);
    expect(exported.map((n) => n.name).sort(byString)).toEqual(['DateFormat', 'UnitSystem']);
  });

  it('indexes TypeScript string-literal generic arguments as alias-contained contract properties', () => {
    const code = `
export interface Service<Name extends string, Req, Resp> {
  name: Name;
  request: Req;
  response: Resp;
}

export type MyServiceList = [
  Service<
    'query_apply_record',
    { pageNo: number; pageSize: number },
    { success: boolean }
  >,
  Service<
    'apply_confirm',
    { code: string },
    { success: boolean }
  >
];
`;
    const result = extractFromSource('services/api.ts', code);
    const alias = result.nodes.find((n) => n.kind === 'type_alias' && n.name === 'MyServiceList');
    const contractProps = result.nodes.filter(
      (n) => n.kind === 'property' && n.qualifiedName?.startsWith('MyServiceList::'),
    );

    expect(contractProps.map((n) => n.name).sort(byString)).toEqual(['apply_confirm', 'query_apply_record']);
    expect(contractProps.every((n) => n.isExported)).toBe(true);
    expect(contractProps.every((n) => n.signature?.startsWith('Service<'))).toBe(true);
    expect(
      contractProps.every((prop) =>
        result.edges.some((edge) => edge.kind === 'contains' && edge.source === alias?.id && edge.target === prop.id),
      ),
    ).toBe(true);
  });

  it('does not turn plain TypeScript string-literal unions into contract properties', () => {
    const code = `
export type UnitSystem = 'metric' | 'imperial';
`;
    const result = extractFromSource('config.ts', code);

    expect(result.nodes.filter((n) => n.kind === 'property' && ['metric', 'imperial'].includes(n.name))).toEqual([]);
  });
});

describe('Exported Variable Extraction', () => {
  it('should extract exported const with call expression (Zustand store)', () => {
    const code = `
export const useUIStore = create<UIState>((set) => ({
  isOpen: false,
  toggle: () => set((s) => ({ isOpen: !s.isOpen })),
}));
`;
    const result = extractFromSource('store.ts', code);

    const varNode = result.nodes.find((n) => n.kind === 'constant' && n.name === 'useUIStore');
    expect(varNode).toBeDefined();
    expect(varNode?.isExported).toBe(true);
  });

  it('should extract exported const with object literal', () => {
    const code = `
export const config = {
  apiUrl: 'https://api.example.com',
  timeout: 5000,
};
`;
    const result = extractFromSource('config.ts', code);

    const varNode = result.nodes.find((n) => n.kind === 'constant' && n.name === 'config');
    expect(varNode).toBeDefined();
    expect(varNode?.isExported).toBe(true);
  });

  it('should extract exported const with array literal', () => {
    const code = `
export const SCREEN_NAMES = ['home', 'settings', 'profile'] as const;
`;
    const result = extractFromSource('constants.ts', code);

    const varNode = result.nodes.find((n) => n.kind === 'constant' && n.name === 'SCREEN_NAMES');
    expect(varNode).toBeDefined();
    expect(varNode?.isExported).toBe(true);
  });

  it('should extract exported const with primitive value', () => {
    const code = `
export const MAX_RETRIES = 3;
export const API_VERSION = "v2";
`;
    const result = extractFromSource('constants.ts', code);

    const variables = result.nodes.filter((n) => n.kind === 'constant');
    expect(variables).toHaveLength(2);
    expect(variables.map((n) => n.name).sort(byString)).toEqual(['API_VERSION', 'MAX_RETRIES']);
  });

  it('should NOT duplicate arrow functions as both function and variable', () => {
    const code = `
export const useAuth = () => {
  return useContext(AuthContext);
};
`;
    const result = extractFromSource('hooks.ts', code);

    // Should be extracted as function (from arrow function handler), NOT as variable
    const funcNodes = result.nodes.filter((n) => n.kind === 'function' && n.name === 'useAuth');
    const varNodes = result.nodes.filter((n) => n.kind === 'variable' && n.name === 'useAuth');
    expect(funcNodes).toHaveLength(1);
    expect(varNodes).toHaveLength(0);
  });

  it('should extract non-exported const as non-exported variable', () => {
    const code = `
const internalConfig = {
  debug: true,
};
`;
    const result = extractFromSource('internal.ts', code);

    // Non-exported const at file level should be extracted as a constant (not exported)
    const varNodes = result.nodes.filter(
      (n) => (n.kind === 'variable' || n.kind === 'constant') && n.name === 'internalConfig',
    );
    expect(varNodes).toHaveLength(1);
    expect(varNodes[0]?.isExported).toBeFalsy();
  });

  it('should extract Zod schema exports', () => {
    const code = `
export const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
});
`;
    const result = extractFromSource('schemas.ts', code);

    const varNode = result.nodes.find((n) => n.kind === 'constant' && n.name === 'userSchema');
    expect(varNode).toBeDefined();
    expect(varNode?.isExported).toBe(true);
  });

  it('should extract XState machine exports', () => {
    const code = `
export const authMachine = createMachine({
  id: "auth",
  initial: "idle",
  states: {
    idle: {},
    authenticated: {},
  },
});
`;
    const result = extractFromSource('machine.ts', code);

    const varNode = result.nodes.find((n) => n.kind === 'constant' && n.name === 'authMachine');
    expect(varNode).toBeDefined();
    expect(varNode?.isExported).toBe(true);
  });
});

describe('File Node Extraction', () => {
  it('should create a file-kind node for each parsed file', () => {
    const code = `
export function greet(name: string): string {
  return "Hello " + name;
}
`;
    const result = extractFromSource('greeter.ts', code);

    const fileNode = result.nodes.find((n) => n.kind === 'file');
    expect(fileNode).toBeDefined();
    expect(fileNode?.name).toBe('greeter.ts');
    expect(fileNode?.filePath).toBe('greeter.ts');
    expect(fileNode?.language).toBe('typescript');
    expect(fileNode?.startLine).toBe(1);
  });

  it('should create file nodes for Python files', () => {
    const code = `
def main():
    pass
`;
    const result = extractFromSource('main.py', code);

    const fileNode = result.nodes.find((n) => n.kind === 'file');
    expect(fileNode).toBeDefined();
    expect(fileNode?.name).toBe('main.py');
    expect(fileNode?.language).toBe('python');
  });

  it('should create containment edges from file node to top-level declarations', () => {
    const code = `
export function foo() {}
export function bar() {}
`;
    const result = extractFromSource('fns.ts', code);

    const fileNode = result.nodes.find((n) => n.kind === 'file');
    expect(fileNode).toBeDefined();

    // There should be contains edges from the file node to each function
    const containsEdges = result.edges.filter((e) => e.source === fileNode?.id && e.kind === 'contains');
    expect(containsEdges.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Python Extraction', () => {
  it('should extract function definitions', () => {
    const code = `
def calculate_total(items: list, tax_rate: float) -> float:
    """Calculate total with tax."""
    subtotal = sum(item.price for item in items)
    return subtotal * (1 + tax_rate)
`;
    const result = extractFromSource('calc.py', code);

    const fileNode = result.nodes.find((n) => n.kind === 'file');
    expect(fileNode).toBeDefined();

    const funcNode = result.nodes.find((n) => n.kind === 'function');
    expect(funcNode).toMatchObject({
      kind: 'function',
      name: 'calculate_total',
      language: 'python',
    });
  });

  it('should extract class definitions', () => {
    const code = `
class UserService:
    """Service for managing users."""

    def __init__(self, db):
        self.db = db

    def get_user(self, user_id: str) -> User:
        return self.db.find_user(user_id)
`;
    const result = extractFromSource('service.py', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('UserService');
  });

  // F#26 slice 3 (2026-05-26) — Python's Protocol/ABC/ABCMeta superclasses
  // are interface contracts (PEP 544 structural typing + abc module),
  // so they should emit `implements` rather than `extends`. Regular
  // class inheritance still emits `extends`.
  it('emits `implements` for Protocol superclass and `extends` for regular base (F#26 slice 3)', () => {
    const code = `
from typing import Protocol

class Bar:
    pass

class Renderable(Protocol):
    def render(self) -> str: ...

class Widget(Bar, Renderable):
    def render(self) -> str:
        return "x"
`;
    const result = extractFromSource('widget.py', code);
    const refs = result.unresolvedReferences.filter(
      (r) => r.referenceKind === 'extends' || r.referenceKind === 'implements',
    );
    const extendsNames = refs.filter((r) => r.referenceKind === 'extends').map((r) => r.referenceName);
    const implementsNames = refs.filter((r) => r.referenceKind === 'implements').map((r) => r.referenceName);
    // Renderable inheriting Protocol is the canonical "I declare a
    // contract" pattern — emit implements for that edge. Widget's
    // direct bases (Bar + Renderable) are user-defined classes; the
    // heuristic stays conservative and keeps them as extends because
    // cartograph can't structurally tell Renderable apart from a
    // regular class at extraction time. A resolver-level pass would
    // be needed to propagate Protocol-ness across user-defined
    // subclasses; that's a deferred follow-up.
    expect(extendsNames).toContain('Bar');
    expect(extendsNames).toContain('Renderable');
    expect(implementsNames).toContain('Protocol');
  });

  it('emits `implements` for ABC superclass', () => {
    const code = `
from abc import ABC

class Shape(ABC):
    def area(self) -> float: ...
`;
    const result = extractFromSource('shape.py', code);
    const refs = result.unresolvedReferences.filter(
      (r) => r.referenceKind === 'implements' && r.referenceName === 'ABC',
    );
    expect(refs.length).toBeGreaterThan(0);
  });

  it('emits `implements` for a qualified `typing.Protocol` superclass', () => {
    const code = `
import typing

class Drawable(typing.Protocol):
    def draw(self) -> None: ...
`;
    const result = extractFromSource('drawable.py', code);
    const refs = result.unresolvedReferences.filter(
      (r) => r.referenceKind === 'implements' && r.referenceName === 'typing.Protocol',
    );
    expect(refs.length).toBeGreaterThan(0);
  });

  it('does NOT misclassify user-defined classes named after interfaces', () => {
    // A user-defined class named e.g. `MyProtocol` is NOT typing.Protocol;
    // only the EXACT bare/qualified terminal `Protocol`/`ABC`/`ABCMeta`
    // matches. Conservative on purpose — cartograph can't structurally
    // tell user-defined ABC subclasses apart from regular bases at
    // extraction time, so they stay `extends`.
    const code = `
class MyProtocol:
    pass

class ABCDishwasher:
    pass

class Foo(MyProtocol, ABCDishwasher):
    pass
`;
    const result = extractFromSource('foo.py', code);
    const refs = result.unresolvedReferences.filter(
      (r) => r.referenceKind === 'implements' || r.referenceKind === 'extends',
    );
    const implementsNames = refs.filter((r) => r.referenceKind === 'implements').map((r) => r.referenceName);
    const extendsNames = refs.filter((r) => r.referenceKind === 'extends').map((r) => r.referenceName);
    expect(implementsNames).not.toContain('MyProtocol');
    expect(implementsNames).not.toContain('ABCDishwasher');
    expect(extendsNames).toContain('MyProtocol');
    expect(extendsNames).toContain('ABCDishwasher');
  });
});

describe('Go Extraction', () => {
  it('should extract function declarations', () => {
    const code = `
package main

func ProcessOrder(order Order) (Receipt, error) {
    // Process the order
    return Receipt{}, nil
}
`;
    const result = extractFromSource('main.go', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function');
    expect(funcNode).toBeDefined();
    expect(funcNode?.name).toBe('ProcessOrder');
  });

  it('should extract method declarations', () => {
    const code = `
package main

type Service struct {
    db *Database
}

func (s *Service) GetUser(id string) (*User, error) {
    return s.db.FindUser(id)
}
`;
    const result = extractFromSource('service.go', code);

    const methodNode = result.nodes.find((n) => n.kind === 'method');
    expect(methodNode).toBeDefined();
    expect(methodNode?.name).toBe('GetUser');
  });

  it('should extract members of var ( ... ) and const ( ... ) blocks', () => {
    // ollama bug-hunt FN1: const block extraction worked but var block
    // extraction silently dropped every member. Both shapes share the
    // var_spec / const_spec child pattern in the Go grammar — the
    // extractor must walk both uniformly.
    const code = `
package main

var (
    Alpha = 1
    bravo = 2
    Charlie = 3
)

const (
    DELTA = 10
    echo  = 20
)

var Single = 99
`;
    const result = extractFromSource('blocks.go', code);

    expect(nodeNamesByKind(result, 'variable').sort(byString)).toEqual(['Alpha', 'bravo', 'Charlie', 'Single']);
    expect(nodeNamesByKind(result, 'constant').sort(byString)).toEqual(['DELTA', 'echo']);
  });

  it('extracts Go qualified-type embedded fields (model.Base / *tokenizer.Tokenizer)', () => {
    // ollama bug-hunt FN3 remainder: extractGoEmbeddedField only handled
    // bare `type_identifier` (the `*Options` / `Options` case). Qualified
    // embeds `model.Base` / `*tokenizer.Tokenizer` produced `qualified_type`
    // AST nodes and were silently dropped — the dominant cross-package
    // composition pattern.
    const code = `
package gemma2

type Model struct {
    model.Base
    *model.Pointer
    tokenizer.Tokenizer
    *Options
}
`;
    const result = extractFromSource('model.go', code);

    const extendsRefs = result.unresolvedReferences.filter((r) => r.referenceKind === 'extends');
    const names = extendsRefs.map((r) => r.referenceName).sort(byString);
    // Both the qualified embeds AND the local *Options should produce
    // refs. The qualifier (`model.` / `tokenizer.`) is stripped — the
    // resolver matches by bare name and walks files to find the right
    // same-named target.
    expect(names).toEqual(['Base', 'Options', 'Pointer', 'Tokenizer']);
  });

  it('strips the cgo `C.` pseudo-receiver from call refs so they resolve against the indexed C function', () => {
    // ollama bug-hunt FN6: `C.do_thing(...)` previously produced an
    // unresolved-ref named `C.do_thing`, which never matched anything
    // (no symbol exists at qualified name `C.do_thing`). The cgo
    // bridge's `C` identifier is a pseudo-import; the real target
    // is the bare C function in a sibling .c/.h file. Strip the
    // prefix so the resolver finds the actual C function by name.
    const code = `
package main

import "C"

func runIt() {
    n := C.do_thing(42)
    _ = n
    C.do_other()
}

func notCgo(c *Client) {
    c.do_thing()
}
`;
    const result = extractFromSource('main.go', code);

    const callRefs = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
    const names = callRefs.map((r) => r.referenceName);
    // cgo calls strip to bare function names.
    expect(names).toContain('do_thing');
    expect(names).toContain('do_other');
    // Non-cgo `c.do_thing()` (real Go method call) keeps its qualified
    // form so a same-file Client method still matches by receiver.
    expect(names).toContain('c.do_thing');
    // No `C.foo` form should leak through for cgo calls.
    expect(names).not.toContain('C.do_thing');
    expect(names).not.toContain('C.do_other');
  });

  it('should extract Go struct fields (named single, named multi, embedded handled by extends)', () => {
    // ollama bug-hunt FN2: zero `field` nodes in 807 Go files because
    // the extractor had no fieldTypes registration. Now Go struct
    // field_declaration -> field_identifier emits one field node per
    // name (multi-name fields like `X, Y int` emit two). Embedded
    // fields (no field_identifier) stay as extends edges.
    const code = `
package api

type Client struct {
    Host    string
    Port    int    \`json:"port"\`
    timeout int
    X, Y    float64
    *Mutex
    db      *Database
}
`;
    const result = extractFromSource('client.go', code);

    const fields = result.nodes.filter((n) => n.kind === 'field');
    const fieldNames = fields.map((n) => n.name).sort(byString);
    // Expect: Host, Port, timeout, X, Y, db (6 named); *Mutex skipped (embedded)
    expect(fieldNames).toEqual(['db', 'Host', 'Port', 'timeout', 'X', 'Y']);

    // Multi-name `X, Y float64` - both get the same type signature
    expect(findExtractedFieldByName(result, 'X')?.signature).toContain('float64');
    expect(findExtractedFieldByName(result, 'Y')?.signature).toContain('float64');
    // Pointer type preserved
    expect(findExtractedFieldByName(result, 'db')?.signature).toContain('*Database');
    // Tag is stripped from the signature (the raw_string_literal exclusion path).
    expect(findExtractedFieldByName(result, 'Port')?.signature).toBe('Port int');
    // isExported follows the Go convention
    expect(findExtractedFieldByName(result, 'Host')?.isExported).toBe(true);
    expect(findExtractedFieldByName(result, 'timeout')?.isExported).toBe(false);
  });

  it('should extract Go interface methods as nodes with contains edges from the interface', () => {
    // ollama bug-hunt FN4: ml.Backend interface (8 methods) surfaced as
    // a signature-less node with zero `contains` edges - methods were
    // entirely invisible. extractInterfaceTypeAlias now walks method_elem
    // children and emits one method node per declared method.
    const code = `
package ml

type Backend interface {
    Close() error
    Load(p string) (Model, error)
    BackendMemory() uint64
    io.Writer
}
`;
    const result = extractFromSource('backend.go', code);

    const ifaceNode = result.nodes.find((n) => n.kind === 'interface' && n.name === 'Backend');
    expect(ifaceNode).toBeDefined();

    const methods = result.nodes.filter((n) => n.kind === 'method');
    const methodNames = methods.map((m) => m.name).sort(byString);
    expect(methodNames).toEqual(['BackendMemory', 'Close', 'Load']);

    const closeMethod = methods.find((m) => m.name === 'Close');
    expect(closeMethod?.signature).toBe('() error');
    expect(closeMethod?.isExported).toBe(true);
    expect(closeMethod?.qualifiedName).toBe('Backend::Close');

    const loadMethod = methods.find((m) => m.name === 'Load');
    expect(loadMethod?.signature).toContain('(p string)');
    expect(loadMethod?.signature).toContain('(Model, error)');

    // contains edge: interface -> method
    const containsEdges = result.edges.filter(
      (e) => e.kind === 'contains' && e.source === ifaceNode!.id && methods.some((m) => m.id === e.target),
    );
    expect(containsEdges).toHaveLength(3);

    // Methods must NOT also be direct children of the file node — the
    // nodeStack push in extractInterfaceTypeAlias suppresses the auto-edge.
    const fileNode = result.nodes.find((n) => n.kind === 'file');
    const fileToMethodEdges = result.edges.filter(
      (e) => e.kind === 'contains' && e.source === fileNode?.id && methods.some((m) => m.id === e.target),
    );
    expect(fileToMethodEdges).toHaveLength(0);
  });

  it('should mark uppercase-named symbols as exported and lowercase as not (Go naming convention)', () => {
    const code = `
package api

func PublicHelper() string { return "" }
func privateHelper() string { return "" }

type Client struct{}
type internalState struct{}

type Reader interface { Read() }
type unsafeReader interface { Read() }

const MaxRetries = 5
const defaultTimeout = 30

var DefaultClient = &Client{}
var logger = "x"

func (c *Client) Connect() error { return nil }
func (c *Client) reset() {}
`;
    const result = extractFromSource('api.go', code);

    // Functions
    expect(findExtractedNodeByName(result, 'PublicHelper')?.isExported).toBe(true);
    expect(findExtractedNodeByName(result, 'privateHelper')?.isExported).toBe(false);

    // Type aliases routed to struct/interface
    expect(findExtractedNodeByName(result, 'Client')?.isExported).toBe(true);
    expect(findExtractedNodeByName(result, 'internalState')?.isExported).toBe(false);
    expect(findExtractedNodeByName(result, 'Reader')?.isExported).toBe(true);
    expect(findExtractedNodeByName(result, 'unsafeReader')?.isExported).toBe(false);

    // Variables / constants
    expect(findExtractedNodeByName(result, 'MaxRetries')?.isExported).toBe(true);
    expect(findExtractedNodeByName(result, 'defaultTimeout')?.isExported).toBe(false);
    expect(findExtractedNodeByName(result, 'DefaultClient')?.isExported).toBe(true);
    expect(findExtractedNodeByName(result, 'logger')?.isExported).toBe(false);

    // Methods — Go methods are top-level decls and carry their own exportedness
    expect(findExtractedNodeByName(result, 'Connect')?.isExported).toBe(true);
    expect(findExtractedNodeByName(result, 'reset')?.isExported).toBe(false);
  });
});

describe('Rust Extraction', () => {
  it('should extract function declarations', () => {
    const code = `
pub fn process_data(input: &str) -> Result<Output, Error> {
    // Process data
    Ok(Output::new())
}
`;
    const result = extractFromSource('lib.rs', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function');
    expect(funcNode).toBeDefined();
    expect(funcNode?.name).toBe('process_data');
    expect(funcNode?.visibility).toBe('public');
  });

  it('should extract struct declarations', () => {
    const code = `
pub struct User {
    pub id: String,
    pub name: String,
    email: String,
}
`;
    const result = extractFromSource('models.rs', code);

    const structNode = result.nodes.find((n) => n.kind === 'struct');
    expect(structNode).toBeDefined();
    expect(structNode?.name).toBe('User');
  });

  it('should extract trait declarations', () => {
    const code = `
pub trait Repository {
    fn find(&self, id: &str) -> Option<Entity>;
    fn save(&mut self, entity: Entity) -> Result<(), Error>;
}
`;
    const result = extractFromSource('traits.rs', code);

    const traitNode = result.nodes.find((n) => n.kind === 'trait');
    expect(traitNode).toBeDefined();
    expect(traitNode?.name).toBe('Repository');
  });

  it('should extract impl Trait for Type as implements edges', () => {
    const code = `
pub struct MyCache {}

pub trait Cache {
    fn get(&self, key: &str) -> Option<String>;
}

impl Cache for MyCache {
    fn get(&self, key: &str) -> Option<String> {
        None
    }
}
`;
    const result = extractFromSource('cache.rs', code);

    // Should have an unresolved reference for implements
    const implRef = result.unresolvedReferences.find(
      (r) => r.referenceKind === 'implements' && r.referenceName === 'Cache',
    );
    expect(implRef).toBeDefined();

    // The struct MyCache should be the source
    const myCacheNode = result.nodes.find((n) => n.name === 'MyCache' && n.kind === 'struct');
    expect(myCacheNode).toBeDefined();
    expect(implRef?.fromNodeId).toBe(myCacheNode?.id);
  });

  it('should extract trait supertraits as extends references', () => {
    const code = `
pub trait Display {}

pub trait Error: Display {
    fn description(&self) -> &str;
}
`;
    const result = extractFromSource('error.rs', code);

    const extendsRef = result.unresolvedReferences.find(
      (r) => r.referenceKind === 'extends' && r.referenceName === 'Display',
    );
    expect(extendsRef).toBeDefined();

    const errorTrait = result.nodes.find((n) => n.name === 'Error' && n.kind === 'trait');
    expect(errorTrait).toBeDefined();
    expect(extendsRef?.fromNodeId).toBe(errorTrait?.id);
  });

  it('should not create implements edges for plain impl blocks', () => {
    const code = `
pub struct Counter {
    count: u32,
}

impl Counter {
    pub fn new() -> Counter {
        Counter { count: 0 }
    }
    pub fn increment(&mut self) {
        self.count += 1;
    }
}
`;
    const result = extractFromSource('counter.rs', code);

    // Should have no implements references (no trait involved)
    const implRefs = result.unresolvedReferences.filter((r) => r.referenceKind === 'implements');
    expect(implRefs).toHaveLength(0);
  });

  it('should emit field_access references for Rust `obj.field` reads (F#9)', () => {
    const code = `
struct Counter {
    count: u32,
    limit: u32,
}

impl Counter {
    pub fn step(&self) -> u32 {
        let c = self.count;
        let l = self.limit;
        if c < l { c + 1 } else { l }
    }

    pub fn get_count(&self) -> u32 {
        // Bare-expression return of a field read.
        self.count
    }

    pub fn ping(&self, other: &Counter) {
        // Method-call receivers MUST NOT emit field_access.
        // Only the .count field on other should produce a field_access edge.
        other.report(other.count);
    }

    pub fn report(&self, _value: u32) {}
}
`;
    const result = extractFromSource('counter.rs', code);

    const fieldAccessRefs = result.unresolvedReferences.filter((r) => r.referenceKind === 'field_access');
    // Reads expected: self.count + self.limit (in step), self.count (in
    // get_count), other.count (in ping). 4 total.
    expect(fieldAccessRefs.length).toBeGreaterThanOrEqual(4);
    expect(fieldAccessRefs.filter((r) => r.referenceName === 'count').length).toBeGreaterThanOrEqual(3);
    expect(fieldAccessRefs.some((r) => r.referenceName === 'limit')).toBe(true);

    // Sanity: method-call receivers (`other.report(...)`) must NOT emit
    // field_access — the receiver expression is captured by the `calls`
    // edge instead. The skip-if-parent-is-call_expression check in
    // captureBodyFieldAccess guarantees this.
    expect(fieldAccessRefs.some((r) => r.referenceName === 'report')).toBe(false);
  });

  it('should emit instantiates references for Rust struct_expression construction (F#9)', () => {
    const code = `
struct Counter {
    count: u32,
    limit: u32,
}

mod sub {
    pub struct Inner { pub n: u32 }
}

fn make_counter() -> Counter {
    // Plain struct_expression — name child is a type_identifier.
    Counter { count: 0, limit: 100 }
}

fn make_scoped() -> sub::Inner {
    // Scoped struct_expression — name child is a scoped_type_identifier.
    // tsExtractInstantiation strips the path prefix and keeps the trailing
    // type name.
    sub::Inner { n: 42 }
}

fn make_via_new() -> Counter {
    // Counter::new() parses as call_expression — counted as 'calls',
    // not 'instantiates'. Verifies the boundary between the two edges.
    Counter::new()
}
`;
    const result = extractFromSource('mk.rs', code);

    const instRefs = result.unresolvedReferences.filter((r) => r.referenceKind === 'instantiates');
    expect(instRefs.length).toBeGreaterThanOrEqual(2);
    expect(instRefs.some((r) => r.referenceName === 'Counter')).toBe(true);
    expect(instRefs.some((r) => r.referenceName === 'Inner')).toBe(true);

    // Counter::new() must NOT show up as instantiates — it's a 'calls' edge.
    // The `make_via_new` fn's only Counter mention is the call to
    // Counter::new(), so any `Counter` instantiates ref on that line is
    // a false positive. There IS a legitimate `Counter` instantiates ref
    // from `make_counter` (line 12) — that one is allowed; the filter
    // below targets only the line-23 site.
    const newCallInst = instRefs.filter((r) => r.referenceName === 'new' || r.line === 23);
    expect(newCallInst.length).toBe(0);
  });

  it('should emit references for Rust SCREAMING_SNAKE_CASE constant reads (F#9)', () => {
    const code = `
const MAX_RETRIES: u32 = 5;
const DEFAULT_NAME: &str = "alice";
static GLOBAL_FLAG: bool = false;

fn use_constants() -> u32 {
    // Multiple bare reads collapse to one entry with siteCount > 1.
    let a = MAX_RETRIES * 2;
    let b = MAX_RETRIES + 1;
    a + b
}

fn check_flag(name: &str) -> bool {
    // Bare reads in binary expressions.
    name == DEFAULT_NAME && GLOBAL_FLAG
}

fn declare_local() -> u32 {
    // LHS pattern of let must NOT emit a self-reference. The RHS
    // bare read of MAX_RETRIES MUST still emit.
    let LOCAL_FOO: u32 = MAX_RETRIES;
    LOCAL_FOO
}

fn nested() {
    // Scoped reference (CONFIG::DEFAULT_VALUE) — emits a reference to
    // the trailing SCREAMING_SNAKE name (DEFAULT_VALUE). The path
    // prefix CONFIG isn't SCREAMING_SNAKE-with-underscore, so it's
    // filtered by the regex.
    let _x = CONFIG::DEFAULT_VALUE;
}
`;
    const result = extractFromSource('consts.rs', code);
    const refs = result.unresolvedReferences.filter((r) => r.referenceKind === 'references');
    const refNames = new Set(refs.map((r) => r.referenceName));

    // Bare reads of module-scope constants should show up.
    expect(refNames.has('MAX_RETRIES')).toBe(true);
    expect(refNames.has('DEFAULT_NAME')).toBe(true);
    expect(refNames.has('GLOBAL_FLAG')).toBe(true);
    expect(refNames.has('DEFAULT_VALUE')).toBe(true);

    // The two reads of MAX_RETRIES in use_constants must collapse via
    // dedupeReferences into one entry with siteCount >= 2 (sites are
    // counted exactly even if EXTRA_SITES_CAP limits the stored sample).
    // The let-RHS read in declare_local has a DIFFERENT fromNodeId
    // (different enclosing function) and therefore stays as a separate
    // dedupe key — so MAX_RETRIES appears in at least two entries total
    // (use_constants's collapsed entry, and declare_local's RHS read).
    const maxRetriesRefs = refs.filter((r) => r.referenceName === 'MAX_RETRIES');
    expect(maxRetriesRefs.length).toBeGreaterThanOrEqual(2);
    const useConstantsRef = maxRetriesRefs.find((r) => (r.siteCount ?? 1) >= 2);
    expect(useConstantsRef).toBeDefined();

    // The declaration site of LOCAL_FOO must NOT emit. LOCAL_FOO's only
    // legitimate emit is the bare-return read at the end of declare_local.
    // declare_local has TWO LOCAL_FOO identifier nodes (let LHS + return);
    // the LHS is filtered by isRustDeclBindingPosition, the return read
    // emits — and there's only one (fromId, kind, name) triple after
    // dedupe.
    const localFooRefs = refs.filter((r) => r.referenceName === 'LOCAL_FOO');
    expect(localFooRefs.length).toBe(1);
    // The emitted line should be the return position, not the let line.
    // (The fixture's `let LOCAL_FOO` is at line 21, the bare `LOCAL_FOO`
    // return is at line 22 in this string.)
    expect(localFooRefs[0]?.line).toBeGreaterThanOrEqual(22);

    // The module-level const/static declarations themselves must NOT
    // emit self-references. captureBodyConstantReads runs only inside
    // function bodies, so module-scope `const MAX_RETRIES = 5;` should
    // not produce a references row from line 2's declaration. Verify
    // by checking that no MAX_RETRIES ref sits on the declaration line.
    expect(refs.find((r) => r.referenceName === 'MAX_RETRIES' && r.line === 2)).toBeUndefined();
  });

  it('does NOT double-emit references for scoped SCREAMING-name calls (F#9)', () => {
    // `mod::SCREAMING_FN()` parses with the trailing identifier nested
    // inside a `scoped_identifier` that is the call's function field.
    // The direct-parent callee check doesn't fire (parent is
    // scoped_identifier, not call_expression) — isScopedCalleeDescendant
    // walks the chain and suppresses the spurious references emit so
    // only the `calls` edge survives.
    const code = `
mod helpers {
    pub fn SCREAMING_FN() -> u32 { 0 }
}

fn caller() -> u32 {
    helpers::SCREAMING_FN()
}

fn nested_caller() -> u32 {
    // Two-level nesting: foo::bar::SCREAMING_FN — the trailing name
    // must still skip the references emit.
    helpers::sub::SCREAMING_FN()
}
`;
    const result = extractFromSource('paths.rs', code);
    const refs = result.unresolvedReferences;
    // No `references` row for the call-position SCREAMING_FN (would be a
    // double-emit since the calls edge already covers the use).
    const screamingAsRefs = refs.filter(
      (r) => r.referenceKind === 'references' && r.referenceName.endsWith('SCREAMING_FN'),
    );
    expect(screamingAsRefs).toHaveLength(0);
    // Sanity: the `calls` edge IS present (otherwise the fixture doesn't
    // exercise the scoped-callee path at all). The Rust call extractor
    // preserves the full path (`helpers::SCREAMING_FN`) in the reference
    // name; the resolver later strips to the trailing identifier.
    const screamingCalls = refs.filter((r) => r.referenceKind === 'calls' && r.referenceName.endsWith('SCREAMING_FN'));
    expect(screamingCalls.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Java Extraction', () => {
  it('should extract class declarations', () => {
    const code = `
public class UserService {
    private final UserRepository repository;

    public UserService(UserRepository repository) {
        this.repository = repository;
    }

    public User getUser(String id) {
        return repository.findById(id);
    }
}
`;
    const result = extractFromSource('UserService.java', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('UserService');
    expect(classNode?.visibility).toBe('public');
  });

  it('should extract method declarations', () => {
    const code = `
public class Calculator {
    public static int add(int a, int b) {
        return a + b;
    }
}
`;
    const result = extractFromSource('Calculator.java', code);

    const methodNode = result.nodes.find((n) => n.kind === 'method' && n.name === 'add');
    expect(methodNode).toBeDefined();
    expect(methodNode?.isStatic).toBe(true);
  });
});

describe('C# Extraction', () => {
  it('should extract class declarations', () => {
    const code = `
public class OrderService
{
    private readonly IOrderRepository _repository;

    public OrderService(IOrderRepository repository)
    {
        _repository = repository;
    }

    public async Task<Order> GetOrderAsync(string id)
    {
        return await _repository.FindByIdAsync(id);
    }
}
`;
    const result = extractFromSource('OrderService.cs', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('OrderService');
    expect(classNode?.visibility).toBe('public');
  });

  it('extracts C# 12 primary constructors as constructor-shaped methods', () => {
    const code = `
public class OrderService(IOrderRepository repository, ILogger<OrderService> logger) : BaseService(repository)
{
    public async Task<Order> GetOrderAsync(string id)
    {
        logger.LogInformation(id);
        return await repository.FindByIdAsync(id);
    }
}
`;
    const result = extractFromSource('OrderService.cs', code);

    const classNode = result.nodes.find((n) => n.kind === 'class' && n.name === 'OrderService');
    expect(classNode).toBeDefined();

    const constructorNode = result.nodes.find((n) => n.kind === 'method' && n.name === 'OrderService');
    expect(constructorNode).toBeDefined();
    expect(constructorNode?.qualifiedName).toBe('OrderService::OrderService');
    expect(constructorNode?.signature).toBe('(IOrderRepository repository, ILogger<OrderService> logger)');
    expect(
      result.edges.find((e) => e.kind === 'contains' && e.source === classNode?.id && e.target === constructorNode?.id),
    ).toBeDefined();

    const constructorTypeRefs = result.unresolvedReferences
      .filter((r) => r.fromNodeId === constructorNode?.id && r.referenceKind === 'type_of')
      .map((r) => r.referenceName);
    expect(constructorTypeRefs).toEqual(expect.arrayContaining(['IOrderRepository', 'ILogger', 'OrderService']));
    expect(constructorTypeRefs).not.toContain('repository');
    expect(constructorTypeRefs).not.toContain('logger');

    const extendsRefs = result.unresolvedReferences
      .filter((r) => r.fromNodeId === classNode?.id && r.referenceKind === 'extends')
      .map((r) => r.referenceName);
    expect(extendsRefs).toEqual(['BaseService']);

    const methodNode = result.nodes.find((n) => n.kind === 'method' && n.name === 'GetOrderAsync');
    expect(methodNode).toBeDefined();
    const returnRefs = result.unresolvedReferences
      .filter((r) => r.fromNodeId === methodNode?.id && r.referenceKind === 'returns')
      .map((r) => r.referenceName);
    expect(returnRefs).toEqual(expect.arrayContaining(['Task', 'Order']));
  });
});

describe('PHP Extraction', () => {
  it('should extract class declarations', () => {
    const code = `<?php

class UserController
{
    private UserService $userService;

    public function __construct(UserService $userService)
    {
        $this->userService = $userService;
    }

    public function show(string $id): User
    {
        return $this->userService->find($id);
    }
}
`;
    const result = extractFromSource('UserController.php', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('UserController');
  });

  it('should extract class inheritance (extends) and interface implementation', () => {
    const code = `<?php

class ChildController extends BaseController implements Serializable, JsonSerializable
{
    public function serialize(): string
    {
        return json_encode($this);
    }
}
`;
    const result = extractFromSource('ChildController.php', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('ChildController');

    const extendsRef = result.unresolvedReferences.find((r) => r.referenceKind === 'extends');
    expect(extendsRef).toBeDefined();
    expect(extendsRef?.referenceName).toBe('BaseController');

    const implementsRefs = result.unresolvedReferences.filter((r) => r.referenceKind === 'implements');
    expect(implementsRefs.length).toBe(2);
    expect(implementsRefs.map((r) => r.referenceName)).toContain('Serializable');
    expect(implementsRefs.map((r) => r.referenceName)).toContain('JsonSerializable');
  });
});

describe('Swift Extraction', () => {
  it('should extract class declarations', () => {
    const code = `
public class NetworkManager {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func fetchData(from url: URL) async throws -> Data {
        let (data, _) = try await session.data(from: url)
        return data
    }
}
`;
    const result = extractFromSource('NetworkManager.swift', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('NetworkManager');
  });

  it('should extract function declarations', () => {
    const code = `
func calculateSum(_ numbers: [Int]) -> Int {
    return numbers.reduce(0, +)
}

public func formatCurrency(amount: Double) -> String {
    return String(format: "$%.2f", amount)
}
`;
    const result = extractFromSource('utils.swift', code);

    const functions = result.nodes.filter((n) => n.kind === 'function');
    expect(functions.length).toBeGreaterThanOrEqual(1);
  });

  it('should extract struct declarations', () => {
    const code = `
public struct User {
    let id: UUID
    var name: String
    var email: String

    func displayName() -> String {
        return name
    }
}
`;
    const result = extractFromSource('User.swift', code);

    const structNode = result.nodes.find((n) => n.kind === 'struct');
    expect(structNode).toBeDefined();
    expect(structNode?.name).toBe('User');
  });

  it('should extract protocol declarations', () => {
    const code = `
public protocol Repository {
    associatedtype Entity

    func find(id: String) async throws -> Entity?
    func save(_ entity: Entity) async throws
}
`;
    const result = extractFromSource('Repository.swift', code);

    const protocolNode = result.nodes.find((n) => n.kind === 'interface');
    expect(protocolNode).toBeDefined();
    expect(protocolNode?.name).toBe('Repository');
  });

  it('should extract class inheritance and protocol conformance', () => {
    const code = `
class DataRequest: Request {
    func validate() {}
}

class UploadRequest: DataRequest, Sendable {
    func upload() {}
}

enum AFError: Error {
    case invalidURL
}

struct HTTPMethod: RawRepresentable {
    let rawValue: String
}

protocol UploadConvertible: URLRequestConvertible {
    func asURLRequest() throws -> URLRequest
}
`;
    const result = extractFromSource('Inheritance.swift', code);

    const extendsRefs = result.unresolvedReferences.filter((r) => r.referenceKind === 'extends');

    // DataRequest extends Request
    expect(extendsRefs.find((r) => r.referenceName === 'Request')).toBeDefined();
    // UploadRequest extends DataRequest and Sendable
    expect(extendsRefs.find((r) => r.referenceName === 'DataRequest')).toBeDefined();
    expect(extendsRefs.find((r) => r.referenceName === 'Sendable')).toBeDefined();
    // AFError extends Error
    expect(extendsRefs.find((r) => r.referenceName === 'Error')).toBeDefined();
    // HTTPMethod extends RawRepresentable
    expect(extendsRefs.find((r) => r.referenceName === 'RawRepresentable')).toBeDefined();
    // UploadConvertible extends URLRequestConvertible
    expect(extendsRefs.find((r) => r.referenceName === 'URLRequestConvertible')).toBeDefined();
  });
});

describe('Kotlin Extraction', () => {
  it('should extract class declarations', () => {
    const code = `
class UserRepository(private val database: Database) {
    fun findById(id: String): User? {
        return database.query("SELECT * FROM users WHERE id = ?", id)
    }

    suspend fun save(user: User) {
        database.insert(user)
    }
}
`;
    const result = extractFromSource('UserRepository.kt', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('UserRepository');
  });

  it('should extract function declarations', () => {
    const code = `
fun calculateTotal(items: List<Item>): Double {
    return items.sumOf { it.price }
}

suspend fun fetchUserData(userId: String): User {
    return api.getUser(userId)
}
`;
    const result = extractFromSource('utils.kt', code);

    const functions = result.nodes.filter((n) => n.kind === 'function');
    expect(functions.length).toBeGreaterThanOrEqual(1);
  });

  it('should detect suspend functions as async', () => {
    const code = `
suspend fun loadData(): List<String> {
    delay(1000)
    return listOf("a", "b", "c")
}
`;
    const result = extractFromSource('loader.kt', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function');
    expect(funcNode).toBeDefined();
    expect(funcNode?.isAsync).toBe(true);
  });

  it('should extract fun interface declarations', () => {
    const code = `
fun interface OnObjectRetainedListener {
  fun onObjectRetained()
}
`;
    const result = extractFromSource('listener.kt', code);

    const ifaceNode = result.nodes.find((n) => n.kind === 'interface');
    expect(ifaceNode).toBeDefined();
    expect(ifaceNode?.name).toBe('OnObjectRetainedListener');

    const methodNode = result.nodes.find((n) => n.kind === 'method');
    expect(methodNode).toBeDefined();
    expect(methodNode?.name).toBe('onObjectRetained');
    expect(methodNode?.qualifiedName).toBe('OnObjectRetainedListener::onObjectRetained');
  });

  it('should extract complex fun interface with nested classes', () => {
    const code = `
fun interface EventListener {
  fun onEvent(event: Event)

  sealed class Event {
    class DumpingHeap : Event()
  }
}
`;
    const result = extractFromSource('events.kt', code);

    const ifaceNode = result.nodes.find((n) => n.kind === 'interface');
    expect(ifaceNode).toBeDefined();
    expect(ifaceNode?.name).toBe('EventListener');

    // Nested sealed class should still be extracted (as sibling due to grammar limitations)
    const eventClass = result.nodes.find((n) => n.kind === 'class' && n.name === 'Event');
    expect(eventClass).toBeDefined();

    const dumpingHeap = result.nodes.find((n) => n.kind === 'class' && n.name === 'DumpingHeap');
    expect(dumpingHeap).toBeDefined();
  });

  it('should not affect regular function declarations', () => {
    const code = `
fun interface MyCallback {
  fun invoke(value: Int)
}

fun regularFunction(): String {
  return "hello"
}
`;
    const result = extractFromSource('mixed.kt', code);

    const ifaceNode = result.nodes.find((n) => n.kind === 'interface');
    expect(ifaceNode).toBeDefined();
    expect(ifaceNode?.name).toBe('MyCallback');

    const funcNode = result.nodes.find((n) => n.kind === 'function');
    expect(funcNode).toBeDefined();
    expect(funcNode?.name).toBe('regularFunction');
  });

  it('should extract fun interface with annotation on method (Pattern 2b)', () => {
    // When the SAM method has annotations like @Throws, tree-sitter produces a different
    // misparse: function_declaration > ERROR("interface Name {") instead of
    // function_declaration > user_type("interface"). This is the OkHttp Interceptor pattern.
    const code = `
import java.io.IOException

fun interface Interceptor {
  @Throws(IOException::class)
  fun intercept(chain: Chain): Response
}
`;
    const result = extractFromSource('interceptor.kt', code);

    const ifaceNode = result.nodes.find((n) => n.kind === 'interface');
    expect(ifaceNode).toBeDefined();
    expect(ifaceNode?.name).toBe('Interceptor');
  });

  it('should extract methods from interface with nested fun interface', () => {
    // When an interface contains a nested `fun interface`, tree-sitter misparsed
    // the parent body as ERROR. Methods inside should still be extracted.
    const code = `
interface WebSocket {
  fun request(): Request
  fun send(text: String): Boolean
  fun cancel()
  fun interface Factory {
    fun newWebSocket(request: Request): WebSocket
  }
}
`;
    const result = extractFromSource('websocket.kt', code);

    const wsIface = result.nodes.find((n) => n.kind === 'interface' && n.name === 'WebSocket');
    expect(wsIface).toBeDefined();

    const methods = result.nodes.filter((n) => n.kind === 'method' && n.qualifiedName?.startsWith('WebSocket::'));
    const methodNames = methods.map((m) => m.name);
    expect(methodNames).toContain('request');
    expect(methodNames).toContain('send');
    expect(methodNames).toContain('cancel');
  });
});

describe('Dart Extraction', () => {
  it('should extract class declarations', () => {
    const code = `
class UserService {
  final Database _db;

  Future<User> findById(String id) async {
    return await _db.query(id);
  }

  void _privateMethod() {}
}
`;
    const result = extractFromSource('service.dart', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('UserService');
    expect(classNode?.visibility).toBe('public');

    const methodNodes = result.nodes.filter((n) => n.kind === 'method');
    expect(methodNodes.length).toBeGreaterThanOrEqual(2);

    const findById = methodNodes.find((m) => m.name === 'findById');
    expect(findById).toBeDefined();
    expect(findById?.isAsync).toBe(true);

    const privateMethod = methodNodes.find((m) => m.name === '_privateMethod');
    expect(privateMethod).toBeDefined();
    expect(privateMethod?.visibility).toBe('private');
  });

  it('should extract top-level function declarations', () => {
    const code = `
void topLevelFunction(String name) {
  print(name);
}
`;
    const result = extractFromSource('utils.dart', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function');
    expect(funcNode).toBeDefined();
    expect(funcNode?.name).toBe('topLevelFunction');
    expect(funcNode?.language).toBe('dart');
  });

  it('should extract enum declarations', () => {
    const code = `
enum Status { active, inactive, pending }
`;
    const result = extractFromSource('models.dart', code);

    const enumNode = result.nodes.find((n) => n.kind === 'enum');
    expect(enumNode).toBeDefined();
    expect(enumNode?.name).toBe('Status');
  });

  it('should extract mixin declarations', () => {
    const code = `
mixin LoggerMixin {
  void log(String message) {}
}
`;
    const result = extractFromSource('mixins.dart', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('LoggerMixin');

    const methodNode = result.nodes.find((n) => n.kind === 'method');
    expect(methodNode).toBeDefined();
    expect(methodNode?.name).toBe('log');
  });

  it('should extract extension declarations', () => {
    const code = `
extension StringExt on String {
  bool get isBlank => trim().isEmpty;
}
`;
    const result = extractFromSource('extensions.dart', code);

    const classNode = result.nodes.find((n) => n.kind === 'class');
    expect(classNode).toBeDefined();
    expect(classNode?.name).toBe('StringExt');
  });

  it('should detect static methods', () => {
    const code = `
class Utils {
  static void doWork() {}
}
`;
    const result = extractFromSource('utils.dart', code);

    const methodNode = result.nodes.find((n) => n.kind === 'method');
    expect(methodNode).toBeDefined();
    expect(methodNode?.name).toBe('doWork');
    expect(methodNode?.isStatic).toBe(true);
  });

  it('should detect async functions', () => {
    const code = `
Future<String> fetchData() async {
  return await http.get('/data');
}
`;
    const result = extractFromSource('api.dart', code);

    const funcNode = result.nodes.find((n) => n.kind === 'function');
    expect(funcNode).toBeDefined();
    expect(funcNode?.name).toBe('fetchData');
    expect(funcNode?.isAsync).toBe(true);
  });

  it('should detect private visibility via underscore convention', () => {
    const code = `
void _privateHelper() {}

void publicFunction() {}
`;
    const result = extractFromSource('helpers.dart', code);

    const functions = result.nodes.filter((n) => n.kind === 'function');
    const privateFunc = functions.find((f) => f.name === '_privateHelper');
    const publicFunc = functions.find((f) => f.name === 'publicFunction');

    expect(privateFunc?.visibility).toBe('private');
    expect(publicFunc?.visibility).toBe('public');
  });
});

describe('Import Extraction', () => {
  describe('TypeScript/JavaScript imports', () => {
    it('should extract default imports', () => {
      const code = `import React from 'react';`;
      const result = extractFromSource('app.tsx', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('react');
      expect(importNode?.signature).toBe("import React from 'react';");
    });

    it('should extract named imports', () => {
      const code = `import { Bug, Database } from '@phosphor-icons/react';`;
      const result = extractFromSource('icons.tsx', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('@phosphor-icons/react');
      expect(importNode?.signature).toContain('Bug');
      expect(importNode?.signature).toContain('Database');
    });

    it('should extract namespace imports', () => {
      const code = `import * as Icons from '@phosphor-icons/react';`;
      const result = extractFromSource('icons.tsx', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('@phosphor-icons/react');
      expect(importNode?.signature).toContain('* as Icons');
    });

    it('should extract side-effect imports', () => {
      const code = `import './styles.css';`;
      const result = extractFromSource('app.tsx', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('./styles.css');
    });

    it('should extract mixed imports (default + named)', () => {
      const code = `import React, { useState, useEffect } from 'react';`;
      const result = extractFromSource('app.tsx', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('react');
      expect(importNode?.signature).toContain('React');
      expect(importNode?.signature).toContain('useState');
      expect(importNode?.signature).toContain('useEffect');
    });

    it('should extract multiple import statements', () => {
      const code = `
import React from 'react';
import { Button } from './components';
import './styles.css';
`;
      const result = extractFromSource('app.tsx', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('react');
      expect(names).toContain('./components');
      expect(names).toContain('./styles.css');
    });

    it('should extract wrapped dynamic import and require string arguments', () => {
      const code = `
export async function loadDynamic() {
  const a = await import('cast-dynamic-pkg' as string);
  const b = await import(('paren-dynamic-pkg'));
  const c = await import('satisfies-dynamic-pkg' satisfies string);
  const d = require('cast-require-pkg' as string);
  return { a, b, c, d };
}
`;
      const result = extractFromSource('dynamic.ts', code);

      const importNames = result.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
      expect(importNames).toContain('cast-dynamic-pkg');
      expect(importNames).toContain('paren-dynamic-pkg');
      expect(importNames).toContain('satisfies-dynamic-pkg');
      expect(importNames).toContain('cast-require-pkg');
    });

    it('should extract type imports', () => {
      const code = `import type { FC, ReactNode } from 'react';`;
      const result = extractFromSource('types.ts', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('react');
      expect(importNode?.signature).toContain('type');
      expect(importNode?.signature).toContain('FC');
    });

    it('should emit references for type imports', () => {
      const code = `import type { FC, ReactNode } from 'react';`;
      const result = extractFromSource('types.ts', code);

      const typeOnlyRefs = result.unresolvedReferences.filter((r) => r.referenceKind === 'references');
      expect(typeOnlyRefs.length).toBe(2);
      expect(typeOnlyRefs.map((r) => r.referenceName).sort(byString)).toEqual(['FC', 'ReactNode']);
    });

    it('should emit references for mixed type imports', () => {
      const code = `import { Bar, type Baz } from './module';`;
      const result = extractFromSource('test.ts', code);

      const refs = result.unresolvedReferences.filter((r) => r.referenceKind === 'references');
      expect(refs.length).toBe(2);
      expect(refs.map((r) => r.referenceName).sort(byString)).toEqual(['Bar', 'Baz']);
    });

    it('should extract aliased named imports', () => {
      const code = `import { useState as useStateAlias } from 'react';`;
      const result = extractFromSource('hooks.ts', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('react');
      expect(importNode?.signature).toContain('useState');
      expect(importNode?.signature).toContain('useStateAlias');
    });

    it('should extract relative path imports', () => {
      const code = `import { helper } from '../utils/helper';`;
      const result = extractFromSource('components/Button.tsx', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('../utils/helper');
      expect(importNode?.signature).toContain('helper');
    });
  });

  describe('Python imports', () => {
    it('should extract simple import statement', () => {
      const code = `import json`;
      const result = extractFromSource('utils.py', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('json');
    });

    it('should extract from import statement', () => {
      const code = `from os import path`;
      const result = extractFromSource('utils.py', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('os');
      expect(importNode?.signature).toContain('path');
    });

    it('should extract multiple imports from same module', () => {
      const code = `from typing import List, Dict, Optional`;
      const result = extractFromSource('types.py', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('typing');
      expect(importNode?.signature).toContain('List');
      expect(importNode?.signature).toContain('Dict');
    });

    it('should extract multiple import statements', () => {
      const code = `
import os
import sys
`;
      const result = extractFromSource('main.py', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(2);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('os');
      expect(names).toContain('sys');
    });

    it('should extract aliased import', () => {
      const code = `import numpy as np`;
      const result = extractFromSource('data.py', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('numpy');
      expect(importNode?.signature).toContain('as np');
    });

    it('should extract relative import', () => {
      const code = `from .utils import helper`;
      const result = extractFromSource('module.py', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('.utils');
      expect(importNode?.signature).toContain('helper');
    });

    it('should extract wildcard import', () => {
      const code = `from typing import *`;
      const result = extractFromSource('types.py', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('typing');
      expect(importNode?.signature).toContain('*');
    });
  });

  describe('Rust imports', () => {
    it('should extract simple use declaration', () => {
      const code = `use std::io;`;
      const result = extractFromSource('main.rs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('std');
      expect(importNode?.signature).toBe('use std::io;');
    });

    it('should extract scoped use list', () => {
      const code = `use std::{ffi::OsStr, io, path::Path};`;
      const result = extractFromSource('main.rs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('std');
      expect(importNode?.signature).toContain('ffi::OsStr');
      expect(importNode?.signature).toContain('path::Path');
    });

    it('should extract crate imports', () => {
      const code = `use crate::error::Error;`;
      const result = extractFromSource('lib.rs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('crate');
    });

    it('should extract super imports', () => {
      const code = `use super::utils;`;
      const result = extractFromSource('submod.rs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('super');
    });

    it('should extract external crate imports', () => {
      const code = `use serde::{Serialize, Deserialize};`;
      const result = extractFromSource('types.rs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('serde');
      expect(importNode?.signature).toContain('Serialize');
      expect(importNode?.signature).toContain('Deserialize');
    });
  });

  describe('Go imports', () => {
    it('should extract single import', () => {
      const code = `
package main

import "fmt"
`;
      const result = extractFromSource('main.go', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('fmt');
    });

    it('should extract grouped imports', () => {
      const code = `
package main

import (
	"fmt"
	"os"
	"encoding/json"
)
`;
      const result = extractFromSource('main.go', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('fmt');
      expect(names).toContain('os');
      expect(names).toContain('encoding/json');
    });

    it('should extract aliased import', () => {
      const code = `
package main

import f "fmt"
`;
      const result = extractFromSource('main.go', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('fmt');
      expect(importNode?.signature).toContain('f');
    });

    it('should extract dot import', () => {
      const code = `
package main

import . "math"
`;
      const result = extractFromSource('main.go', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('math');
      expect(importNode?.signature).toContain('.');
    });

    it('should extract blank import', () => {
      const code = `
package main

import _ "github.com/go-sql-driver/mysql"
`;
      const result = extractFromSource('main.go', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('github.com/go-sql-driver/mysql');
      expect(importNode?.signature).toContain('_');
    });

    it('enriches the cgo `import "C"` signature so the bridge is recognisable', () => {
      // ollama bug-hunt UX-3: the bare `"C"` import was opaque in imports
      // tables — no way to tell a cgo bridge from a one-character package
      // name without re-grepping the source.
      const code = `
package main

// #include <stdio.h>
import "C"
`;
      const result = extractFromSource('cgo.go', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('C');
      expect(importNode?.signature).toContain('cgo pseudo-import');
    });

    it('does NOT enrich non-cgo imports whose path happens to be a single character', () => {
      // Only the literal `"C"` qualifies. Other single-letter packages
      // (e.g. an aliased import below or a real package named `c`) stay
      // untouched.
      const code = `
package main

import c "fmt"
`;
      const result = extractFromSource('main.go', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode?.signature ?? '').not.toContain('cgo pseudo-import');
    });
  });

  describe('Swift imports', () => {
    it('should extract simple import', () => {
      const code = `import Foundation`;
      const result = extractFromSource('main.swift', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('Foundation');
      expect(importNode?.signature).toBe('import Foundation');
    });

    it('should extract @testable import', () => {
      const code = `@testable import Alamofire`;
      const result = extractFromSource('Tests.swift', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('Alamofire');
      expect(importNode?.signature).toContain('@testable');
    });

    it('should extract @preconcurrency import', () => {
      const code = `@preconcurrency import Security`;
      const result = extractFromSource('Auth.swift', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('Security');
    });

    it('should extract multiple imports', () => {
      const code = `
import Foundation
import UIKit
import Alamofire
`;
      const result = extractFromSource('App.swift', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('Foundation');
      expect(names).toContain('UIKit');
      expect(names).toContain('Alamofire');
    });
  });

  describe('Kotlin imports', () => {
    it('should extract simple import', () => {
      const code = `import java.io.IOException`;
      const result = extractFromSource('Main.kt', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('java.io.IOException');
      expect(importNode?.signature).toBe('import java.io.IOException');
    });

    it('should extract aliased import', () => {
      const code = `import okhttp3.Request.Builder as RequestBuilder`;
      const result = extractFromSource('Utils.kt', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('okhttp3.Request.Builder');
      expect(importNode?.signature).toContain('as RequestBuilder');
    });

    it('should extract wildcard import', () => {
      const code = `import java.util.concurrent.TimeUnit.*`;
      const result = extractFromSource('Time.kt', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('java.util.concurrent.TimeUnit');
      expect(importNode?.signature).toContain('.*');
    });

    it('should extract multiple imports', () => {
      const code = `
import java.io.IOException
import kotlin.test.assertFailsWith
import okhttp3.OkHttpClient
`;
      const result = extractFromSource('Test.kt', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('java.io.IOException');
      expect(names).toContain('kotlin.test.assertFailsWith');
      expect(names).toContain('okhttp3.OkHttpClient');
    });
  });

  describe('Java imports', () => {
    it('should extract simple import', () => {
      const code = `import java.util.List;`;
      const result = extractFromSource('Main.java', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('java.util.List');
      expect(importNode?.signature).toBe('import java.util.List;');
    });

    it('should extract static import', () => {
      const code = `import static java.util.Collections.emptyList;`;
      const result = extractFromSource('Utils.java', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('java.util.Collections.emptyList');
      expect(importNode?.signature).toContain('static');
    });

    it('should extract wildcard import', () => {
      const code = `import java.util.*;`;
      const result = extractFromSource('App.java', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('java.util');
      expect(importNode?.signature).toContain('.*');
    });

    it('should extract nested class import', () => {
      const code = `import java.util.Map.Entry;`;
      const result = extractFromSource('MapUtil.java', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('java.util.Map.Entry');
    });

    it('should extract multiple imports', () => {
      const code = `
import java.util.List;
import java.util.Map;
import java.io.IOException;
`;
      const result = extractFromSource('Service.java', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('java.util.List');
      expect(names).toContain('java.util.Map');
      expect(names).toContain('java.io.IOException');
    });
  });

  describe('C# imports', () => {
    it('should extract simple using', () => {
      const code = `using System;`;
      const result = extractFromSource('Program.cs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('System');
      expect(importNode?.signature).toBe('using System;');
    });

    it('should extract qualified using', () => {
      const code = `using System.Collections.Generic;`;
      const result = extractFromSource('Utils.cs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('System.Collections.Generic');
    });

    it('should extract static using', () => {
      const code = `using static System.Console;`;
      const result = extractFromSource('App.cs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('System.Console');
      expect(importNode?.signature).toContain('static');
    });

    it('should extract alias using', () => {
      const code = `using MyList = System.Collections.Generic.List<int>;`;
      const result = extractFromSource('Types.cs', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('System.Collections.Generic.List<int>');
      expect(importNode?.signature).toContain('MyList =');
    });

    it('should extract multiple usings', () => {
      const code = `
using System;
using System.Threading.Tasks;
using Microsoft.Extensions.DependencyInjection;
`;
      const result = extractFromSource('Service.cs', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('System');
      expect(names).toContain('System.Threading.Tasks');
      expect(names).toContain('Microsoft.Extensions.DependencyInjection');
    });
  });

  describe('PHP imports', () => {
    it('should extract simple use', () => {
      const code = String.raw`<?php use PHPUnit\Framework\TestCase;`;
      const result = extractFromSource('Test.php', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe(String.raw`PHPUnit\Framework\TestCase`);
    });

    it('should extract aliased use', () => {
      const code = `<?php use Mockery as m;`;
      const result = extractFromSource('Test.php', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('Mockery');
      expect(importNode?.signature).toContain('as m');
    });

    it('should extract function use', () => {
      const code = String.raw`<?php use function Illuminate\Support\env;`;
      const result = extractFromSource('helpers.php', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe(String.raw`Illuminate\Support\env`);
      expect(importNode?.signature).toContain('function');
    });

    it('should extract grouped use', () => {
      const code = String.raw`<?php use Illuminate\Database\{Model, Builder};`;
      const result = extractFromSource('Models.php', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(2);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain(String.raw`Illuminate\Database\Model`);
      expect(names).toContain(String.raw`Illuminate\Database\Builder`);
    });

    it('should extract multiple uses', () => {
      const code = String.raw`<?php
use Illuminate\Support\Collection;
use Illuminate\Support\Str;
use Closure;
`;
      const result = extractFromSource('Service.php', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain(String.raw`Illuminate\Support\Collection`);
      expect(names).toContain(String.raw`Illuminate\Support\Str`);
      expect(names).toContain('Closure');
    });
  });

  describe('Ruby imports', () => {
    it('should extract require', () => {
      const code = `require 'json'`;
      const result = extractFromSource('app.rb', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('json');
      expect(importNode?.signature).toBe("require 'json'");
    });

    it('should extract require with path', () => {
      const code = `require 'active_support/core_ext/string'`;
      const result = extractFromSource('config.rb', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('active_support/core_ext/string');
    });

    it('should extract require_relative', () => {
      const code = `require_relative '../test_helper'`;
      const result = extractFromSource('test/my_test.rb', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('../test_helper');
      expect(importNode?.signature).toContain('require_relative');
    });

    it('should not extract non-require calls', () => {
      const code = `puts 'hello'`;
      const result = extractFromSource('app.rb', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeUndefined();
    });

    it('should extract multiple requires', () => {
      const code = `
require 'json'
require 'yaml'
require_relative 'helper'
`;
      const result = extractFromSource('lib.rb', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('json');
      expect(names).toContain('yaml');
      expect(names).toContain('helper');
    });
  });

  describe('Ruby modules', () => {
    it('should extract module as module node with containment', () => {
      const code = `
module CachedCounting
  def self.disable
    @enabled = false
  end

  def perform_increment!(key, count)
    write_cache!(key, count)
  end
end
`;
      const result = extractFromSource('concerns/cached_counting.rb', code);

      const moduleNode = result.nodes.find((n) => n.kind === 'module' && n.name === 'CachedCounting');
      expect(moduleNode).toBeDefined();
      expect(moduleNode?.qualifiedName).toBe('CachedCounting');

      // Methods inside module should have module-qualified names
      const disableMethod = result.nodes.find((n) => n.name === 'disable' && n.kind === 'method');
      expect(disableMethod).toBeDefined();
      expect(disableMethod?.qualifiedName).toBe('CachedCounting::disable');

      const incrementMethod = result.nodes.find((n) => n.name === 'perform_increment!' && n.kind === 'method');
      expect(incrementMethod).toBeDefined();
      expect(incrementMethod?.qualifiedName).toBe('CachedCounting::perform_increment!');

      // Containment edge from module to methods
      const containsEdges = result.edges.filter((e) => e.source === moduleNode?.id && e.kind === 'contains');
      expect(containsEdges.length).toBeGreaterThanOrEqual(2);
    });

    it('should handle nested modules with classes', () => {
      const code = `
module Discourse
  module Auth
    class AuthProvider
      def authenticate(params)
        validate(params)
      end
    end
  end
end
`;
      const result = extractFromSource('lib/auth.rb', code);

      const discourseModule = result.nodes.find((n) => n.kind === 'module' && n.name === 'Discourse');
      expect(discourseModule).toBeDefined();

      const authModule = result.nodes.find((n) => n.kind === 'module' && n.name === 'Auth');
      expect(authModule).toBeDefined();
      expect(authModule?.qualifiedName).toBe('Discourse::Auth');

      const authProvider = result.nodes.find((n) => n.kind === 'class' && n.name === 'AuthProvider');
      expect(authProvider).toBeDefined();
      expect(authProvider?.qualifiedName).toBe('Discourse::Auth::AuthProvider');

      const authMethod = result.nodes.find((n) => n.name === 'authenticate');
      expect(authMethod).toBeDefined();
      expect(authMethod?.qualifiedName).toBe('Discourse::Auth::AuthProvider::authenticate');
    });
  });

  describe('Ruby attr_* class macros (F#35)', () => {
    it('emits one `field` node per `attr_reader` / `attr_writer` / `attr_accessor` symbol arg', () => {
      const code = `
class User
  attr_reader :name, :email
  attr_writer :role
  attr_accessor :timestamp
  def call; end
end
`;
      const result = extractFromSource('app/models/user.rb', code);

      const cls = result.nodes.find((n) => n.kind === 'class' && n.name === 'User');
      expect(cls).toBeDefined();

      const fields = result.nodes.filter((n) => n.kind === 'field');
      const names = fields.map((n) => n.name).sort(byString);
      expect(names).toEqual(['email', 'name', 'role', 'timestamp']);

      // Containment edges: class → each field
      for (const f of fields) {
        const e = result.edges.find(
          (edge) => edge.kind === 'contains' && edge.source === cls?.id && edge.target === f.id,
        );
        expect(e, `missing contains edge for field ${f.name}`).toBeDefined();
      }
    });

    it('emits a `field` node for Rails `class_attribute :name`', () => {
      const code = `
class ApplicationRecord
  class_attribute :default_scope_value
end
`;
      const result = extractFromSource('app/models/application_record.rb', code);
      const field = result.nodes.find((n) => n.kind === 'field' && n.name === 'default_scope_value');
      expect(field).toBeDefined();
    });

    it('does NOT emit fields for non-accessor class macros like `validates` or `before_action`', () => {
      // Rails has many DSL macros that take :symbol args but aren't field
      // declarations (validates, before_action, scope, has_many, etc.).
      // Only the strict accessor set in RUBY_ACCESSOR_MACROS extracts.
      const code = `
class Post
  validates :title, presence: true
  before_action :authenticate
  has_many :comments
  attr_reader :real_field
end
`;
      const result = extractFromSource('app/models/post.rb', code);
      const fieldNames = result.nodes.filter((n) => n.kind === 'field').map((n) => n.name);
      expect(fieldNames).toEqual(['real_field']);
    });

    it('does NOT emit fields for accessor macros at top level (no enclosing class)', () => {
      const code = `attr_reader :stray\n`;
      const result = extractFromSource('script.rb', code);
      const fields = result.nodes.filter((n) => n.kind === 'field');
      expect(fields).toHaveLength(0);
    });
  });

  describe('Ruby constants (F#34)', () => {
    it('extracts top-level UPPERCASE = ... assignments as constant nodes', () => {
      const code = `
MODULES = [:foo, :bar]
PROTECTED_IVARS = AbstractController::Rendering::DEFAULT_PROTECTED_INSTANCE_VARIABLES.freeze
local = 1
`;
      const result = extractFromSource('actionpack/lib/action_controller/base.rb', code);

      const constants = result.nodes.filter((n) => n.kind === 'constant');
      const names = constants.map((n) => n.name);
      expect(names).toContain('MODULES');
      expect(names).toContain('PROTECTED_IVARS');
      // Lowercase identifier should remain a variable, not a constant.
      expect(names).not.toContain('local');
      const variables = result.nodes.filter((n) => n.kind === 'variable');
      expect(variables.map((n) => n.name)).toContain('local');
    });

    it('extracts class-scoped constants and records containment + signature', () => {
      const code = `
class Base
  DEFAULT_TIMEOUT = 30
  def call; end
end
`;
      const result = extractFromSource('lib/base.rb', code);

      const cls = result.nodes.find((n) => n.kind === 'class' && n.name === 'Base');
      expect(cls).toBeDefined();

      const defaultTimeout = result.nodes.find((n) => n.kind === 'constant' && n.name === 'DEFAULT_TIMEOUT');
      expect(defaultTimeout).toBeDefined();
      expect(defaultTimeout?.qualifiedName).toBe('Base::DEFAULT_TIMEOUT');
      expect(defaultTimeout?.signature).toBe('= 30');

      const containsEdge = result.edges.find(
        (e) => e.kind === 'contains' && e.source === cls?.id && e.target === defaultTimeout?.id,
      );
      expect(containsEdge).toBeDefined();
    });
  });

  describe('C #define constants (F#38)', () => {
    it('extracts a valued #define as a constant node with a signature', () => {
      const code = `#define REDIS_VERSION "8.0"\n#define OBJ_STRING 0\n`;
      const result = extractFromSource('src/server.h', code);

      const constants = result.nodes.filter((n) => n.kind === 'constant');
      const names = constants.map((n) => n.name);
      expect(names).toContain('REDIS_VERSION');
      expect(names).toContain('OBJ_STRING');

      const objString = constants.find((n) => n.name === 'OBJ_STRING');
      expect(objString?.signature).toBe('= 0');
    });

    it('extracts a flag-only #define (no value) as a constant with no signature', () => {
      const code = `#define HAVE_KQUEUE\n`;
      const result = extractFromSource('src/config.h', code);

      const constants = result.nodes.filter((n) => n.kind === 'constant');
      expect(constants.map((n) => n.name)).toContain('HAVE_KQUEUE');
      const haveKqueue = constants.find((n) => n.name === 'HAVE_KQUEUE');
      expect(haveKqueue?.signature).toBeUndefined();
    });

    it('emits `field_access` refs for C `obj->field` and `obj.field` (F#39)', () => {
      // F#39: C is the dominant arrow-deref language. Pre-fix, the
      // shared captureBodyFieldAccess dispatch had no shape registered
      // for C, so 0 field_access edges fired on any C codebase.
      const code = `
typedef struct {
  int x;
  int y;
} Point;

typedef struct {
  Point *origin;
  int count;
} Group;

int sumPoint(Point *p) {
  return p->x + p->y;
}

int groupCount(Group *g) {
  return g->origin->x + g->count;
}
`;
      const result = extractFromSource('src/server.c', code);

      const sumPoint = result.nodes.find((n) => n.name === 'sumPoint');
      const groupCount = result.nodes.find((n) => n.name === 'groupCount');
      expect(sumPoint).toBeDefined();
      expect(groupCount).toBeDefined();

      const fieldRefs = (result.unresolvedReferences ?? []).filter((r) => r.referenceKind === 'field_access');
      const sumRefs = fieldRefs.filter((r) => r.fromNodeId === sumPoint?.id).map((r) => r.referenceName);
      expect(sumRefs).toContain('x');
      expect(sumRefs).toContain('y');

      // Chained `g->origin->x` should emit BOTH `origin` and `x`.
      const groupRefs = fieldRefs.filter((r) => r.fromNodeId === groupCount?.id).map((r) => r.referenceName);
      expect(groupRefs).toContain('origin');
      expect(groupRefs).toContain('x');
      expect(groupRefs).toContain('count');
    });

    it('does NOT emit `field_access` for a method-call receiver in C++ (F#39 dedupe)', () => {
      // `obj.method()` parses as call_expression > field_expression —
      // the `parentTypesToSkip: {call_expression}` suppression keeps
      // the field-name out of the field_access stream because it's
      // already a `calls` edge.
      const code = `
struct Widget {
  int doWork() { return 0; }
  int field;
};

int use(Widget *w) {
  return w->doWork() + w->field;
}
`;
      const result = extractFromSource('src/main.cpp', code);
      const use = result.nodes.find((n) => n.name === 'use');
      const refs = (result.unresolvedReferences ?? []).filter(
        (r) => r.referenceKind === 'field_access' && r.fromNodeId === use?.id,
      );
      const names = refs.map((r) => r.referenceName);
      expect(names).toContain('field');
      expect(names).not.toContain('doWork');
    });

    it("emits a `returns` edge from a C function to its typedef'd return type (F#40)", () => {
      // F#40: tree-sitter-c carries the return type on the `type` field
      // of `function_definition`, NOT `return_type` (the default field-
      // name in `extractTypeAnnotations`). Adding `returnField: 'type'`
      // to the C extractor lets the shared type-ref walker emit
      // `returns(fn, Typedef)` for any non-builtin return type.
      const code = `
typedef struct client client_t;
client_t *getClient(int id) { return 0; }
int countClients(void) { return 0; }
`;
      const result = extractFromSource('src/server.c', code);

      const getClient = result.nodes.find((n) => n.name === 'getClient');
      expect(getClient).toBeDefined();

      const returnsEdges = result.edges.filter((e) => e.kind === 'returns' && e.source === getClient?.id);
      const referenceNames = (result.unresolvedReferences ?? [])
        .filter((r) => r.fromNodeId === getClient?.id && r.referenceKind === 'returns')
        .map((r) => r.referenceName);
      // Either resolved as an edge to client_t, or surfaced as an
      // unresolved `returns` ref naming `client_t`. Both shapes are
      // wins versus pre-fix (no signal at all).
      const hits = returnsEdges.length + referenceNames.filter((n) => n === 'client_t').length;
      expect(hits).toBeGreaterThan(0);

      // Primitive return type (`int countClients()`) must NOT trigger
      // a `returns` ref — `int` is in BUILTIN_TYPES and the type-ref
      // walker correctly suppresses it.
      const countClients = result.nodes.find((n) => n.name === 'countClients');
      const builtinRefs = (result.unresolvedReferences ?? []).filter(
        (r) => r.fromNodeId === countClients?.id && r.referenceKind === 'returns' && r.referenceName === 'int',
      );
      expect(builtinRefs).toHaveLength(0);
    });

    it('keeps C++ functions with std::string parameters named after the function', () => {
      const code = `
#include <string>

int deal_command(std::string interfaceName, int flag) {
  return 0;
}

int create_oss_version_node(string& local_ip, string& port) {
  return 0;
}

int connect_zookeeper() {
  return 0;
}
`;
      const result = extractFromSource('src/test_parser.cpp', code);
      const functions = result.nodes.filter((n) => n.kind === 'function').map((n) => n.name);

      expect(functions).toContain('deal_command');
      expect(functions).toContain('create_oss_version_node');
      expect(functions).toContain('connect_zookeeper');
      expect(result.nodes.some((n) => n.kind === 'method' && n.name === 'string')).toBe(false);
    });

    it('indexes C/C++ functions with leading export-style macros', () => {
      const code = 'API_EXPORT int api_foo(void) { return 1; }\n';
      const cResult = extractFromSource('src/api.c', code, 'c');
      const cppResult = extractFromSource('src/api.cpp', code, 'cpp');

      expect(cResult.nodes.some((n) => n.kind === 'function' && n.name === 'api_foo')).toBe(true);
      expect(cppResult.nodes.some((n) => n.kind === 'function' && n.name === 'api_foo')).toBe(true);
    });

    it('recovers C functions whose API macro and return type are split into a preceding declaration', () => {
      const code = 'AX_VIN_GLB_API AX_S32 AX_VIN_Init(AX_VOID) { return 0; }\n';
      const result = extractFromSource('src/video.c', code, 'c');

      expect(result.nodes.some((n) => n.kind === 'function' && n.name === 'AX_VIN_Init')).toBe(true);
      expect(result.nodes.some((n) => n.kind === 'function' && n.name === '(AX_VOID)')).toBe(false);
    });

    it('does not extract function-like macros (preproc_function_def) as constants', () => {
      // `#define MAX(a,b) ...` is `preproc_function_def`, NOT `preproc_def`.
      // Function-like macros behave more like callable functions and are
      // out of scope for the constant path.
      const code = `#define MAX(a,b) ((a)>(b)?(a):(b))\n#define LIMIT 100\n`;
      const result = extractFromSource('src/util.h', code);

      const constants = result.nodes.filter((n) => n.kind === 'constant');
      const names = constants.map((n) => n.name);
      expect(names).toContain('LIMIT');
      expect(names).not.toContain('MAX');
    });
  });

  describe('C/C++ imports', () => {
    it('should extract system include', () => {
      const code = `#include <iostream>`;
      const result = extractFromSource('main.cpp', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('iostream');
      expect(importNode?.signature).toBe('#include <iostream>');
    });

    it('should extract system include with path', () => {
      const code = `#include <nlohmann/json.hpp>`;
      const result = extractFromSource('app.cpp', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('nlohmann/json.hpp');
    });

    it('should extract local include', () => {
      const code = `#include "myheader.h"`;
      const result = extractFromSource('main.cpp', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('myheader.h');
    });

    it('should extract C header', () => {
      const code = `#include <stdio.h>`;
      const result = extractFromSource('main.c', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('stdio.h');
    });

    it('should extract multiple includes', () => {
      const code = `
#include <iostream>
#include <vector>
#include "config.h"
`;
      const result = extractFromSource('app.cpp', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('iostream');
      expect(names).toContain('vector');
      expect(names).toContain('config.h');
    });
  });

  describe('C++ macro-obscured class declarations', () => {
    it('recognizes class preceded by ALL_CAPS macro (simple, no base class)', () => {
      const code = `SOME_TEMPLATE_MACRO\nclass MyClass {\n  void method() {}\n};`;
      const result = extractFromSource('test.hpp', code);
      const cls = result.nodes.find((n) => n.kind === 'class');
      expect(cls).toBeDefined();
      expect(cls?.name).toBe('MyClass');
    });

    it('recognizes class preceded by macro with trailing // comment (nlohmann pattern)', () => {
      const code = [
        'NLOHMANN_BASIC_JSON_TPL_DECLARATION',
        'class basic_json // NOLINT(some-rule)',
        '    : public detail::base<T>',
        '{',
        '  void foo() {}',
        '};',
      ].join('\n');
      const result = extractFromSource('json.hpp', code);
      const cls = result.nodes.find((n) => n.kind === 'class');
      expect(cls).toBeDefined();
      expect(cls?.name).toBe('basic_json');
    });

    it('recognizes struct preceded by ALL_CAPS macro', () => {
      const code = `MY_MACRO\nstruct my_struct {\n  int x;\n};`;
      const result = extractFromSource('test.hpp', code);
      const s = result.nodes.find((n) => n.kind === 'struct');
      expect(s).toBeDefined();
      expect(s?.name).toBe('my_struct');
    });

    it('extracts member methods in class scope (not as top-level functions)', () => {
      const code = `TMPL_MACRO\nclass Container {\n  void push() {}\n  void pop() {}\n};`;
      const result = extractFromSource('test.hpp', code);
      const cls = result.nodes.find((n) => n.kind === 'class' && n.name === 'Container');
      expect(cls).toBeDefined();
      const methods = result.nodes.filter((n) => n.kind === 'method');
      expect(methods.length).toBeGreaterThanOrEqual(1);
    });

    it('does NOT misclassify a lowercase-prefix function as macro-obscured class', () => {
      const code = `myMacro\nclass Foo {\n};`;
      const result = extractFromSource('test.hpp', code);
      // lowercase prefix — should NOT be detected as a macro-obscured class
      const cls = result.nodes.find((n) => n.kind === 'class' && n.name === 'Foo');
      expect(cls).toBeUndefined();
    });

    it('does NOT regress on a regular template class with inline template<>', () => {
      const code = `template<typename T>\nclass Vec {\n  void push() {}\n};`;
      const result = extractFromSource('test.hpp', code);
      const cls = result.nodes.find((n) => n.kind === 'class');
      expect(cls).toBeDefined();
      expect(cls?.name).toBe('Vec');
    });

    it('does NOT regress on a regular class without template', () => {
      const code = `class Simple {\n  void method() {}\n};`;
      const result = extractFromSource('test.hpp', code);
      const cls = result.nodes.find((n) => n.kind === 'class');
      expect(cls).toBeDefined();
      expect(cls?.name).toBe('Simple');
    });
  });

  describe('Dart imports', () => {
    it('should extract dart: import', () => {
      const code = `import 'dart:async';`;
      const result = extractFromSource('main.dart', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('dart:async');
      expect(importNode?.signature).toBe("import 'dart:async';");
    });

    it('should extract package import', () => {
      const code = `import 'package:flutter/material.dart';`;
      const result = extractFromSource('app.dart', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('package:flutter/material.dart');
    });

    it('should extract aliased import', () => {
      const code = `import 'package:http/http.dart' as http;`;
      const result = extractFromSource('api.dart', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('package:http/http.dart');
      expect(importNode?.signature).toContain('as http');
    });

    it('should extract multiple imports', () => {
      const code = `
import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
`;
      const result = extractFromSource('main.dart', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('dart:async');
      expect(names).toContain('dart:convert');
      expect(names).toContain('package:flutter/material.dart');
    });

    it('should extract relative import', () => {
      const code = `import '../utils/helpers.dart';`;
      const result = extractFromSource('lib/main.dart', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('../utils/helpers.dart');
    });
  });

  describe('Liquid imports', () => {
    it('should extract render tag', () => {
      const code = `{% render 'loading-spinner' %}`;
      const result = extractFromSource('template.liquid', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('loading-spinner');
      expect(importNode?.signature).toContain('render');
    });

    it('should extract section tag', () => {
      const code = `{% section 'header' %}`;
      const result = extractFromSource('layout/theme.liquid', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('header');
      expect(importNode?.signature).toContain('section');
    });

    it('should extract include tag', () => {
      const code = `{% include 'icon-cart' %}`;
      const result = extractFromSource('snippets/header.liquid', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('icon-cart');
      expect(importNode?.signature).toContain('include');
    });

    it('should extract render with whitespace control', () => {
      const code = `{%- render 'price' -%}`;
      const result = extractFromSource('snippets/product.liquid', code);

      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode).toBeDefined();
      expect(importNode?.name).toBe('price');
    });

    it('should extract multiple imports', () => {
      const code = `
{% section 'header' %}
{% render 'loading-spinner' %}
{% render 'cart-drawer' %}
`;
      const result = extractFromSource('layout/theme.liquid', code);

      const importNodes = result.nodes.filter((n) => n.kind === 'import');
      expect(importNodes.length).toBe(3);

      const names = importNodes.map((n) => n.name);
      expect(names).toContain('header');
      expect(names).toContain('loading-spinner');
      expect(names).toContain('cart-drawer');
    });

    it('falls back to a string schema node name when localized schema names are malformed', () => {
      const code = `
{% schema %}
{ "name": { "en": 404, "fr": false } }
{% endschema %}
`;
      const result = extractFromSource('sections/product.liquid', code);

      const schemaNode = result.nodes.find((n) => n.kind === 'constant' && n.qualifiedName.includes('::schema:'));
      expect(schemaNode?.name).toBe('schema');
      expect(typeof schemaNode?.name).toBe('string');
    });

    it('extracts localized Liquid schema names from the English string when present', () => {
      const code = `
{% schema %}
{ "name": { "fr": "Produit", "en": "Product card" } }
{% endschema %}
`;
      const result = extractFromSource('sections/product-card.liquid', code);

      const schemaNode = result.nodes.find((n) => n.kind === 'constant' && n.qualifiedName.includes('::schema:'));
      expect(schemaNode?.name).toBe('Product card');
    });
  });
});

// =============================================================================
// Pascal / Delphi Extraction
// =============================================================================

describe('Pascal / Delphi Extraction', () => {
  describe('Language detection', () => {
    it('should detect Pascal files', () => {
      expect(detectLanguage('UAuth.pas')).toBe('pascal');
      expect(detectLanguage('App.dpr')).toBe('pascal');
      expect(detectLanguage('Package.dpk')).toBe('pascal');
      expect(detectLanguage('App.lpr')).toBe('pascal');
      expect(detectLanguage('MainForm.dfm')).toBe('pascal');
      expect(detectLanguage('MainForm.fmx')).toBe('pascal');
    });

    it('should report Pascal as supported', () => {
      expect(isLanguageSupported('pascal')).toBe(true);
      expect(getSupportedLanguages()).toContain('pascal');
    });
  });

  describe('Unit extraction', () => {
    it('should extract unit as module', () => {
      const code = `unit MyUnit;\ninterface\nimplementation\nend.`;
      const result = extractFromSource('MyUnit.pas', code);

      const moduleNode = result.nodes.find((n) => n.kind === 'module');
      expect(moduleNode).toBeDefined();
      expect(moduleNode?.name).toBe('MyUnit');
      expect(moduleNode?.language).toBe('pascal');
    });

    it('should extract program as module', () => {
      const code = `program MyApp;\nbegin\nend.`;
      const result = extractFromSource('MyApp.dpr', code);

      const moduleNode = result.nodes.find((n) => n.kind === 'module');
      expect(moduleNode).toBeDefined();
      expect(moduleNode?.name).toBe('MyApp');
    });

    it('should fallback to filename when module name is empty', () => {
      // Some .dpr templates use "program;" without a name
      const code = `program;\nuses SysUtils;\nbegin\nend.`;
      const result = extractFromSource('Console.dpr', code);

      const moduleNode = result.nodes.find((n) => n.kind === 'module');
      expect(moduleNode).toBeDefined();
      expect(moduleNode?.name).toBe('Console');
    });
  });

  describe('Uses clause (imports)', () => {
    it('should extract uses as individual imports', () => {
      const code = `unit Test;\ninterface\nuses\n  System.SysUtils,\n  System.Classes;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const imports = result.nodes.filter((n) => n.kind === 'import');
      expect(imports.length).toBe(2);
      expect(imports.map((n) => n.name)).toContain('System.SysUtils');
      expect(imports.map((n) => n.name)).toContain('System.Classes');
    });

    it('should create unresolved references for imports', () => {
      const code = `unit Test;\ninterface\nuses\n  UAuth;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const importRef = result.unresolvedReferences.find((r) => r.referenceKind === 'imports');
      expect(importRef).toBeDefined();
      expect(importRef?.referenceName).toBe('UAuth');
    });
  });

  describe('Class extraction', () => {
    it('should extract class declarations', () => {
      const code = `unit Test;\ninterface\ntype\n  TMyClass = class\n  public\n    procedure DoSomething;\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const classNode = result.nodes.find((n) => n.kind === 'class');
      expect(classNode).toBeDefined();
      expect(classNode?.name).toBe('TMyClass');
    });

    it('should extract class with inheritance', () => {
      const code = `unit Test;\ninterface\ntype\n  TChild = class(TParent)\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const extendsRef = result.unresolvedReferences.find((r) => r.referenceKind === 'extends');
      expect(extendsRef).toBeDefined();
      expect(extendsRef?.referenceName).toBe('TParent');
    });

    it('should extract class with interface implementation', () => {
      const code = `unit Test;\ninterface\ntype\n  TService = class(TInterfacedObject, ILogger)\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const extendsRef = result.unresolvedReferences.find((r) => r.referenceKind === 'extends');
      const implementsRef = result.unresolvedReferences.find((r) => r.referenceKind === 'implements');
      expect(extendsRef?.referenceName).toBe('TInterfacedObject');
      expect(implementsRef?.referenceName).toBe('ILogger');
    });
  });

  describe('Record extraction', () => {
    it('should extract records as class nodes', () => {
      const code = `unit Test;\ninterface\ntype\n  TPoint = record\n    X: Double;\n    Y: Double;\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const classNode = result.nodes.find((n) => n.kind === 'class');
      expect(classNode).toBeDefined();
      expect(classNode?.name).toBe('TPoint');

      const fields = result.nodes.filter((n) => n.kind === 'field');
      expect(fields.length).toBe(2);
      expect(fields.map((f) => f.name)).toContain('X');
      expect(fields.map((f) => f.name)).toContain('Y');
    });
  });

  describe('Interface extraction', () => {
    it('should extract interface declarations', () => {
      const code = `unit Test;\ninterface\ntype\n  ILogger = interface\n    procedure Log(const AMsg: string);\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const ifaceNode = result.nodes.find((n) => n.kind === 'interface');
      expect(ifaceNode).toBeDefined();
      expect(ifaceNode?.name).toBe('ILogger');
    });
  });

  describe('Method extraction', () => {
    it('should extract methods with visibility', () => {
      const code = `unit Test;\ninterface\ntype\n  TMyClass = class\n  private\n    FValue: Integer;\n  public\n    constructor Create;\n    function GetValue: Integer;\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const methods = result.nodes.filter((n) => n.kind === 'method');
      expect(methods.length).toBe(2);

      const createMethod = methods.find((m) => m.name === 'Create');
      expect(createMethod?.visibility).toBe('public');

      const getValue = methods.find((m) => m.name === 'GetValue');
      expect(getValue?.visibility).toBe('public');

      const fields = result.nodes.filter((n) => n.kind === 'field');
      const fValue = fields.find((f) => f.name === 'FValue');
      expect(fValue?.visibility).toBe('private');
    });

    it('should detect static methods (class methods)', () => {
      const code = `unit Test;\ninterface\ntype\n  THelper = class\n  public\n    class function Create: THelper; static;\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const methods = result.nodes.filter((n) => n.kind === 'method');
      const staticMethod = methods.find((m) => m.name === 'Create');
      expect(staticMethod?.isStatic).toBe(true);
    });
  });

  describe('Enum extraction', () => {
    it('should extract enums with members', () => {
      const code = `unit Test;\ninterface\ntype\n  TColor = (clRed, clGreen, clBlue);\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const enumNode = result.nodes.find((n) => n.kind === 'enum');
      expect(enumNode).toBeDefined();
      expect(enumNode?.name).toBe('TColor');

      const members = result.nodes.filter((n) => n.kind === 'enum_member');
      expect(members.length).toBe(3);
      expect(members.map((m) => m.name)).toEqual(['clRed', 'clGreen', 'clBlue']);
    });
  });

  describe('Property extraction', () => {
    it('should extract properties', () => {
      const code = `unit Test;\ninterface\ntype\n  TObj = class\n  public\n    property Name: string read FName write FName;\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const propNode = result.nodes.find((n) => n.kind === 'property');
      expect(propNode).toBeDefined();
      expect(propNode?.name).toBe('Name');
      expect(propNode?.visibility).toBe('public');
    });
  });

  describe('Constant extraction', () => {
    it('should extract constants', () => {
      const code = `unit Test;\ninterface\nconst\n  MAX_RETRIES = 3;\n  APP_NAME = 'MyApp';\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const constants = result.nodes.filter((n) => n.kind === 'constant');
      expect(constants.length).toBe(2);
      expect(constants.map((c) => c.name)).toContain('MAX_RETRIES');
      expect(constants.map((c) => c.name)).toContain('APP_NAME');
    });
  });

  describe('Type alias extraction', () => {
    it('should extract type aliases', () => {
      const code = `unit Test;\ninterface\ntype\n  TUserName = string;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const aliasNode = result.nodes.find((n) => n.kind === 'type_alias');
      expect(aliasNode).toBeDefined();
      expect(aliasNode?.name).toBe('TUserName');
    });
  });

  describe('Call extraction', () => {
    it('should extract calls from implementation bodies', () => {
      const code = `unit Test;\ninterface\ntype\n  TObj = class\n  public\n    procedure DoWork;\n  end;\nimplementation\nprocedure TObj.DoWork;\nbegin\n  WriteLn('hello');\nend;\nend.`;
      const result = extractFromSource('Test.pas', code);

      const callRef = result.unresolvedReferences.find((r) => r.referenceKind === 'calls');
      expect(callRef).toBeDefined();
      expect(callRef?.referenceName).toBe('WriteLn');
    });
  });

  describe('Containment edges', () => {
    it('should create contains edges for class members', () => {
      const code = `unit Test;\ninterface\ntype\n  TObj = class\n  public\n    procedure Foo;\n  end;\nimplementation\nend.`;
      const result = extractFromSource('Test.pas', code);

      const classNode = result.nodes.find((n) => n.kind === 'class');
      const methodNode = result.nodes.find((n) => n.kind === 'method');
      expect(classNode).toBeDefined();
      expect(methodNode).toBeDefined();

      const containsEdge = result.edges.find(
        (e) => e.source === classNode?.id && e.target === methodNode?.id && e.kind === 'contains',
      );
      expect(containsEdge).toBeDefined();
    });
  });

  describe('Full fixture: UAuth.pas', () => {
    const code = `unit UAuth;

interface

uses
  System.SysUtils,
  System.Classes;

type
  ITokenValidator = interface
    ['{11111111-1111-1111-1111-111111111111}']
    function Validate(const AToken: string): Boolean;
  end;

  TAuthService = class(TInterfacedObject, ITokenValidator)
  private
    FToken: string;
    FLoginCount: Integer;
    procedure IncLoginCount;
  protected
    function GetToken: string;
  public
    constructor Create;
    destructor Destroy; override;
    function Validate(const AToken: string): Boolean;
    function Login(const AUser, APass: string): string;
    property Token: string read GetToken;
    property LoginCount: Integer read FLoginCount;
  end;

implementation

constructor TAuthService.Create;
begin
  inherited Create;
  FToken := '';
  FLoginCount := 0;
end;

destructor TAuthService.Destroy;
begin
  FToken := '';
  inherited Destroy;
end;

procedure TAuthService.IncLoginCount;
begin
  Inc(FLoginCount);
end;

function TAuthService.GetToken: string;
begin
  Result := FToken;
end;

function TAuthService.Validate(const AToken: string): Boolean;
begin
  Result := AToken <> '';
end;

function TAuthService.Login(const AUser, APass: string): string;
begin
  IncLoginCount;
  if Validate(AUser + ':' + APass) then
  begin
    FToken := AUser;
    Result := 'ok';
  end
  else
    Result := '';
end;

end.`;

    it('should extract all expected nodes', () => {
      const result = extractFromSource('UAuth.pas', code);

      expect(result.errors).toHaveLength(0);

      // Module
      const moduleNode = result.nodes.find((n) => n.kind === 'module');
      expect(moduleNode?.name).toBe('UAuth');

      // Imports
      const imports = result.nodes.filter((n) => n.kind === 'import');
      expect(imports.length).toBe(2);

      // Interface
      const ifaceNode = result.nodes.find((n) => n.kind === 'interface');
      expect(ifaceNode?.name).toBe('ITokenValidator');

      // Class
      const classNode = result.nodes.find((n) => n.kind === 'class');
      expect(classNode?.name).toBe('TAuthService');

      // Methods
      const methods = result.nodes.filter((n) => n.kind === 'method');
      expect(methods.length).toBeGreaterThanOrEqual(6);
      expect(methods.map((m) => m.name)).toContain('Create');
      expect(methods.map((m) => m.name)).toContain('Destroy');
      expect(methods.map((m) => m.name)).toContain('Login');

      // Fields
      const fields = result.nodes.filter((n) => n.kind === 'field');
      expect(fields.length).toBe(2);
      expect(fields.every((f) => f.visibility === 'private')).toBe(true);

      // Properties
      const props = result.nodes.filter((n) => n.kind === 'property');
      expect(props.length).toBe(2);
      expect(props.map((p) => p.name)).toContain('Token');
      expect(props.map((p) => p.name)).toContain('LoginCount');
    });

    it('should extract inheritance and interface implementation', () => {
      const result = extractFromSource('UAuth.pas', code);

      const extendsRef = result.unresolvedReferences.find((r) => r.referenceKind === 'extends');
      expect(extendsRef?.referenceName).toBe('TInterfacedObject');

      const implementsRef = result.unresolvedReferences.find((r) => r.referenceKind === 'implements');
      expect(implementsRef?.referenceName).toBe('ITokenValidator');
    });

    it('should extract calls from implementation', () => {
      const result = extractFromSource('UAuth.pas', code);

      const callRefs = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls');
      expect(callRefs.map((r) => r.referenceName)).toContain('Inc');
      expect(callRefs.map((r) => r.referenceName)).toContain('Validate');
    });
  });

  describe('Full fixture: UTypes.pas', () => {
    const code = `unit UTypes;

interface

uses
  System.SysUtils;

const
  C_MAX_RETRIES = 3;
  C_DEFAULT_NAME = 'Guest';

type
  TUserRole = (urAdmin, urEditor, urViewer);

  TPoint2D = record
    X: Double;
    Y: Double;
  end;

  TUserName = string;

  TUserInfo = class
  public
    type
      TAddress = record
        Street: string;
        City: string;
        Zip: string;
      end;
  private
    FName: TUserName;
    FRole: TUserRole;
    FAddress: TAddress;
  public
    constructor Create(const AName: TUserName; ARole: TUserRole);
    function GetDisplayName: string;
    class function CreateAdmin(const AName: TUserName): TUserInfo; static;
    property Name: TUserName read FName write FName;
    property Role: TUserRole read FRole;
    property Address: TAddress read FAddress write FAddress;
  end;

implementation

constructor TUserInfo.Create(const AName: TUserName; ARole: TUserRole);
begin
  FName := AName;
  FRole := ARole;
end;

function TUserInfo.GetDisplayName: string;
begin
  if FRole = urAdmin then
    Result := '[Admin] ' + FName
  else
    Result := FName;
end;

class function TUserInfo.CreateAdmin(const AName: TUserName): TUserInfo;
begin
  Result := TUserInfo.Create(AName, urAdmin);
end;

end.`;

    it('should extract enums with members', () => {
      const result = extractFromSource('UTypes.pas', code);

      const enumNode = result.nodes.find((n) => n.kind === 'enum');
      expect(enumNode?.name).toBe('TUserRole');

      const members = result.nodes.filter((n) => n.kind === 'enum_member');
      expect(members.length).toBe(3);
      expect(members.map((m) => m.name)).toEqual(['urAdmin', 'urEditor', 'urViewer']);
    });

    it('should extract constants', () => {
      const result = extractFromSource('UTypes.pas', code);

      const constants = result.nodes.filter((n) => n.kind === 'constant');
      expect(constants.length).toBe(2);
      expect(constants.map((c) => c.name)).toContain('C_MAX_RETRIES');
      expect(constants.map((c) => c.name)).toContain('C_DEFAULT_NAME');
    });

    it('should extract type aliases', () => {
      const result = extractFromSource('UTypes.pas', code);

      const aliases = result.nodes.filter((n) => n.kind === 'type_alias');
      expect(aliases.map((a) => a.name)).toContain('TUserName');
    });

    it('should extract records as classes with fields', () => {
      const result = extractFromSource('UTypes.pas', code);

      const classes = result.nodes.filter((n) => n.kind === 'class');
      expect(classes.map((c) => c.name)).toContain('TPoint2D');

      // TPoint2D fields
      const fields = result.nodes.filter((n) => n.kind === 'field');
      expect(fields.map((f) => f.name)).toContain('X');
      expect(fields.map((f) => f.name)).toContain('Y');
    });

    it('should extract static class methods', () => {
      const result = extractFromSource('UTypes.pas', code);

      const methods = result.nodes.filter((n) => n.kind === 'method');
      const staticMethod = methods.find((m) => m.name === 'CreateAdmin');
      expect(staticMethod).toBeDefined();
      expect(staticMethod?.isStatic).toBe(true);
    });

    it('should extract nested types', () => {
      const result = extractFromSource('UTypes.pas', code);

      const classes = result.nodes.filter((n) => n.kind === 'class');
      expect(classes.map((c) => c.name)).toContain('TAddress');
    });
  });
});

// =============================================================================
// DFM/FMX Extraction
// =============================================================================

describe('DFM/FMX Extraction', () => {
  it('should extract components from DFM', () => {
    const code = `object Form1: TForm1
  Left = 0
  Top = 0
  Caption = 'My Form'
  object Button1: TButton
    Left = 10
    Top = 10
    Caption = 'Click Me'
  end
end`;
    const result = extractFromSource('Form1.dfm', code);

    const components = result.nodes.filter((n) => n.kind === 'component');
    expect(components.length).toBe(2);
    expect(components.map((c) => c.name)).toContain('Form1');
    expect(components.map((c) => c.name)).toContain('Button1');

    const button = components.find((c) => c.name === 'Button1');
    expect(button?.signature).toBe('TButton');
  });

  it('should extract nested component hierarchy', () => {
    const code = `object Form1: TForm1
  object Panel1: TPanel
    object Label1: TLabel
      Caption = 'Hello'
    end
  end
end`;
    const result = extractFromSource('Form1.dfm', code);

    const components = result.nodes.filter((n) => n.kind === 'component');
    expect(components.length).toBe(3);

    // Check nesting: Panel1 contains Label1
    const panel = components.find((c) => c.name === 'Panel1');
    const label = components.find((c) => c.name === 'Label1');
    const containsEdge = result.edges.find(
      (e) => e.source === panel?.id && e.target === label?.id && e.kind === 'contains',
    );
    expect(containsEdge).toBeDefined();
  });

  it('should extract event handler references', () => {
    const code = `object Form1: TForm1
  OnCreate = FormCreate
  OnDestroy = FormDestroy
  object Button1: TButton
    OnClick = Button1Click
  end
end`;
    const result = extractFromSource('Form1.dfm', code);

    const refs = result.unresolvedReferences;
    expect(refs.length).toBe(3);
    expect(refs.map((r) => r.referenceName)).toContain('FormCreate');
    expect(refs.map((r) => r.referenceName)).toContain('FormDestroy');
    expect(refs.map((r) => r.referenceName)).toContain('Button1Click');
    expect(refs.every((r) => r.referenceKind === 'references')).toBe(true);
  });

  it('should handle multi-line properties', () => {
    const code = `object Form1: TForm1
  SQL.Strings = (
    'SELECT * FROM users'
    'WHERE active = 1')
  object Button1: TButton
    OnClick = Button1Click
  end
end`;
    const result = extractFromSource('Form1.dfm', code);

    const components = result.nodes.filter((n) => n.kind === 'component');
    expect(components.length).toBe(2);

    const refs = result.unresolvedReferences;
    expect(refs.length).toBe(1);
    expect(refs[0]?.referenceName).toBe('Button1Click');
  });

  it('should handle inherited keyword', () => {
    const code = `inherited Form1: TForm1
  Caption = 'Inherited Form'
  object Button1: TButton
    OnClick = Button1Click
  end
end`;
    const result = extractFromSource('Form1.dfm', code);

    const components = result.nodes.filter((n) => n.kind === 'component');
    expect(components.length).toBe(2);
    expect(components.map((c) => c.name)).toContain('Form1');
  });

  it('should handle item collection properties', () => {
    const code = `object Form1: TForm1
  object StatusBar1: TStatusBar
    Panels = <
      item
        Width = 200
      end
      item
        Width = 200
      end>
  end
end`;
    const result = extractFromSource('Form1.dfm', code);

    const components = result.nodes.filter((n) => n.kind === 'component');
    expect(components.length).toBe(2);
  });

  describe('Full fixture: MainForm.dfm', () => {
    const code = `object frmMain: TfrmMain
  Left = 0
  Top = 0
  Caption = 'Cartograph DFM Fixture'
  ClientHeight = 480
  ClientWidth = 640
  OnCreate = FormCreate
  OnDestroy = FormDestroy
  object pnlTop: TPanel
    Left = 0
    Top = 0
    Width = 640
    Height = 50
    object lblTitle: TLabel
      Left = 16
      Top = 16
      Caption = 'Authentication Service'
    end
    object btnLogin: TButton
      Left = 540
      Top = 12
      OnClick = btnLoginClick
    end
  end
  object pnlContent: TPanel
    Left = 0
    Top = 50
    object edtUsername: TEdit
      Left = 16
      Top = 16
      OnChange = edtUsernameChange
    end
    object edtPassword: TEdit
      Left = 16
      Top = 48
      OnKeyPress = edtPasswordKeyPress
    end
    object mmoLog: TMemo
      Left = 16
      Top = 88
    end
  end
  object pnlStatus: TStatusBar
    Left = 0
    Top = 440
    Panels = <
      item
        Width = 200
      end
      item
        Width = 200
      end>
  end
end`;

    it('should extract all components', () => {
      const result = extractFromSource('MainForm.dfm', code);

      const components = result.nodes.filter((n) => n.kind === 'component');
      expect(components.length).toBe(9);
      expect(components.map((c) => c.name)).toEqual(
        expect.arrayContaining([
          'frmMain',
          'pnlTop',
          'lblTitle',
          'btnLogin',
          'pnlContent',
          'edtUsername',
          'edtPassword',
          'mmoLog',
          'pnlStatus',
        ]),
      );
    });

    it('should extract all event handlers', () => {
      const result = extractFromSource('MainForm.dfm', code);

      const refs = result.unresolvedReferences;
      expect(refs.length).toBe(5);
      expect(refs.map((r) => r.referenceName)).toEqual(
        expect.arrayContaining([
          'FormCreate',
          'FormDestroy',
          'btnLoginClick',
          'edtUsernameChange',
          'edtPasswordKeyPress',
        ]),
      );
    });
  });
});

describe('Full Indexing', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should index a TypeScript file', async () => {
    // Create test file
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(
      path.join(srcDir, 'utils.ts'),
      `
export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
`,
    );

    // Initialize and index
    const cg = Cartograph.initSync(tempDir);
    const result = await cg.indexAll();

    expect(result.success).toBe(true);
    expect(result.filesIndexed).toBe(1);
    expect(result.nodesCreated).toBeGreaterThanOrEqual(2);

    // Check nodes were stored
    const nodes = cg.queries.getNodesByFile('src/utils.ts');
    expect(nodes.length).toBeGreaterThanOrEqual(2);

    const addFunc = nodes.find((n) => n.name === 'add');
    expect(addFunc).toBeDefined();
    expect(addFunc?.kind).toBe('function');

    cg.close();
  });

  it('should index multiple files', async () => {
    // Create test files
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);

    fs.writeFileSync(path.join(srcDir, 'math.ts'), `export function add(a: number, b: number) { return a + b; }`);

    fs.writeFileSync(
      path.join(srcDir, 'string.ts'),
      `export function capitalize(s: string) { return s.toUpperCase(); }`,
    );

    // Initialize and index
    const cg = Cartograph.initSync(tempDir);
    const result = await cg.indexAll();

    expect(result.success).toBe(true);
    expect(result.filesIndexed).toBe(2);

    const files = getAllFiles(cg.queries);
    expect(files.length).toBe(2);

    cg.close();
  });

  it('should track file hashes for incremental updates', async () => {
    // Create initial file
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'main.ts'), `export const x = 1;`);

    // Initialize and index
    const cg = Cartograph.initSync(tempDir);
    await cg.indexAll();

    // Check file is tracked
    const file = getFileByPath(cg.queries, 'src/main.ts');
    expect(file).toBeDefined();
    expect(file?.contentHash).toBeDefined();

    // Modify file
    fs.writeFileSync(path.join(srcDir, 'main.ts'), `export const x = 2;`);

    // Check for changes
    const changes = cg.internals.orchestrator.getChangedFiles();
    expect(changes.modified).toContain('src/main.ts');

    cg.close();
  });

  it('should sync and detect changes', async () => {
    // Create initial file
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'main.ts'), `export function original() { return 1; }`);

    // Initialize and index
    const cg = Cartograph.initSync(tempDir);
    await cg.indexAll();

    const initialNodes = cg.queries.getNodesByFile('src/main.ts');
    expect(initialNodes.some((n) => n.name === 'original')).toBe(true);

    // Modify file
    fs.writeFileSync(path.join(srcDir, 'main.ts'), `export function updated() { return 2; }`);

    // Sync
    const syncResult = await cg.sync();
    expect(syncResult.filesModified).toBe(1);

    // Check nodes were updated
    const updatedNodes = cg.queries.getNodesByFile('src/main.ts');
    expect(updatedNodes.some((n) => n.name === 'updated')).toBe(true);
    expect(updatedNodes.some((n) => n.name === 'original')).toBe(false);

    cg.close();
  });
});

describe('Path Normalization', () => {
  it('should convert backslashes to forward slashes', () => {
    expect(normalizePath(String.raw`gui\node_modules\foo`)).toBe('gui/node_modules/foo');
    expect(normalizePath(String.raw`src\components\Button.tsx`)).toBe('src/components/Button.tsx');
  });

  it('should leave forward-slash paths unchanged', () => {
    expect(normalizePath('src/components/Button.tsx')).toBe('src/components/Button.tsx');
  });

  it('should handle empty string', () => {
    expect(normalizePath('')).toBe('');
  });
});

describe('Directory Exclusion', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should exclude node_modules directories', () => {
    // Create structure: src/index.ts + node_modules/pkg/index.js
    const srcDir = path.join(tempDir, 'src');
    const nmDir = path.join(tempDir, 'node_modules', 'pkg');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(nmDir, 'index.js'), 'module.exports = {};');

    const config = { ...DEFAULT_CONFIG, rootDir: tempDir };
    const files = scanDirectory(tempDir, config);

    expect(files).toContain('src/index.ts');
    expect(files.every((f) => !f.includes('node_modules'))).toBe(true);
  });

  it('should exclude nested node_modules directories', () => {
    // Create structure: packages/app/node_modules/pkg/index.js
    const srcDir = path.join(tempDir, 'packages', 'app', 'src');
    const nmDir = path.join(tempDir, 'packages', 'app', 'node_modules', 'pkg');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(nmDir, 'index.js'), 'module.exports = {};');

    const config = { ...DEFAULT_CONFIG, rootDir: tempDir };
    const files = scanDirectory(tempDir, config);

    expect(files).toContain('packages/app/src/index.ts');
    expect(files.every((f) => !f.includes('node_modules'))).toBe(true);
  });

  it('should exclude .git directories', () => {
    const srcDir = path.join(tempDir, 'src');
    const gitDir = path.join(tempDir, '.git', 'objects');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(gitDir, 'pack.ts'), 'export const y = 2;');

    const config = { ...DEFAULT_CONFIG, rootDir: tempDir };
    const files = scanDirectory(tempDir, config);

    expect(files).toContain('src/index.ts');
    expect(files.every((f) => !f.includes('.git'))).toBe(true);
  });

  it('survives non-UTF8 bytes in .gitignore without aborting scan', () => {
    execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
    fs.writeFileSync(
      path.join(tempDir, '.gitignore'),
      Buffer.concat([Buffer.from('src/\n'), Buffer.from([0xff, 0xfe]), Buffer.from('[bad\n')]),
    );
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'ignored.ts'), 'export const ignored = 1;\n');
    fs.writeFileSync(path.join(tempDir, 'visible.ts'), 'export const visible = 1;\n');

    const config = { ...DEFAULT_CONFIG, rootDir: tempDir, include: ['**/*.ts'], exclude: [] };
    const files = scanDirectory(tempDir, config);

    expect(files).toContain('visible.ts');
    expect(files).not.toContain('src/ignored.ts');
  });

  it('includes files from gitignored embedded repositories', () => {
    execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'embedded/\n');
    const repoDir = path.join(tempDir, 'embedded', 'repo');
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(repoDir, 'src', 'nested.ts'), 'export function nestedRepoFn() { return 1; }\n');
    fs.writeFileSync(path.join(tempDir, 'src.ts'), 'export function rootFn() { return 1; }\n');

    const config = { ...DEFAULT_CONFIG, rootDir: tempDir, include: ['**/*.ts'], exclude: [] };
    const files = scanDirectory(tempDir, config);

    expect(files).toContain('src.ts');
    expect(files).toContain('embedded/repo/src/nested.ts');
  });

  it('skips ignored embedded repositories when nested repo indexing is disabled', () => {
    execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(tempDir, '.gitignore'), 'embedded/\n');
    const repoDir = path.join(tempDir, 'embedded', 'repo');
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'pipe' });
    fs.writeFileSync(path.join(repoDir, 'src', 'nested.ts'), 'export function nestedRepoFn() { return 1; }\n');

    const files = scanDirectory(tempDir, {
      ...DEFAULT_CONFIG,
      rootDir: tempDir,
      include: ['**/*.ts'],
      exclude: [],
      indexEmbeddedRepos: false,
    });

    expect(files).not.toContain('embedded/repo/src/nested.ts');
  });

  it('should return forward-slash paths on all platforms', () => {
    const srcDir = path.join(tempDir, 'src', 'components');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'Button.tsx'), 'export function Button() {}');

    const config = { ...DEFAULT_CONFIG, rootDir: tempDir };
    const files = scanDirectory(tempDir, config);

    expect(files.length).toBe(1);
    expect(files[0]).toBe('src/components/Button.tsx');
    expect(files[0]).not.toContain('\\');
  });

  it('should respect .cartographignore marker', () => {
    const srcDir = path.join(tempDir, 'src');
    const vendorDir = path.join(tempDir, 'vendor');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(vendorDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(vendorDir, 'lib.ts'), 'export const y = 2;');
    fs.writeFileSync(path.join(vendorDir, '.cartographignore'), '');

    const config = { ...DEFAULT_CONFIG, rootDir: tempDir };
    const files = scanDirectory(tempDir, config);

    expect(files).toContain('src/index.ts');
    expect(files.every((f) => !f.includes('vendor'))).toBe(true);
  });
});

// =============================================================================
// R Extraction
// =============================================================================

describe('R Extraction', () => {
  describe('Language detection', () => {
    it('should detect R files', () => {
      expect(detectLanguage('script.R')).toBe('r');
      expect(detectLanguage('utils.r')).toBe('r');
    });

    it('should report R as supported', () => {
      expect(isLanguageSupported('r')).toBe(true);
      expect(getSupportedLanguages()).toContain('r');
    });
  });

  describe('Function extraction', () => {
    it('should extract a function defined with <-', () => {
      const code = `add <- function(a, b) {
  a + b
}`;
      const result = extractFromSource('main.R', code);
      const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'add');
      expect(fn).toBeDefined();
      expect(fn?.signature).toBe('(a, b)');
    });

    it('should extract a function defined with =', () => {
      const code = `subtract = function(a, b) a - b`;
      const result = extractFromSource('main.R', code);
      const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'subtract');
      expect(fn).toBeDefined();
    });

    it('should extract a function defined with <<-', () => {
      const code = `divide <<- function(a, b) a / b`;
      const result = extractFromSource('main.R', code);
      const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'divide');
      expect(fn).toBeDefined();
    });

    it('should extract S3 method names verbatim (period in name)', () => {
      const code = `print.myClass <- function(x, ...) cat(x$value)`;
      const result = extractFromSource('print.R', code);
      const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'print.myClass');
      expect(fn).toBeDefined();
    });

    it('should NOT emit anonymous function nodes for inline lambdas', () => {
      const code = `result <- lapply(xs, function(x) x * 2)`;
      const result = extractFromSource('main.R', code);
      expect(result.nodes.find((n) => n.kind === 'function')).toBeUndefined();
    });

    it('should attach a docstring from preceding roxygen comments', () => {
      const code = `#' Add two numbers
#' @param a numeric
#' @param b numeric
add <- function(a, b) a + b`;
      const result = extractFromSource('main.R', code);
      const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'add');
      expect(fn?.docstring).toContain('Add two numbers');
    });
  });

  describe('Call extraction', () => {
    it('should extract simple function calls inside a function body', () => {
      const code = `wrap <- function(x) {
  inner(x)
  another(x)
}`;
      const result = extractFromSource('main.R', code);
      const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'wrap')!;
      const calls = result.unresolvedReferences.filter((r) => r.fromNodeId === fn.id && r.referenceKind === 'calls');
      const calleeNames = calls.map((c) => c.referenceName);
      expect(calleeNames).toContain('inner');
      expect(calleeNames).toContain('another');
    });

    it('should preserve namespace operator in callee name (pkg::fn)', () => {
      const code = `runner <- function() {
  dplyr::filter(df, x > 0)
}`;
      const result = extractFromSource('main.R', code);
      const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'runner')!;
      const calleeNames = result.unresolvedReferences.filter((r) => r.fromNodeId === fn.id).map((r) => r.referenceName);
      expect(calleeNames).toContain('dplyr::filter');
    });
  });

  describe('Imports', () => {
    it('should extract library() with bare-identifier argument', () => {
      const code = `library(dplyr)`;
      const result = extractFromSource('main.R', code);
      const importNode = result.nodes.find((n) => n.kind === 'import');
      expect(importNode?.name).toBe('dplyr');
    });

    it('should extract library() with quoted-string argument', () => {
      const code = `library("tidyr")`;
      const result = extractFromSource('main.R', code);
      const importNode = result.nodes.find((n) => n.kind === 'import' && n.name === 'tidyr');
      expect(importNode).toBeDefined();
    });

    it('should extract require() the same way as library()', () => {
      const code = `require(ggplot2)`;
      const result = extractFromSource('main.R', code);
      const importNode = result.nodes.find((n) => n.kind === 'import' && n.name === 'ggplot2');
      expect(importNode).toBeDefined();
    });

    it('should extract source() with a string path', () => {
      const code = `source("helpers.R")`;
      const result = extractFromSource('main.R', code);
      const importNode = result.nodes.find((n) => n.kind === 'import' && n.name === 'helpers.R');
      expect(importNode).toBeDefined();
    });

    it('should not emit an import node for a dynamic source() argument', () => {
      const code = `source(paste0(BASE, "/helpers.R"))`;
      const result = extractFromSource('main.R', code);
      const imports = result.nodes.filter((n) => n.kind === 'import');
      expect(imports.length).toBe(0);
    });

    it('should unquote R 4.0+ raw string literals (round delimiter)', () => {
      const code = `source(r"(helpers.R)")`;
      const result = extractFromSource('main.R', code);
      const importNode = result.nodes.find((n) => n.kind === 'import' && n.name === 'helpers.R');
      expect(importNode).toBeDefined();
    });

    it('should unquote R raw strings with bracket and brace delimiters', () => {
      const r1 = extractFromSource('a.R', `library(R"[mypkg]")`);
      const r2 = extractFromSource('b.R', `library(r"{mypkg}")`);
      expect(r1.nodes.find((n) => n.kind === 'import' && n.name === 'mypkg')).toBeDefined();
      expect(r2.nodes.find((n) => n.kind === 'import' && n.name === 'mypkg')).toBeDefined();
    });

    it('should unquote dash-delimited raw strings used to embed quotes', () => {
      const code = `source(r"-(file.R)-")`;
      const result = extractFromSource('main.R', code);
      const importNode = result.nodes.find((n) => n.kind === 'import' && n.name === 'file.R');
      expect(importNode).toBeDefined();
    });
  });

  describe('Top-level constants', () => {
    it('should extract top-level non-function assignments as constants', () => {
      const code = `PI <- 3.14159
COLORS <- c("red", "green")`;
      const result = extractFromSource('main.R', code);
      const pi = result.nodes.find((n) => n.kind === 'constant' && n.name === 'PI');
      const colors = result.nodes.find((n) => n.kind === 'constant' && n.name === 'COLORS');
      expect(pi).toBeDefined();
      expect(colors).toBeDefined();
    });

    it('should emit variable (not constant) for assignments inside a function body', () => {
      const code = `outer <- function() {
  x <- 5
  x
}`;
      const result = extractFromSource('main.R', code);
      // Must NOT appear as a constant.
      const asConst = result.nodes.find((n) => n.kind === 'constant' && n.name === 'x');
      expect(asConst).toBeUndefined();
      // Must appear as a variable (local scope assignment).
      const asVar = result.nodes.find((n) => n.kind === 'variable' && n.name === 'x');
      expect(asVar).toBeDefined();
    });
  });
});

// HCL / Terraform Extraction
// =============================================================================

describe('HCL / Terraform Extraction', () => {
  describe('Language detection', () => {
    it('should detect HCL/Terraform files', () => {
      expect(detectLanguage('main.tf')).toBe('hcl');
      expect(detectLanguage('terraform.tfvars')).toBe('hcl');
      expect(detectLanguage('config.hcl')).toBe('hcl');
      expect(detectLanguage('main.tofu')).toBe('hcl');
    });

    it('should report HCL as supported', () => {
      expect(isLanguageSupported('hcl')).toBe(true);
      expect(getSupportedLanguages()).toContain('hcl');
    });
  });

  describe('Block extraction', () => {
    it('should extract a resource block as a resource node', () => {
      const code = `resource "aws_s3_bucket" "logs" { bucket = "my-logs" }`;
      const result = extractFromSource('main.tf', code);

      const node = result.nodes.find((n) => n.qualifiedName === 'aws_s3_bucket.logs');
      expect(node).toBeDefined();
      expect(node?.kind).toBe('resource');
      expect(node?.name).toBe('aws_s3_bucket.logs');
      expect(node?.language).toBe('hcl');
      expect(node?.signature).toBe('resource "aws_s3_bucket" "logs"');
    });

    it('should extract a data block with `data.` prefix', () => {
      const code = `data "aws_caller_identity" "current" {}`;
      const result = extractFromSource('main.tf', code);

      const node = result.nodes.find((n) => n.qualifiedName === 'data.aws_caller_identity.current');
      expect(node).toBeDefined();
      expect(node?.kind).toBe('resource');
      expect(node?.name).toBe('aws_caller_identity.current');
    });

    it('should extract a variable block', () => {
      const code = `variable "environment" { type = string }`;
      const result = extractFromSource('main.tf', code);

      const node = result.nodes.find((n) => n.qualifiedName === 'var.environment');
      expect(node).toBeDefined();
      expect(node?.kind).toBe('variable');
      expect(node?.name).toBe('environment');
    });

    it('should extract an output block as an export', () => {
      const code = `output "vpc_id" { value = "abc" }`;
      const result = extractFromSource('main.tf', code);

      const node = result.nodes.find((n) => n.qualifiedName === 'output.vpc_id');
      expect(node).toBeDefined();
      expect(node?.kind).toBe('export');
      expect(node?.name).toBe('vpc_id');
    });

    it('should extract a module block', () => {
      const code = `module "vpc" { source = "terraform-aws-modules/vpc/aws" }`;
      const result = extractFromSource('main.tf', code);

      const node = result.nodes.find((n) => n.qualifiedName === 'module.vpc');
      expect(node).toBeDefined();
      expect(node?.kind).toBe('module');
      expect(node?.name).toBe('vpc');
    });

    it('should extract a provider block as namespace', () => {
      const code = `provider "aws" { region = "us-east-1" }`;
      const result = extractFromSource('main.tf', code);

      const node = result.nodes.find((n) => n.qualifiedName === 'provider.aws');
      expect(node).toBeDefined();
      expect(node?.kind).toBe('namespace');
    });

    it('should split a locals block into one constant per attribute', () => {
      const code = `locals {
  bucket_name = "my-bucket"
  retention   = 30
}`;
      const result = extractFromSource('main.tf', code);

      const bucketName = result.nodes.find((n) => n.qualifiedName === 'local.bucket_name');
      const retention = result.nodes.find((n) => n.qualifiedName === 'local.retention');
      expect(bucketName?.kind).toBe('constant');
      expect(retention?.kind).toBe('constant');
    });

    it('should connect blocks to the file via contains edges', () => {
      const code = `resource "aws_s3_bucket" "logs" {}`;
      const result = extractFromSource('main.tf', code);

      const fileNode = result.nodes.find((n) => n.kind === 'file');
      const resourceNode = result.nodes.find((n) => n.qualifiedName === 'aws_s3_bucket.logs');
      expect(fileNode).toBeDefined();
      expect(resourceNode).toBeDefined();
      const containsEdge = result.edges.find(
        (e) => e.source === fileNode!.id && e.target === resourceNode!.id && e.kind === 'contains',
      );
      expect(containsEdge).toBeDefined();
    });
  });

  describe('Reference extraction', () => {
    it('should extract var.X references', () => {
      const code = `resource "aws_s3_bucket" "logs" { bucket = var.bucket_name }`;
      const result = extractFromSource('main.tf', code);

      const ref = result.unresolvedReferences.find((r) => r.referenceName === 'var.bucket_name');
      expect(ref).toBeDefined();
      expect(ref?.referenceKind).toBe('references');
    });

    it('should extract local.X references', () => {
      const code = `resource "aws_s3_bucket" "logs" { tags = local.common_tags }`;
      const result = extractFromSource('main.tf', code);

      const ref = result.unresolvedReferences.find((r) => r.referenceName === 'local.common_tags');
      expect(ref).toBeDefined();
    });

    it('should extract module.X references and stop at the module name', () => {
      const code = `output "vpc_id" { value = module.vpc.vpc_id }`;
      const result = extractFromSource('main.tf', code);

      const ref = result.unresolvedReferences.find((r) => r.referenceName === 'module.vpc');
      expect(ref).toBeDefined();
      // Should NOT emit a reference for the trailing attribute
      expect(result.unresolvedReferences.find((r) => r.referenceName === 'module.vpc.vpc_id')).toBeUndefined();
    });

    it('should extract data.T.N references with both labels', () => {
      const code = `output "x" { value = data.aws_caller_identity.current.account_id }`;
      const result = extractFromSource('main.tf', code);

      const ref = result.unresolvedReferences.find((r) => r.referenceName === 'data.aws_caller_identity.current');
      expect(ref).toBeDefined();
    });

    it('should extract resource references as TYPE.NAME', () => {
      const code = `resource "aws_s3_bucket_versioning" "v" { bucket = aws_s3_bucket.logs.id }`;
      const result = extractFromSource('main.tf', code);

      const ref = result.unresolvedReferences.find((r) => r.referenceName === 'aws_s3_bucket.logs');
      expect(ref).toBeDefined();
    });

    it('should extract references inside string interpolations', () => {
      const code = 'locals { name = "${var.environment}-${random_id.suffix.hex}" }';
      const result = extractFromSource('main.tf', code);

      const names = result.unresolvedReferences.map((r) => r.referenceName);
      expect(names).toContain('var.environment');
      expect(names).toContain('random_id.suffix');
    });

    it('should ignore references to count, each, self, and path', () => {
      const code = `resource "aws_instance" "web" {
  count = 3
  tags  = { Name = "web-\${count.index}", For = each.value, Self = self.id, P = path.module }
}`;
      const result = extractFromSource('main.tf', code);

      const names = result.unresolvedReferences.map((r) => r.referenceName);
      expect(names.find((n) => n.startsWith('count.'))).toBeUndefined();
      expect(names.find((n) => n.startsWith('each.'))).toBeUndefined();
      expect(names.find((n) => n.startsWith('self.'))).toBeUndefined();
      expect(names.find((n) => n.startsWith('path.'))).toBeUndefined();
    });

    it('should ignore for-loop iteration variables', () => {
      const code = `output "ids" { value = [for s in var.subnets : s.id] }`;
      const result = extractFromSource('main.tf', code);

      const names = result.unresolvedReferences.map((r) => r.referenceName);
      // var.subnets reference comes through, but `s.id` does NOT
      expect(names).toContain('var.subnets');
      expect(names.find((n) => n.startsWith('s.'))).toBeUndefined();
    });

    it('should ignore key/value bindings in for-object expressions', () => {
      const code = `locals { tags = { for k, v in var.input : k => "\${v}-suffix" } }`;
      const result = extractFromSource('main.tf', code);

      const names = result.unresolvedReferences.map((r) => r.referenceName);
      expect(names).toContain('var.input');
      expect(names.find((n) => n === 'k' || n.startsWith('k.'))).toBeUndefined();
      expect(names.find((n) => n === 'v' || n.startsWith('v.'))).toBeUndefined();
    });

    it('should emit an imports edge for module source', () => {
      const code = `module "vpc" { source = "terraform-aws-modules/vpc/aws" }`;
      const result = extractFromSource('main.tf', code);

      const importRef = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'imports' && r.referenceName === 'terraform-aws-modules/vpc/aws',
      );
      expect(importRef).toBeDefined();
    });
  });

  describe('Robustness', () => {
    it('should handle empty files', () => {
      const result = extractFromSource('main.tf', '');
      const fileNode = result.nodes.find((n) => n.kind === 'file');
      expect(fileNode).toBeDefined();
    });

    it('should handle blocks with no body', () => {
      const code = `data "aws_caller_identity" "current" {}`;
      const result = extractFromSource('main.tf', code);
      expect(result.nodes.find((n) => n.qualifiedName === 'data.aws_caller_identity.current')).toBeDefined();
    });

    it('should walk nested blocks for references without emitting child nodes', () => {
      const code = `resource "aws_s3_bucket_versioning" "v" {
  bucket = aws_s3_bucket.logs.id
  versioning_configuration {
    status = var.versioning_status
  }
}`;
      const result = extractFromSource('main.tf', code);

      // Only one block-level node, plus the file
      const blockNodes = result.nodes.filter((n) => n.kind === 'resource');
      expect(blockNodes.length).toBe(1);

      // References from the nested block should still be captured
      const names = result.unresolvedReferences.map((r) => r.referenceName);
      expect(names).toContain('aws_s3_bucket.logs');
      expect(names).toContain('var.versioning_status');
    });
  });
});

// =============================================================================
// SQL Extraction
// =============================================================================

describe('SQL Extraction', () => {
  describe('Language detection', () => {
    it('should detect SQL files', () => {
      expect(detectLanguage('schema.sql')).toBe('sql');
      expect(detectLanguage('migrations/001.ddl')).toBe('sql');
      expect(detectLanguage('seed.dml')).toBe('sql');
    });

    it('should report SQL as supported', () => {
      expect(isLanguageSupported('sql')).toBe(true);
      expect(getSupportedLanguages()).toContain('sql');
    });
  });

  describe('CREATE TABLE', () => {
    it('should extract a table as a table node', () => {
      const code = `CREATE TABLE users (id INT PRIMARY KEY, email VARCHAR(255));`;
      const result = extractFromSource('schema.sql', code);
      const node = result.nodes.find((n) => n.kind === 'table' && n.name === 'users');
      expect(node).toBeDefined();
      expect(node?.signature).toBe('CREATE TABLE users');
    });

    it('should preserve schema-qualified table names', () => {
      const code = `CREATE TABLE reporting.events (id INT);`;
      const result = extractFromSource('schema.sql', code);
      const node = result.nodes.find((n) => n.kind === 'table' && n.name === 'reporting.events');
      expect(node).toBeDefined();
    });

    it('should extract inline foreign-key references', () => {
      const code = `CREATE TABLE orders (id INT, user_id INT REFERENCES users(id));`;
      const result = extractFromSource('schema.sql', code);
      const orders = result.nodes.find((n) => n.name === 'orders')!;
      const fk = result.unresolvedReferences.find(
        (r) => r.fromNodeId === orders.id && r.referenceName === 'users' && r.referenceKind === 'references',
      );
      expect(fk).toBeDefined();
    });

    it('should extract CONSTRAINT-style foreign keys', () => {
      const code = `CREATE TABLE orders (
  id INT,
  user_id INT,
  CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);`;
      const result = extractFromSource('schema.sql', code);
      const orders = result.nodes.find((n) => n.name === 'orders')!;
      const fk = result.unresolvedReferences.find((r) => r.fromNodeId === orders.id && r.referenceName === 'users');
      expect(fk).toBeDefined();
    });

    it('should add a contains edge from the file to each table', () => {
      const code = `CREATE TABLE a (id INT); CREATE TABLE b (id INT);`;
      const result = extractFromSource('schema.sql', code);
      const file = result.nodes.find((n) => n.kind === 'file')!;
      const a = result.nodes.find((n) => n.name === 'a')!;
      const b = result.nodes.find((n) => n.name === 'b')!;
      expect(result.edges).toContainEqual(expect.objectContaining({ source: file.id, target: a.id, kind: 'contains' }));
      expect(result.edges).toContainEqual(expect.objectContaining({ source: file.id, target: b.id, kind: 'contains' }));
    });
  });

  describe('CREATE VIEW', () => {
    it('should extract a view as a table node', () => {
      const code = `CREATE VIEW active_users AS SELECT id FROM users;`;
      const result = extractFromSource('views.sql', code);
      const view = result.nodes.find((n) => n.kind === 'table' && n.name === 'active_users');
      expect(view).toBeDefined();
    });

    it('should record references to source tables in the view query', () => {
      const code = `CREATE VIEW user_orders AS
  SELECT u.id, COUNT(o.id) AS n
  FROM users u
  LEFT JOIN orders o ON o.user_id = u.id;`;
      const result = extractFromSource('views.sql', code);
      const view = result.nodes.find((n) => n.name === 'user_orders')!;
      const refs = result.unresolvedReferences.filter((r) => r.fromNodeId === view.id).map((r) => r.referenceName);
      expect(refs).toContain('users');
      expect(refs).toContain('orders');
    });

    it('should de-duplicate identical references in the same scope', () => {
      const code = `CREATE VIEW double_users AS
  SELECT * FROM users JOIN users u2 ON u2.id = users.id;`;
      const result = extractFromSource('views.sql', code);
      const view = result.nodes.find((n) => n.name === 'double_users')!;
      const usersRefs = result.unresolvedReferences.filter(
        (r) => r.fromNodeId === view.id && r.referenceName === 'users',
      );
      expect(usersRefs.length).toBe(1);
    });

    it('should walk into derived-table subqueries to find inner table refs', () => {
      const code = `CREATE VIEW v AS
  SELECT * FROM (SELECT id FROM users) u JOIN orders o ON o.user_id = u.id;`;
      const result = extractFromSource('views.sql', code);
      const view = result.nodes.find((n) => n.name === 'v')!;
      const refs = result.unresolvedReferences.filter((r) => r.fromNodeId === view.id).map((r) => r.referenceName);
      expect(refs).toContain('users');
      expect(refs).toContain('orders');
    });
  });

  describe('CREATE FUNCTION', () => {
    it('should extract a function with signature', () => {
      const code = `CREATE FUNCTION add(a INT, b INT) RETURNS INT AS 'SELECT a + b' LANGUAGE SQL;`;
      const result = extractFromSource('fns.sql', code);
      const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'add');
      expect(fn).toBeDefined();
      expect(fn?.signature).toContain('(a INT, b INT)');
    });

    it('should handle CREATE OR REPLACE FUNCTION', () => {
      const code = `CREATE OR REPLACE FUNCTION calc(x INT) RETURNS INT AS 'SELECT x * 2' LANGUAGE SQL;`;
      const result = extractFromSource('fns.sql', code);
      const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'calc');
      expect(fn).toBeDefined();
    });

    it('should label a CREATE FUNCTION signature with CREATE FUNCTION', () => {
      const code = `CREATE FUNCTION add(a INT) RETURNS INT AS 'SELECT a + 1' LANGUAGE SQL;`;
      const result = extractFromSource('fns.sql', code);
      const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'add');
      expect(fn?.signature).toContain('CREATE FUNCTION');
      expect(fn?.signature).not.toContain('CREATE PROCEDURE');
    });
  });

  describe('CREATE TRIGGER', () => {
    it('should extract a trigger with target-table reference and called function', () => {
      const code = `CREATE TRIGGER orders_audit
AFTER INSERT ON orders
FOR EACH ROW
EXECUTE FUNCTION audit_orders();`;
      const result = extractFromSource('triggers.sql', code);
      const trigger = result.nodes.find((n) => n.kind === 'function' && n.name === 'orders_audit');
      expect(trigger).toBeDefined();

      const refs = result.unresolvedReferences.filter((r) => r.fromNodeId === trigger!.id);
      const tableRef = refs.find((r) => r.referenceName === 'orders' && r.referenceKind === 'references');
      const callRef = refs.find((r) => r.referenceName === 'audit_orders' && r.referenceKind === 'calls');
      expect(tableRef).toBeDefined();
      expect(callRef).toBeDefined();
    });

    it('should still locate target/function across an UPDATE OF column list', () => {
      const code = `CREATE TRIGGER t
BEFORE UPDATE OF col1, col2 ON orders
FOR EACH ROW
EXECUTE FUNCTION audit_cols();`;
      const result = extractFromSource('triggers.sql', code);
      const trigger = result.nodes.find((n) => n.name === 't')!;
      const refs = result.unresolvedReferences.filter((r) => r.fromNodeId === trigger.id);
      expect(refs.find((r) => r.referenceName === 'orders' && r.referenceKind === 'references')).toBeDefined();
      expect(refs.find((r) => r.referenceName === 'audit_cols' && r.referenceKind === 'calls')).toBeDefined();
    });
  });

  describe('CREATE TYPE', () => {
    it('should extract an enum type as an enum node', () => {
      const code = `CREATE TYPE order_status AS ENUM ('pending', 'shipped', 'cancelled');`;
      const result = extractFromSource('types.sql', code);
      const node = result.nodes.find((n) => n.name === 'order_status');
      expect(node?.kind).toBe('enum');
    });

    it('should extract a non-enum CREATE TYPE as a type_alias', () => {
      const code = `CREATE TYPE point AS (x FLOAT, y FLOAT);`;
      const result = extractFromSource('types.sql', code);
      const node = result.nodes.find((n) => n.name === 'point');
      expect(node?.kind).toBe('type_alias');
    });
  });

  describe('CREATE SCHEMA', () => {
    it('should extract a schema as a namespace node', () => {
      const code = `CREATE SCHEMA reporting;`;
      const result = extractFromSource('schemas.sql', code);
      const node = result.nodes.find((n) => n.name === 'reporting');
      expect(node?.kind).toBe('namespace');
    });
  });

  describe('Robustness', () => {
    it('should not error on plain SELECT/INSERT/UPDATE statements', () => {
      const code = `SELECT * FROM users;
INSERT INTO orders (id) VALUES (1);
UPDATE users SET email = 'x';`;
      const result = extractFromSource('queries.sql', code);
      expect(result.errors.filter((e) => e.severity === 'error').length).toBe(0);
      const nonFile = result.nodes.filter((n) => n.kind !== 'file');
      expect(nonFile.length).toBe(0);
    });

    it('should not emit nodes for CREATE INDEX', () => {
      const code = `CREATE INDEX idx_users_email ON users(email);`;
      const result = extractFromSource('idx.sql', code);
      const nonFile = result.nodes.filter((n) => n.kind !== 'file');
      expect(nonFile.length).toBe(0);
    });

    it('should handle multiple statements without leaking state', () => {
      const code = `CREATE TABLE a (id INT);
CREATE TABLE b (id INT, a_id INT REFERENCES a(id));
CREATE VIEW c AS SELECT * FROM a JOIN b ON b.a_id = a.id;`;
      const result = extractFromSource('multi.sql', code);
      const a = result.nodes.find((n) => n.name === 'a');
      const b = result.nodes.find((n) => n.name === 'b');
      const c = result.nodes.find((n) => n.name === 'c');
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(c).toBeDefined();

      const bRefs = result.unresolvedReferences.filter((r) => r.fromNodeId === b!.id);
      const cRefs = result.unresolvedReferences.filter((r) => r.fromNodeId === c!.id);
      expect(bRefs.map((r) => r.referenceName)).toContain('a');
      expect(cRefs.map((r) => r.referenceName)).toContain('a');
      expect(cRefs.map((r) => r.referenceName)).toContain('b');
    });
  });
});

// =============================================================================
// Bash / Zsh / Fish Extraction
// =============================================================================

describe('Bash Extraction', () => {
  describe('Language detection', () => {
    it('should detect .sh and .bash files', () => {
      expect(detectLanguage('main.sh')).toBe('bash');
      expect(detectLanguage('install.bash')).toBe('bash');
    });

    it('should report bash as supported', () => {
      expect(isLanguageSupported('bash')).toBe(true);
      expect(getSupportedLanguages()).toContain('bash');
    });
  });

  describe('Function extraction', () => {
    it('should extract a function defined with the `function` keyword', () => {
      const code = `function greet() {\n  echo "hi"\n}`;
      const result = extractFromSource('main.sh', code);
      const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'greet');
      expect(fn).toBeDefined();
      expect(fn?.signature).toBe('greet()');
    });

    it('should extract a function defined with the bare paren form', () => {
      const code = `farewell() {\n  echo bye\n}`;
      const result = extractFromSource('main.sh', code);
      const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'farewell');
      expect(fn).toBeDefined();
      expect(fn?.signature).toBe('farewell()');
    });
  });

  describe('Variable extraction', () => {
    it('should extract a top-level assignment as a variable', () => {
      const code = `X=42`;
      const result = extractFromSource('main.sh', code);
      const v = result.nodes.find((n) => n.kind === 'variable' && n.name === 'X');
      expect(v).toBeDefined();
      expect(v?.isExported).toBeFalsy();
    });

    it('should mark export-prefixed assignments as exported', () => {
      const code = `export PATH=/usr/local/bin`;
      const result = extractFromSource('main.sh', code);
      const v = result.nodes.find((n) => n.kind === 'variable' && n.name === 'PATH');
      expect(v).toBeDefined();
      expect(v?.isExported).toBe(true);
    });

    it('should extract readonly assignments as constants', () => {
      const code = `readonly NAME="Alice"`;
      const result = extractFromSource('main.sh', code);
      const c = result.nodes.find((n) => n.kind === 'constant' && n.name === 'NAME');
      expect(c).toBeDefined();
    });

    it('should NOT extract `local` declarations inside a function', () => {
      const code = `f() {\n  local who="$1"\n  echo "$who"\n}`;
      const result = extractFromSource('main.sh', code);
      const localVar = result.nodes.find((n) => (n.kind === 'variable' || n.kind === 'constant') && n.name === 'who');
      expect(localVar).toBeUndefined();
    });
  });

  describe('Sourcing as imports', () => {
    it('should emit an import node for `source path`', () => {
      const code = `source ./lib/utils.sh`;
      const result = extractFromSource('main.sh', code);
      const imp = result.nodes.find((n) => n.kind === 'import' && n.name === './lib/utils.sh');
      expect(imp).toBeDefined();
    });

    it('should emit an import node for the dot form `. path`', () => {
      const code = `. /etc/foo.env`;
      const result = extractFromSource('main.sh', code);
      const imp = result.nodes.find((n) => n.kind === 'import' && n.name === '/etc/foo.env');
      expect(imp).toBeDefined();
    });

    it('should not emit an import node for a dynamic source argument', () => {
      const code = `source "$(dirname "$0")/lib.sh"`;
      const result = extractFromSource('main.sh', code);
      const imports = result.nodes.filter((n) => n.kind === 'import');
      expect(imports.length).toBe(0);
    });

    it('should NOT also emit a calls-edge to "source"', () => {
      const code = `source ./lib.sh`;
      const result = extractFromSource('main.sh', code);
      const sourceCall = result.unresolvedReferences.find(
        (r) => r.referenceKind === 'calls' && r.referenceName === 'source',
      );
      expect(sourceCall).toBeUndefined();
    });
  });

  describe('Call extraction', () => {
    it('should emit a calls reference from inside a function body', () => {
      const code = `greet() { echo hi; }\nmain() { greet world; }`;
      const result = extractFromSource('main.sh', code);
      const main = result.nodes.find((n) => n.kind === 'function' && n.name === 'main');
      expect(main).toBeDefined();
      const calls = result.unresolvedReferences.filter((r) => r.fromNodeId === main!.id && r.referenceKind === 'calls');
      expect(calls.map((c) => c.referenceName)).toContain('greet');
    });
  });

  describe('Robustness', () => {
    it('should not crash on a heredoc body', () => {
      const code = `cat <<EOF\nhello\nEOF\nfoo() { echo done; }`;
      const result = extractFromSource('main.sh', code);
      const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'foo');
      expect(fn).toBeDefined();
    });

    it('should not crash on `case` statements (regression for vendored wasm fix)', () => {
      // The tree-sitter-bash from tree-sitter-wasms@0.1.13 throws
      // "resolved is not a function" inside the wasm runtime when parsing
      // case patterns under web-tree-sitter 0.25.x. We vendor a fresh
      // upstream-built wasm to fix this.
      const code = `f() {\n  local x=$1\n  case "$x" in\n    *.txt) echo text ;;\n    *.md) echo md ;;\n    *) echo other ;;\n  esac\n}`;
      const result = extractFromSource('main.sh', code);
      const errors = result.errors.filter((e) => e.severity === 'error');
      expect(errors.length).toBe(0);
      const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'f');
      expect(fn).toBeDefined();
    });
  });
});

describe('Zsh Extraction', () => {
  describe('Language detection', () => {
    it('should detect .zsh and dot-prefixed zsh config files', () => {
      expect(detectLanguage('alias.zsh')).toBe('zsh');
      expect(detectLanguage('.zshrc')).toBe('zsh');
      expect(detectLanguage('.zshenv')).toBe('zsh');
    });

    it('should report zsh as supported', () => {
      expect(isLanguageSupported('zsh')).toBe(true);
      expect(getSupportedLanguages()).toContain('zsh');
    });
  });

  describe('Shared bash extractor', () => {
    it('should extract zsh functions and sourcing using the bash grammar', () => {
      const code = `source ./aliases.zsh\nfunction greet() { echo "hi"; }`;
      const result = extractFromSource('alias.zsh', code);
      const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'greet');
      const imp = result.nodes.find((n) => n.kind === 'import' && n.name === './aliases.zsh');
      expect(fn).toBeDefined();
      expect(imp).toBeDefined();
    });
  });
});

describe('Fish Extraction', () => {
  describe('Language detection', () => {
    it('should detect .fish files', () => {
      expect(detectLanguage('config.fish')).toBe('fish');
    });

    it('should report fish as supported', () => {
      expect(isLanguageSupported('fish')).toBe(true);
      expect(getSupportedLanguages()).toContain('fish');
    });
  });

  describe('Function extraction', () => {
    it('should extract a fish function with `function … end`', () => {
      const code = `function greet\n    echo "hi"\nend`;
      const result = extractFromSource('main.fish', code);
      const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'greet');
      expect(fn).toBeDefined();
      expect(fn?.signature).toBe('greet');
    });

    it('should preserve descriptive function options in the signature', () => {
      const code = `function publish --description 'publish helper'\n    echo done\nend`;
      const result = extractFromSource('main.fish', code);
      const fn = result.nodes.find((n) => n.kind === 'function' && n.name === 'publish');
      expect(fn?.signature).toContain('--description');
    });
  });

  describe('Variable extraction (set commands)', () => {
    it('should extract `set X value` as a variable', () => {
      const code = `set VERSION 1.2.3`;
      const result = extractFromSource('main.fish', code);
      const v = result.nodes.find((n) => n.kind === 'variable' && n.name === 'VERSION');
      expect(v).toBeDefined();
      expect(v?.isExported).toBeFalsy();
    });

    it('should mark `set -x` as exported', () => {
      const code = `set -x EDITOR vim`;
      const result = extractFromSource('main.fish', code);
      const v = result.nodes.find((n) => n.kind === 'variable' && n.name === 'EDITOR');
      expect(v).toBeDefined();
      expect(v?.isExported).toBe(true);
    });

    it('should mark `set -U` (universal) as exported', () => {
      const code = `set -U fish_greeting ""`;
      const result = extractFromSource('main.fish', code);
      const v = result.nodes.find((n) => n.kind === 'variable' && n.name === 'fish_greeting');
      expect(v).toBeDefined();
      expect(v?.isExported).toBe(true);
    });

    it('should NOT extract `set -l` (local) inside a function', () => {
      const code = `function f\n    set -l tmp foo\nend`;
      const result = extractFromSource('main.fish', code);
      const localVar = result.nodes.find((n) => n.kind === 'variable' && n.name === 'tmp');
      expect(localVar).toBeUndefined();
    });

    it('should NOT emit a variable for `set -e` (erase) — variable being deleted, not declared', () => {
      const code = `set -e MY_VAR`;
      const result = extractFromSource('main.fish', code);
      const v = result.nodes.find((n) => n.kind === 'variable' && n.name === 'MY_VAR');
      expect(v).toBeUndefined();
    });

    it('should NOT emit a variable for `set -q` (query) or `set -S` (show)', () => {
      const r1 = extractFromSource('q.fish', `set -q MAYBE`);
      const r2 = extractFromSource('s.fish', `set --show OBSERVABLE`);
      expect(r1.nodes.find((n) => n.kind === 'variable' && n.name === 'MAYBE')).toBeUndefined();
      expect(r2.nodes.find((n) => n.kind === 'variable' && n.name === 'OBSERVABLE')).toBeUndefined();
    });
  });

  describe('Sourcing as imports', () => {
    it('should emit an import node for `source path`', () => {
      const code = `source ./lib.fish`;
      const result = extractFromSource('main.fish', code);
      const imp = result.nodes.find((n) => n.kind === 'import' && n.name === './lib.fish');
      expect(imp).toBeDefined();
    });

    it('should not emit an import node for a dynamic source argument with $expansion', () => {
      const code = `source $config_dir/lib.fish`;
      const result = extractFromSource('main.fish', code);
      const imports = result.nodes.filter((n) => n.kind === 'import');
      expect(imports.length).toBe(0);
    });
  });

  describe('Call extraction', () => {
    it('should emit a calls reference from inside a function body', () => {
      const code = `function greet\n    echo hi\nend\nfunction main\n    greet\nend`;
      const result = extractFromSource('main.fish', code);
      const main = result.nodes.find((n) => n.kind === 'function' && n.name === 'main');
      expect(main).toBeDefined();
      const calls = result.unresolvedReferences.filter((r) => r.fromNodeId === main!.id && r.referenceKind === 'calls');
      expect(calls.map((c) => c.referenceName)).toContain('greet');
    });
  });
});

// =============================================================================
// GraphQL SDL Extraction
// =============================================================================

describe('GraphQL Extraction', () => {
  describe('Language detection', () => {
    it('should detect .graphql and .gql files', () => {
      expect(detectLanguage('schema.graphql')).toBe('graphql');
      expect(detectLanguage('queries.gql')).toBe('graphql');
    });

    it('should report graphql as supported', () => {
      expect(isLanguageSupported('graphql')).toBe(true);
      expect(getSupportedLanguages()).toContain('graphql');
    });
  });

  describe('Type extraction', () => {
    it('should extract object type as a class node', () => {
      const code = `type User {\n  id: ID!\n  name: String!\n}`;
      const result = extractFromSource('schema.graphql', code);
      const t = result.nodes.find((n) => n.kind === 'class' && n.name === 'User');
      expect(t).toBeDefined();
      expect(t?.signature).toBe('type User');
    });

    it('should extract field nodes inside an object type', () => {
      const code = `type User {\n  id: ID!\n  email: String!\n}`;
      const result = extractFromSource('schema.graphql', code);
      const id = result.nodes.find((n) => n.kind === 'field' && n.name === 'id');
      const email = result.nodes.find((n) => n.kind === 'field' && n.name === 'email');
      expect(id).toBeDefined();
      expect(email?.signature).toBe('email: String!');
    });

    it('should attach a docstring from a triple-quote description', () => {
      const code = `"""User account"""\ntype User { id: ID! }`;
      const result = extractFromSource('schema.graphql', code);
      const t = result.nodes.find((n) => n.kind === 'class' && n.name === 'User');
      expect(t?.docstring).toBe('User account');
    });

    it('should emit implements edges for `type X implements I & J`', () => {
      const code = `interface Node { id: ID! }\ninterface Timestamps { createdAt: String! }\ntype User implements Node & Timestamps {\n  id: ID!\n  createdAt: String!\n}`;
      const result = extractFromSource('schema.graphql', code);
      const user = result.nodes.find((n) => n.kind === 'class' && n.name === 'User')!;
      const refs = result.unresolvedReferences.filter(
        (r) => r.fromNodeId === user.id && r.referenceKind === 'implements',
      );
      const names = refs.map((r) => r.referenceName);
      expect(names).toContain('Node');
      expect(names).toContain('Timestamps');
    });

    it('should emit type_of references from fields to non-builtin types', () => {
      const code = `type Post { id: ID! author: User! tags: [Tag!]! }`;
      const result = extractFromSource('schema.graphql', code);
      const author = result.nodes.find((n) => n.kind === 'field' && n.name === 'author')!;
      const tags = result.nodes.find((n) => n.kind === 'field' && n.name === 'tags')!;
      const authorTypeRef = result.unresolvedReferences.find(
        (r) => r.fromNodeId === author.id && r.referenceKind === 'type_of',
      );
      const tagsTypeRef = result.unresolvedReferences.find(
        (r) => r.fromNodeId === tags.id && r.referenceKind === 'type_of',
      );
      expect(authorTypeRef?.referenceName).toBe('User');
      expect(tagsTypeRef?.referenceName).toBe('Tag');
    });

    it('should NOT emit type_of references for builtin scalars (ID, String, Int, Float, Boolean)', () => {
      const code = `type X { a: ID! b: String! c: Int d: Float e: Boolean }`;
      const result = extractFromSource('schema.graphql', code);
      const fields = result.nodes.filter((n) => n.kind === 'field');
      const refs = result.unresolvedReferences.filter(
        (r) => r.referenceKind === 'type_of' && fields.some((f) => f.id === r.fromNodeId),
      );
      expect(refs.length).toBe(0);
    });

    it('should extract a resolver field with arguments using the return type, not an arg type', () => {
      const code = `type Query {\n  posts(first: Int = 10, filter: String): [Post!]!\n}`;
      const result = extractFromSource('schema.graphql', code);
      const posts = result.nodes.find((n) => n.kind === 'field' && n.name === 'posts');
      expect(posts).toBeDefined();
      expect(posts?.signature).toContain('[Post!]!');
      const typeRef = result.unresolvedReferences.find(
        (r) => r.fromNodeId === posts!.id && r.referenceKind === 'type_of',
      );
      expect(typeRef?.referenceName).toBe('Post');
      // No type_of refs to argument types (Int / String) from the field.
      const argTypeRefs = result.unresolvedReferences.filter(
        (r) =>
          r.fromNodeId === posts!.id &&
          r.referenceKind === 'type_of' &&
          (r.referenceName === 'Int' || r.referenceName === 'String'),
      );
      expect(argTypeRefs.length).toBe(0);
    });
  });

  describe('Interface', () => {
    it('should extract interface as an interface node', () => {
      const code = `interface Node { id: ID! }`;
      const result = extractFromSource('schema.graphql', code);
      const iface = result.nodes.find((n) => n.kind === 'interface' && n.name === 'Node');
      expect(iface).toBeDefined();
      expect(iface?.signature).toBe('interface Node');
    });
  });

  describe('Input object', () => {
    it('should extract input object as a class node with fields', () => {
      const code = `input CreateUserInput {\n  email: String!\n  password: String!\n}`;
      const result = extractFromSource('schema.graphql', code);
      const inp = result.nodes.find((n) => n.kind === 'class' && n.name === 'CreateUserInput');
      expect(inp).toBeDefined();
      expect(inp?.signature).toBe('input CreateUserInput');
      const email = result.nodes.find((n) => n.kind === 'field' && n.name === 'email');
      expect(email).toBeDefined();
    });
  });

  describe('Enum', () => {
    it('should extract enum and emit enum_member nodes for each value', () => {
      const code = `enum Role { ADMIN EDITOR VIEWER }`;
      const result = extractFromSource('schema.graphql', code);
      const en = result.nodes.find((n) => n.kind === 'enum' && n.name === 'Role');
      expect(en).toBeDefined();
      const members = result.nodes.filter((n) => n.kind === 'enum_member');
      const memberNames = members.map((m) => m.name);
      expect(memberNames).toEqual(expect.arrayContaining(['ADMIN', 'EDITOR', 'VIEWER']));
    });
  });

  describe('Union', () => {
    it('should extract union as a type_alias and reference each member', () => {
      const code = `type User { id: ID! }\ntype Post { id: ID! }\nunion SearchResult = User | Post`;
      const result = extractFromSource('schema.graphql', code);
      const u = result.nodes.find((n) => n.kind === 'type_alias' && n.name === 'SearchResult')!;
      expect(u).toBeDefined();
      const refs = result.unresolvedReferences
        .filter((r) => r.fromNodeId === u.id && r.referenceKind === 'references')
        .map((r) => r.referenceName);
      expect(refs).toEqual(expect.arrayContaining(['User', 'Post']));
    });
  });

  describe('Scalar', () => {
    it('should extract scalar as a type_alias node', () => {
      const code = `scalar DateTime`;
      const result = extractFromSource('schema.graphql', code);
      const s = result.nodes.find((n) => n.kind === 'type_alias' && n.name === 'DateTime');
      expect(s).toBeDefined();
    });
  });

  describe('Directive', () => {
    it('should extract a directive definition as a function with @-prefixed name', () => {
      const code = `directive @auth(role: String!) on FIELD_DEFINITION | OBJECT`;
      const result = extractFromSource('schema.graphql', code);
      const d = result.nodes.find((n) => n.kind === 'function' && n.name === '@auth');
      expect(d).toBeDefined();
      expect(d?.signature).toContain('directive @auth');
    });
  });

  describe('Robustness', () => {
    it('should not emit any nodes for a bare schema { … } definition', () => {
      const code = `schema {\n  query: Query\n  mutation: Mutation\n}`;
      const result = extractFromSource('schema.graphql', code);
      // Only the file node should be present.
      expect(result.nodes.filter((n) => n.kind !== 'file').length).toBe(0);
    });

    it('should not crash on an empty schema file', () => {
      const result = extractFromSource('empty.graphql', '');
      expect(result.errors.filter((e) => e.severity === 'error').length).toBe(0);
    });

    it('emits an extension node + extends-ref for `extend type` (B #27)', () => {
      // type_system_extension wrappers (federation-style schema
      // splitting) now produce a separate node with the same kind as
      // the base type plus an `extends` ref to it. Cross-file merge
      // is reconstructible by following the extends edge after the
      // resolver pass.
      const code = `extend type User {\n  newField: String\n}`;
      const result = extractFromSource('schema.graphql', code);
      expect(result.errors.filter((e) => e.severity === 'error').length).toBe(0);
      const userExt = result.nodes.find(
        (n) => n.kind === 'class' && n.name === 'User' && n.signature?.startsWith('extend '),
      );
      expect(userExt).toBeDefined();
      const extendsRef = result.unresolvedReferences.find(
        (u) => u.referenceKind === 'extends' && u.referenceName === 'User',
      );
      expect(extendsRef).toBeDefined();
    });
  });
});

describe('Instantiates + Decorates edge extraction', () => {
  it('emits an instantiates ref for `new Foo()`', () => {
    const code = `
class Foo {}
function bootstrap() { return new Foo(); }
`;
    const result = extractFromSource('app.ts', code);
    const ref = result.unresolvedReferences.find(
      (r) => r.referenceKind === 'instantiates' && r.referenceName === 'Foo',
    );
    expect(ref).toBeDefined();
  });

  it('strips type-argument suffix from generic constructors', () => {
    const code = `
class Container<T> { constructor(_: T) {} }
function go() { return new Container<string>('x'); }
`;
    const result = extractFromSource('app.ts', code);
    const ref = result.unresolvedReferences.find((r) => r.referenceKind === 'instantiates');
    expect(ref).toBeDefined();
    // Container<string> must be normalised to "Container" — otherwise
    // resolution can never match the class node.
    expect(ref!.referenceName).toBe('Container');
  });

  it('keeps trailing identifier from qualified `new ns.Foo()`', () => {
    const code = `
const ns = { Foo: class {} };
function go() { return new ns.Foo(); }
`;
    const result = extractFromSource('app.ts', code);
    const ref = result.unresolvedReferences.find((r) => r.referenceKind === 'instantiates');
    // We can't always resolve which Foo, but the name should be the
    // simple identifier so name-matching has a chance.
    expect(ref?.referenceName).toBe('Foo');
  });

  it('emits a decorates ref for `@Foo class X {}`', () => {
    const code = `
function Foo(_arg: string) { return (cls: any) => cls; }
@Foo('x')
class X {}
`;
    const result = extractFromSource('app.ts', code);
    const decorClass = result.unresolvedReferences.find(
      (r) => r.referenceKind === 'decorates' && r.referenceName === 'Foo',
    );
    expect(decorClass).toBeDefined();
  });

  it("does NOT attribute a prior class's decorator to the next class", () => {
    // Regression: the sibling-walk must stop at the first non-
    // decorator separator. `@A class Foo {} @B class Bar {}` must
    // produce `decorates(Foo, A)` and `decorates(Bar, B)` — never
    // `decorates(Bar, A)`.
    const code = `
function A(cls: any) { return cls; }
function B(cls: any) { return cls; }
@A
class Foo {}
@B
class Bar {}
`;
    const result = extractFromSource('app.ts', code);
    const decoratesEdges = result.unresolvedReferences.filter((r) => r.referenceKind === 'decorates');
    // Exactly one decorates ref per decorated class, no cross-attribution.
    const fromBar = decoratesEdges.filter((r) => result.nodes.find((n) => n.id === r.fromNodeId && n.name === 'Bar'));
    expect(fromBar.length).toBe(1);
    expect(fromBar[0]!.referenceName).toBe('B');
  });

  it('emits a decorates ref for `@Foo method() {}`', () => {
    const code = `
function Get(p: string) { return (t: any, k: string) => t; }
class Svc {
  @Get('/x') method() { return 1; }
}
`;
    const result = extractFromSource('app.ts', code);
    const decorMethod = result.unresolvedReferences.find(
      (r) => r.referenceKind === 'decorates' && r.referenceName === 'Get',
    );
    expect(decorMethod).toBeDefined();
    // The decorated symbol must be `method`, not the constructor or class.
    const decoratedNode = result.nodes.find((n) => n.id === decorMethod!.fromNodeId);
    expect(decoratedNode?.name).toBe('method');
  });
});

describe('Syntax error surfacing', () => {
  it('emits no syntax_error warning for a clean file', () => {
    const result = extractFromSource('clean.ts', 'function ok() { return 1; }\n', 'typescript');
    expect(result.errors.filter((e) => e.code === 'syntax_error')).toHaveLength(0);
  });

  it('emits a syntax_error warning with a line number for a broken region', () => {
    const code = 'function ok() { return 1; }\nfunction bad( {\n  const x =\n}\n';
    const result = extractFromSource('broken.ts', code, 'typescript');
    const syn = result.errors.filter((e) => e.code === 'syntax_error');
    expect(syn.length).toBeGreaterThan(0);
    expect(syn[0]!.severity).toBe('warning');
    expect(syn[0]!.line).toBeGreaterThan(0);
    // The clean function before the break still extracts — the warning
    // surfaces the damage without aborting partial extraction.
    expect(result.nodes.some((n) => n.name === 'ok')).toBe(true);
  });

  it('detects a MISSING node (an omitted required token)', () => {
    // The unclosed `(` makes tree-sitter insert a MISSING ')'.
    const result = extractFromSource('missing.py', 'def f(:\n    return 1\n', 'python');
    const syn = result.errors.filter((e) => e.code === 'syntax_error');
    expect(syn.some((e) => /missing/i.test(e.message))).toBe(true);
  });
});
