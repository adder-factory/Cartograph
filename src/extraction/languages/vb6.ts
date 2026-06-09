import * as path from 'node:path';
import type { LanguageDef } from './types.js';
import { buildExtractionResult, type ExtractionAccumulators } from '../extraction-result-helpers.js';
import type { ExtractionResult, UnresolvedReference } from '../types.js';
import { createIdFactory, generateNodeId, type NodeIdFactory } from '../tree-sitter-helpers.js';
import type { Edge, Node, NodeKind } from '../../types.js';

type Vb6ContainerKind = 'module' | 'class' | 'component';
type Vb6BlockKind = 'file' | 'container' | 'routine' | 'type' | 'enum';

const VB6_PROJECT_IMPORT_KINDS: ReadonlySet<string> = new Set([
  'module',
  'class',
  'form',
  'usercontrol',
  'userdocument',
  'designer',
]);
const VB6_VISIBILITY_WORDS: ReadonlySet<string> = new Set(['public', 'private', 'friend', 'global']);
const VB6_VAR_PREFIX_WORDS: ReadonlySet<string> = new Set(['public', 'private', 'friend', 'global', 'dim', 'static']);

const VB6_SKIP_CALLS: ReadonlySet<string> = new Set([
  'case',
  'close',
  'debug',
  'dim',
  'do',
  'else',
  'elseif',
  'end',
  'for',
  'if',
  'loop',
  'next',
  'open',
  'option',
  'print',
  'private',
  'public',
  'redim',
  'resume',
  'select',
  'set',
  'static',
  'wend',
  'while',
  'with',
]);

interface ScopeEntry {
  node: Node;
  blockKind: Vb6BlockKind;
}

interface Vb6State extends ExtractionAccumulators {
  filePath: string;
  source: string;
  lines: string[];
  idFactory: NodeIdFactory;
  scope: ScopeEntry[];
}

interface CreateSymbolArgs {
  kind: NodeKind;
  name: string;
  lineNumber: number;
  signature: string;
  visibility?: Node['visibility'];
}

interface Vb6CallRefArgs {
  state: Vb6State;
  fromNodeId: string;
  referenceName: string;
  lineNumber: number;
}

interface RenameContainerArgs {
  state: Vb6State;
  name: string;
  lineNumber: number;
  kind?: Vb6ContainerKind;
}

interface ParsedNamedDeclaration {
  name: string;
  visibility?: string;
}

interface ParsedRoutine extends ParsedNamedDeclaration {
  kind: string;
}

interface ParsedProjectImport {
  value: string;
}

function extractVb6(filePath: string, source: string): ExtractionResult {
  const startTime = Date.now();
  const state = createState(filePath, source);
  const fileNode = createFileNode(state);
  state.scope.push({ node: fileNode, blockKind: 'file' });
  if (filePath.toLowerCase().endsWith('.vbp')) {
    extractProjectFile(state);
  } else {
    extractCodeFile(state);
  }
  return buildExtractionResult(state, startTime);
}

function createState(filePath: string, source: string): Vb6State {
  return {
    filePath,
    source,
    lines: source.split(/\r?\n/),
    idFactory: createIdFactory(filePath),
    scope: [],
    nodes: [],
    edges: [],
    unresolvedReferences: [],
    errors: [],
  };
}

function createFileNode(state: Vb6State): Node {
  const id = generateNodeId({ filePath: state.filePath, kind: 'file', name: state.filePath, ordinal: 0 });
  const fileNode: Node = {
    id,
    kind: 'file',
    name: path.basename(state.filePath),
    qualifiedName: state.filePath,
    filePath: state.filePath,
    language: 'vb6',
    startLine: 1,
    endLine: state.lines.length,
    startColumn: 0,
    endColumn: state.lines.at(-1)?.length ?? 0,
    updatedAt: Date.now(),
  };
  state.nodes.push(fileNode);
  return fileNode;
}

function extractProjectFile(state: Vb6State): void {
  for (let index = 0; index < state.lines.length; index += 1) {
    const line = state.lines[index]!.trim();
    const projectImport = parseProjectImport(line);
    if (!projectImport) continue;
    createSymbol(state, {
      kind: 'import',
      name: projectImportName(projectImport.value),
      lineNumber: index + 1,
      signature: line,
    });
  }
}

function extractCodeFile(state: Vb6State): void {
  ensureContainer(state, 1);
  for (let index = 0; index < state.lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = stripComment(state.lines[index]!).trim();
    if (!line) continue;
    if (visitHeaderLine(state, line, lineNumber)) continue;
    if (visitEndLine(state, line, lineNumber)) continue;
    if (visitTypeOrEnum(state, line, lineNumber)) continue;
    if (visitRoutine(state, line, lineNumber)) continue;
    if (visitDeclaration(state, line, lineNumber)) continue;
    visitCall(state, line, lineNumber);
  }
  closeOpenScopes(state, state.lines.length);
}

function visitHeaderLine(state: Vb6State, line: string, lineNumber: number): boolean {
  const attrName = parseAttributeName(line);
  if (attrName) {
    renameContainer({ state, name: attrName, lineNumber });
    return true;
  }
  const formName = parseFormName(line);
  if (formName) {
    renameContainer({ state, name: formName, lineNumber, kind: 'component' });
    return true;
  }
  const lower = line.toLowerCase();
  return lower.startsWith('version ') || lower.startsWith('attribute vb_');
}

function visitEndLine(state: Vb6State, line: string, lineNumber: number): boolean {
  const keyword = parseEndKeyword(line);
  if (!keyword) return false;
  closeScope(state, endBlockKind(keyword), lineNumber);
  return true;
}

function visitTypeOrEnum(state: Vb6State, line: string, lineNumber: number): boolean {
  const typeDecl = parseNamedDeclaration(line, 'type');
  if (typeDecl) {
    pushSymbol(
      state,
      createSymbol(state, { kind: 'struct', name: typeDecl.name, lineNumber, signature: line }),
      'type',
    );
    return true;
  }
  const enumDecl = parseNamedDeclaration(line, 'enum');
  if (enumDecl) {
    pushSymbol(state, createSymbol(state, { kind: 'enum', name: enumDecl.name, lineNumber, signature: line }), 'enum');
    return true;
  }
  return visitTypeOrEnumMember(state, line, lineNumber);
}

function visitTypeOrEnumMember(state: Vb6State, line: string, lineNumber: number): boolean {
  const current = currentScope(state);
  if (current?.blockKind === 'enum') {
    const member = firstIdentifier(line);
    if (member) createSymbol(state, { kind: 'enum_member', name: member, lineNumber, signature: line });
    return true;
  }
  if (current?.blockKind === 'type') {
    const field = firstIdentifier(line);
    if (field) createSymbol(state, { kind: 'field', name: field, lineNumber, signature: line });
    return true;
  }
  return false;
}

function visitRoutine(state: Vb6State, line: string, lineNumber: number): boolean {
  const declare = parseDeclare(line);
  if (declare) {
    createSymbol(state, { kind: 'import', name: declare.name, lineNumber, signature: line });
    return true;
  }

  const routine = parseRoutine(line);
  if (!routine) return false;
  const kind = routineKind(routine.kind, containerKind(state));
  const node = createSymbol(state, {
    kind,
    name: routine.name,
    lineNumber,
    signature: line,
    visibility: visibility(routine.visibility),
  });
  pushSymbol(state, node, 'routine');
  return true;
}

function routineKind(declaration: string, container: Vb6ContainerKind): NodeKind {
  if (declaration.toLowerCase().startsWith('property')) return 'property';
  return container === 'module' ? 'function' : 'method';
}

function visitDeclaration(state: Vb6State, line: string, lineNumber: number): boolean {
  const constant = parseConst(line);
  if (constant) {
    createSymbol(state, {
      kind: 'constant',
      name: constant.name,
      lineNumber,
      signature: line,
      visibility: visibility(constant.visibility),
    });
    return true;
  }
  const variable = parseVariable(line);
  if (!variable) return false;
  createSymbol(state, {
    kind: currentScope(state)?.blockKind === 'routine' ? 'variable' : 'field',
    name: variable.name,
    lineNumber,
    signature: line,
    visibility: visibility(variable.visibility),
  });
  return true;
}

function visitCall(state: Vb6State, line: string, lineNumber: number): void {
  const routine = currentRoutine(state);
  if (!routine) return;
  const name = parseCallName(line);
  if (!name || VB6_SKIP_CALLS.has(name.toLowerCase())) return;
  state.unresolvedReferences.push(vb6CallRef({ state, fromNodeId: routine.node.id, referenceName: name, lineNumber }));
}

function vb6CallRef(args: Vb6CallRefArgs): UnresolvedReference {
  const { state, fromNodeId, referenceName, lineNumber } = args;
  return {
    fromNodeId,
    referenceName,
    referenceKind: 'calls',
    line: lineNumber,
    column: state.lines[lineNumber - 1]!.indexOf(referenceName),
  };
}

function ensureContainer(state: Vb6State, lineNumber: number): Node {
  const existing = state.scope.find((entry) => entry.blockKind === 'container')?.node;
  if (existing) return existing;
  const kind = defaultContainerKind(state.filePath);
  const name = path.basename(state.filePath, path.extname(state.filePath));
  const node = createSymbol(state, { kind, name, lineNumber, signature: `${kind} ${name}` });
  pushSymbol(state, node, 'container');
  return node;
}

function renameContainer(args: RenameContainerArgs): void {
  const { state, name, lineNumber } = args;
  const kind = args.kind ?? defaultContainerKind(state.filePath);
  const existing = state.scope.find((entry) => entry.blockKind === 'container');
  if (!existing) {
    const node = createSymbol(state, { kind, name, lineNumber, signature: `${kind} ${name}` });
    pushSymbol(state, node, 'container');
    return;
  }
  existing.node.name = name;
  existing.node.qualifiedName = name;
  existing.node.kind = kind;
  existing.node.startLine = Math.min(existing.node.startLine, lineNumber);
}

function createSymbol(state: Vb6State, args: CreateSymbolArgs): Node {
  const parent = currentScope(state)?.node;
  const qualifiedName = parent && parent.kind !== 'file' ? `${parent.qualifiedName}::${args.name}` : args.name;
  const node: Node = {
    id: state.idFactory.next(args.kind, args.name),
    kind: args.kind,
    name: args.name,
    qualifiedName,
    filePath: state.filePath,
    language: 'vb6',
    startLine: args.lineNumber,
    endLine: args.lineNumber,
    startColumn: state.lines[args.lineNumber - 1]!.indexOf(args.name),
    endColumn: state.lines[args.lineNumber - 1]!.length,
    signature: args.signature,
    updatedAt: Date.now(),
    ...(args.visibility ? { visibility: args.visibility, isExported: args.visibility === 'public' } : {}),
  };
  state.nodes.push(node);
  if (parent) state.edges.push(containsEdge(parent.id, node.id));
  return node;
}

function containsEdge(source: string, target: string): Edge {
  return { source, target, kind: 'contains' };
}

function pushSymbol(state: Vb6State, node: Node, blockKind: Vb6BlockKind): void {
  state.scope.push({ node, blockKind });
}

function closeScope(state: Vb6State, blockKind: Vb6BlockKind, lineNumber: number): void {
  while (state.scope.length > 1) {
    const entry = state.scope.pop()!;
    entry.node.endLine = lineNumber;
    if (entry.blockKind === blockKind) return;
  }
}

function closeOpenScopes(state: Vb6State, lineNumber: number): void {
  for (const entry of state.scope) {
    entry.node.endLine = Math.max(entry.node.endLine, lineNumber);
  }
}

function currentScope(state: Vb6State): ScopeEntry | undefined {
  return state.scope.at(-1);
}

function currentRoutine(state: Vb6State): ScopeEntry | undefined {
  for (let index = state.scope.length - 1; index >= 0; index -= 1) {
    const entry = state.scope[index];
    if (entry?.blockKind === 'routine') return entry;
  }
  return undefined;
}

function parseProjectImport(line: string): ParsedProjectImport | undefined {
  const separator = line.indexOf('=');
  if (separator <= 0) return undefined;
  const key = line.slice(0, separator).trim().toLowerCase();
  if (!VB6_PROJECT_IMPORT_KINDS.has(key)) return undefined;
  return { value: line.slice(separator + 1).trim() };
}

function parseAttributeName(line: string): string | undefined {
  const lower = line.toLowerCase();
  if (!lower.startsWith('attribute vb_name')) return undefined;
  const firstQuote = line.indexOf('"');
  if (firstQuote < 0) return undefined;
  const secondQuote = line.indexOf('"', firstQuote + 1);
  return secondQuote > firstQuote ? line.slice(firstQuote + 1, secondQuote) : undefined;
}

function parseFormName(line: string): string | undefined {
  const tokens = words(line);
  if (tokens.length < 3) return undefined;
  if (tokens[0]?.toLowerCase() !== 'begin') return undefined;
  if (!tokens[1]?.toLowerCase().startsWith('vb.')) return undefined;
  return identifierFromToken(tokens[2]);
}

function parseEndKeyword(line: string): string | undefined {
  const tokens = words(line);
  if (tokens[0]?.toLowerCase() !== 'end') return undefined;
  const keyword = tokens[1]?.toLowerCase();
  if (
    keyword === 'sub' ||
    keyword === 'function' ||
    keyword === 'property' ||
    keyword === 'type' ||
    keyword === 'enum'
  ) {
    return keyword;
  }
  return undefined;
}

function parseNamedDeclaration(line: string, keyword: 'type' | 'enum'): ParsedNamedDeclaration | undefined {
  const tokens = words(line);
  let index = 0;
  const visibilityWord = visibilityToken(tokens[index]);
  if (visibilityWord) index += 1;
  if (tokens[index]?.toLowerCase() !== keyword) return undefined;
  const name = identifierFromToken(tokens[index + 1]);
  return name ? { name, ...(visibilityWord ? { visibility: visibilityWord } : {}) } : undefined;
}

function parseDeclare(line: string): ParsedNamedDeclaration | undefined {
  const tokens = words(line);
  let index = 0;
  const visibilityWord = visibilityToken(tokens[index]);
  if (visibilityWord) index += 1;
  if (tokens[index]?.toLowerCase() !== 'declare') return undefined;
  index += 1;
  if (tokens[index]?.toLowerCase() === 'ptrsafe') index += 1;
  const kind = tokens[index]?.toLowerCase();
  if (kind !== 'sub' && kind !== 'function') return undefined;
  const name = identifierFromToken(tokens[index + 1]);
  return name ? { name, ...(visibilityWord ? { visibility: visibilityWord } : {}) } : undefined;
}

function parseRoutine(line: string): ParsedRoutine | undefined {
  const tokens = words(line);
  let index = 0;
  const visibilityWord = visibilityToken(tokens[index]);
  if (visibilityWord) index += 1;
  if (tokens[index]?.toLowerCase() === 'static') index += 1;
  const kind = tokens[index]?.toLowerCase();
  if (kind === 'sub' || kind === 'function') {
    const name = identifierFromToken(tokens[index + 1]);
    return name ? { kind, name, ...(visibilityWord ? { visibility: visibilityWord } : {}) } : undefined;
  }
  if (kind !== 'property') return undefined;
  const accessor = tokens[index + 1]?.toLowerCase();
  if (accessor !== 'get' && accessor !== 'let' && accessor !== 'set') return undefined;
  const name = identifierFromToken(tokens[index + 2]);
  return name
    ? { kind: `property ${accessor}`, name, ...(visibilityWord ? { visibility: visibilityWord } : {}) }
    : undefined;
}

function parseConst(line: string): ParsedNamedDeclaration | undefined {
  const tokens = words(line);
  let index = 0;
  const visibilityWord = visibilityToken(tokens[index]);
  if (visibilityWord) index += 1;
  if (tokens[index]?.toLowerCase() !== 'const') return undefined;
  const name = identifierFromToken(tokens[index + 1]);
  return name ? { name, ...(visibilityWord ? { visibility: visibilityWord } : {}) } : undefined;
}

function parseVariable(line: string): ParsedNamedDeclaration | undefined {
  const tokens = words(line);
  let index = 0;
  const visibilityWord = visibilityToken(tokens[index]);
  if (!visibilityWord && !VB6_VAR_PREFIX_WORDS.has(tokens[index]?.toLowerCase() ?? '')) return undefined;
  while (VB6_VAR_PREFIX_WORDS.has(tokens[index]?.toLowerCase() ?? '')) index += 1;
  if (tokens[index]?.toLowerCase() === 'withevents') index += 1;
  const name = identifierFromToken(tokens[index]);
  return name ? { name, ...(visibilityWord ? { visibility: visibilityWord } : {}) } : undefined;
}

function parseCallName(line: string): string | undefined {
  if (line.toLowerCase().startsWith('call ')) return firstIdentifier(line.slice('call '.length));
  const parenIndex = line.indexOf('(');
  if (parenIndex > 0) return identifierBefore(line, parenIndex);
  return firstIdentifier(line);
}

function visibilityToken(token: string | undefined): string | undefined {
  const lower = token?.toLowerCase();
  return lower && VB6_VISIBILITY_WORDS.has(lower) ? lower : undefined;
}

function words(line: string): string[] {
  const result: string[] = [];
  let index = 0;
  while (index < line.length) {
    while (index < line.length && isWhitespace(codePoint(line, index))) index += 1;
    const start = index;
    while (index < line.length && !isWhitespace(codePoint(line, index))) index += 1;
    if (index > start) result.push(line.slice(start, index));
  }
  return result;
}

function firstIdentifier(value: string): string | undefined {
  let index = 0;
  while (index < value.length && isWhitespace(codePoint(value, index))) index += 1;
  return identifierFrom(value, index);
}

function identifierBefore(value: string, beforeIndex: number): string | undefined {
  let end = beforeIndex;
  while (end > 0 && isWhitespace(codePoint(value, end - 1))) end -= 1;
  let start = end;
  while (start > 0 && isIdentifierPart(codePoint(value, start - 1))) start -= 1;
  return start < end && isIdentifierStart(codePoint(value, start)) ? value.slice(start, end) : undefined;
}

function identifierFromToken(token: string | undefined): string | undefined {
  return token ? identifierFrom(token, 0) : undefined;
}

function identifierFrom(value: string, start: number): string | undefined {
  if (!isIdentifierStart(codePoint(value, start))) return undefined;
  let end = start + 1;
  while (end < value.length && isIdentifierPart(codePoint(value, end))) end += 1;
  return value.slice(start, end);
}

function codePoint(value: string, index: number): number {
  return value.codePointAt(index) ?? -1;
}

function isWhitespace(code: number): boolean {
  return code === 9 || code === 10 || code === 13 || code === 32;
}

function isIdentifierStart(code: number): boolean {
  return code === 95 || isAsciiLetter(code);
}

function isIdentifierPart(code: number): boolean {
  return isIdentifierStart(code) || (code >= 48 && code <= 57);
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function projectImportName(value: string): string {
  const parts = value.split(';').map((part) => part.trim());
  return parts.at(-1) || parts[0] || value;
}

function endBlockKind(keyword: string): Vb6BlockKind {
  if (keyword === 'type') return 'type';
  if (keyword === 'enum') return 'enum';
  return 'routine';
}

function defaultContainerKind(filePath: string): Vb6ContainerKind {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.frm' || ext === '.ctl' || ext === '.dob' || ext === '.dsr' || ext === '.pag') return 'component';
  if (ext === '.cls') return 'class';
  return 'module';
}

function containerKind(state: Vb6State): Vb6ContainerKind {
  const container = state.scope.find((entry) => entry.blockKind === 'container')?.node.kind;
  if (container === 'class' || container === 'component') return container;
  return 'module';
}

function visibility(value: string | undefined): Node['visibility'] | undefined {
  if (!value) return undefined;
  const lower = value.toLowerCase();
  if (lower === 'private') return 'private';
  if (lower === 'friend') return 'internal';
  return 'public';
}

function stripComment(line: string): string {
  const index = line.indexOf("'");
  return index >= 0 ? line.slice(0, index) : line;
}

export const VB6_DEF: LanguageDef = {
  name: 'vb6',
  displayName: 'Visual Basic 6',
  extensions: ['.bas', '.frm', '.ctl', '.dob', '.dsr', '.pag', '.vbp'],
  includeGlobs: ['**/*.bas', '**/*.frm', '**/*.ctl', '**/*.dob', '**/*.dsr', '**/*.pag', '**/*.vbp', '**/*.cls'],
  customExtractor: extractVb6,
};
