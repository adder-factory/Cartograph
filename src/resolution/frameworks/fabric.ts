/**
 * Fabric + legacy Paper view-component resolver (B12 sub-channel 4, 2026-05-29).
 *
 * Synthesizes `component` + `property` nodes for React Native view components,
 * from three declaration shapes (see `../fabric-bridge.ts` for the parse
 * rationale): Fabric Codegen TS specs, legacy ObjC `*ViewManager`s, and legacy
 * Java/Kotlin `*ViewManager`s. Ported from upstream `4d1a2b3c`, reshaped.
 *
 * **Synthesizer only — `resolve()` is a no-op.** Unlike the ch.2/ch.3 JS↔native
 * *call* bridges (which need a `resolve()` because the fork's member-call
 * matcher is receiver-type-driven), the JS→component hop here closes FOR FREE:
 * a JSX `<MyView>` ref is resolved BY NAME to a `component` node via the
 * existing `react.ts` `resolveComponent` (kind ∈ {component,function,class}),
 * so a synthesized `component` node named `MyView` is reached without any
 * fabric resolve()/marker. The component → native-implementation-class edge
 * (the actual cross-language bridge) is synthesized post-extraction by the
 * `fabric-native-impl` index-hook (it walks `fabric-component:` nodes and
 * matches native classes by name+suffix — a node→node link, not a ref to
 * resolve).
 *
 * **Not covered** (matches upstream): JSX-attribute → native-prop edges (the
 * body walker doesn't visit JSX attributes; props are name-discoverability
 * nodes only) and `requireNativeComponent('Name')` legacy JS registration.
 */
import type { Node, Language } from '../../types.js';
import type { FrameworkResolver } from '../types.js';
import { makeLineIndex } from '../../utils.js';
import {
  type FabricExtraction,
  isFabricSpec,
  parseCodegenSpecs,
  parseJvmViewManager,
  parseObjcViewManager,
} from '../fabric-bridge.js';

interface BuildNodesArgs {
  filePath: string;
  ex: FabricExtraction;
  language: Language;
  content: string;
}

interface FabricNodeSpec {
  filePath: string;
  kind: 'component' | 'property';
  /** Simple name (the component / prop name). */
  name: string;
  /** qualifiedName suffix (component name, or `${qualifier}.${prop}`). */
  qualifier: string;
  line: number;
  language: Language;
}

function makeFabricNode(spec: FabricNodeSpec): Node {
  return {
    id: `fabric-${spec.kind === 'component' ? 'component' : 'prop'}:${spec.filePath}:${spec.name}:${spec.line}`,
    kind: spec.kind,
    name: spec.name,
    qualifiedName: `${spec.filePath}::${spec.qualifier}`,
    filePath: spec.filePath,
    language: spec.language,
    startLine: spec.line,
    endLine: spec.line,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
  };
}

/** Build `component` + `property` nodes from a parsed extraction. */
function buildNodes({ filePath, ex, language, content }: BuildNodesArgs): Node[] {
  const lineOf = makeLineIndex(content);
  const specs = [
    ...ex.components.map((c) => ({ kind: 'component' as const, name: c.name, qualifier: c.name, index: c.index })),
    ...ex.props.map((p) => ({
      kind: 'property' as const,
      name: p.name,
      qualifier: `${ex.propQualifier}.${p.name}`,
      index: p.index,
    })),
  ];
  const nodes: Node[] = [];
  const seen = new Set<string>();
  for (const s of specs) {
    const line = lineOf(s.index);
    const key = `${s.kind}:${s.name}:${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    nodes.push(makeFabricNode({ filePath, kind: s.kind, name: s.name, qualifier: s.qualifier, line, language }));
  }
  return nodes;
}

export const fabricViewResolver: FrameworkResolver = {
  name: 'fabric-view',
  // Codegen specs are .ts/.tsx; legacy view managers are objc/java/kotlin.
  languages: ['typescript', 'tsx', 'objc', 'java', 'kotlin'],
  // Aho-Corasick pre-filter: every branch gate. A missing anchor would silently
  // skip the resolver (correctness bug), so all four prop-declaration markers
  // are listed. None collide with the ch.1-3 resolvers' anchors.
  anchors: [
    'codegenNativeComponent',
    'RCT_EXPORT_VIEW_PROPERTY',
    'RCT_CUSTOM_VIEW_PROPERTY',
    'RCT_REMAP_VIEW_PROPERTY',
    '@ReactProp',
  ],

  /** Detect: any React Native project (per-file synthesis is anchor-gated, so a
   *  broad project-level signal is fine — and `resolve()` is a no-op anyway). */
  detect(context) {
    const pkg = context.readFile('package.json');
    if (pkg && /["']react-native["']\s*:/.test(pkg)) return true;
    const files = context.getAllFiles();
    for (let i = 0; i < Math.min(files.length, 200); i++) {
      const f = files[i];
      if (!f) continue;
      if (fileHasFabricSignal(f, (path) => context.readFile(path))) return true;
    }
    return false;
  },

  /** Synthesize the view-component + property nodes for one file, dispatching
   *  by extension to the matching parse branch. */
  extractNodes(filePath, content) {
    if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
      const ex = parseCodegenSpecs(content);
      return ex
        ? buildNodes({ filePath, ex, language: filePath.endsWith('.tsx') ? 'tsx' : 'typescript', content })
        : [];
    }
    if (filePath.endsWith('.m') || filePath.endsWith('.mm')) {
      const ex = parseObjcViewManager(content);
      return ex ? buildNodes({ filePath, ex, language: 'objc', content }) : [];
    }
    if (filePath.endsWith('.java') || filePath.endsWith('.kt')) {
      const ex = parseJvmViewManager(content);
      return ex ? buildNodes({ filePath, ex, language: filePath.endsWith('.kt') ? 'kotlin' : 'java', content }) : [];
    }
    return [];
  },

  /** No-op: the JSX → component hop closes via `react.ts` resolveComponent
   *  (by name), and the component → native-class hop is the `fabric-native-impl`
   *  index-hook's job. There is no JS *call* ref for this resolver to bridge. */
  resolve() {
    return null;
  },
};

function fileHasFabricSignal(filePath: string, readFile: (filePath: string) => string | null): boolean {
  const src = readFile(filePath);
  if (!src) return false;
  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) return isFabricSpec(src);
  if (!isNativeViewManagerFile(filePath)) return false;
  return /\bRCT_(?:EXPORT|CUSTOM|REMAP)_VIEW_PROPERTY\b/.test(src) || src.includes('@ReactProp');
}

function isNativeViewManagerFile(filePath: string): boolean {
  return filePath.endsWith('.m') || filePath.endsWith('.mm') || filePath.endsWith('.java') || filePath.endsWith('.kt');
}
