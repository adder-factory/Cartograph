/**
 * Core graph primitives.
 *
 * `src/types.ts` re-exports these for compatibility, but the graph
 * feature owns the contracts.
 */

export type NodeKind =
  | 'file'
  | 'module'
  | 'class'
  | 'struct'
  | 'interface'
  | 'trait'
  | 'protocol'
  | 'function'
  | 'method'
  | 'property'
  | 'field'
  | 'variable'
  | 'constant'
  | 'enum'
  | 'enum_member'
  | 'type_alias'
  | 'namespace'
  | 'parameter'
  | 'import'
  | 'export'
  | 'route'
  | 'component'
  | 'table'
  | 'resource';

export type EdgeKind =
  | 'contains'
  | 'calls'
  | 'imports'
  | 'exports'
  | 'extends'
  | 'implements'
  | 'references'
  | 'type_of'
  | 'returns'
  | 'instantiates'
  | 'overrides'
  | 'decorates'
  | 'tests'
  | 'field_access'
  | 'similar_to'
  | 'def_use';

export type Language =
  | 'apex'
  | 'arkts'
  | 'aura'
  | 'typescript'
  | 'javascript'
  | 'tsx'
  | 'jsx'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'c'
  | 'clojure'
  | 'common_lisp'
  | 'cpp'
  | 'csharp'
  | 'cuda'
  | 'css'
  | 'php'
  | 'ruby'
  | 'swift'
  | 'kotlin'
  | 'dart'
  | 'embedded_template'
  | 'svelte'
  | 'vue'
  | 'liquid'
  | 'haskell'
  | 'html'
  | 'hlsl'
  | 'jsdoc'
  | 'json'
  | 'jupyter'
  | 'julia'
  | 'lua'
  | 'luau'
  | 'nix'
  | 'objc'
  | 'ocaml'
  | 'ocaml_interface'
  | 'pascal'
  | 'hcl'
  | 'r'
  | 'regex'
  | 'sql'
  | 'scala'
  | 'rescript'
  | 'elixir'
  | 'bash'
  | 'zsh'
  | 'fish'
  | 'glsl'
  | 'graphql'
  | 'groovy'
  | 'prisma'
  | 'properties'
  | 'solidity'
  | 'verilog'
  | 'visualforce'
  | 'xml'
  | 'yaml'
  | 'unknown';

export interface DecoratorArgsEntry {
  name: string;
  argStrings: string[];
  argIdents: string[];
  namedArgs?: Record<string, string>;
}

export interface Node {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  filePath: string;
  language: Language;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  docstring?: string;
  signature?: string;
  visibility?: 'public' | 'private' | 'protected' | 'internal';
  isExported?: boolean;
  isAsync?: boolean;
  isStatic?: boolean;
  decorators?: string[];
  decoratorArgs?: DecoratorArgsEntry[];
  updatedAt: number;
  centrality?: number | null;
  betweenness?: number | null;
  bodyHash?: string;
}

export interface Edge {
  source: string;
  target: string;
  kind: EdgeKind;
  metadata?: Record<string, unknown> | undefined;
  line?: number;
  column?: number;
  confidence?: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';
}

export interface Context {
  focal: Node;
  ancestors: Node[];
  children: Node[];
  incomingRefs: Array<{ node: Node; edge: Edge }>;
  outgoingRefs: Array<{ node: Node; edge: Edge }>;
  types: Node[];
  imports: Node[];
}
