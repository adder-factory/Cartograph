import type { ExtractionResult } from '../../types.js';
import type { Node } from '../../../types.js';
import {
  GUIDSTRING_RE,
  addReference,
  createContext,
  createNode,
  extractQuotedValues,
  extractReferenceTokens,
  finish,
  isBg3ResourceIdentifier,
  isQualifiedIdentifier,
  stripLineComment,
  type Bg3Context,
  type QuotedValue,
} from './shared.js';

const ANUBIS_STATE_DEF_RE = /\bgame\.states\.([A-Za-z_]\w*)\s*=\s*State\s*\{/;
const ANUBIS_CONFIG_DEF_RE = /\bgame\.configs\.([A-Za-z_]\w*)\s*=\s*Config\s*\{/;
const ANUBIS_NODE_DEF_RE = /\bnodes(?:\.([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*))?\s*=\s*(Action|Selector|Proxy)\s*\{/;
const ANUBIS_EVENT_DEF_RE = /\bevents\.([A-Za-z_]\w*)\s*=\s*function\b/;
const ANUBIS_CALLBACK_DEF_RE = /\b(CanEnter|Valid|OnFinished|OnLeave|OnEnter|OnUpdate|OnFailed)\s*=\s*function\b/;
const ANUBIS_DOTTED_REF_RE =
  /\b(?:game\.(?:states|roots|configs)\.[A-Za-z_]\w*|MovementSpeed\.[A-Za-z_]\w*|error\.[A-Za-z_][\w.]*)\b/g;
const ANUBIS_CALL_RE = /\b([A-Za-z_]\w*)\s*\(/g;
const ANUBIS_CALL_SKIP = new Set([
  'and',
  'end',
  'false',
  'function',
  'if',
  'local',
  'nil',
  'not',
  'or',
  'return',
  'then',
  'true',
]);
const ANUBIS_DSL_CONSTRUCTORS = new Set(['Action', 'Config', 'Proxy', 'Selector', 'State']);

interface AnubisState {
  ctx: Bg3Context;
  root: Node;
  currentBehavior: Node | null;
}

interface AnubisRootArgs {
  name: string;
  kind: 'config' | 'state';
  line: string;
  lineNumber: number;
}

interface AnubisBehaviorArgs {
  name: string;
  shape: string;
  line: string;
  lineNumber: number;
}

interface AnubisHandlerArgs {
  name: string;
  signature: string;
  line: string;
  lineNumber: number;
}

function createAnubisState(filePath: string, source: string): AnubisState {
  const ctx = createContext(filePath, source, 'bg3_anubis');
  return { ctx, root: ctx.fileNode, currentBehavior: null };
}

function createAnubisRoot(state: AnubisState, args: AnubisRootArgs): void {
  state.root = createNode(state.ctx, {
    kind: args.kind === 'state' ? 'module' : 'resource',
    name: args.name,
    qualifiedName: `game.${args.kind === 'state' ? 'states' : 'configs'}.${args.name}`,
    signature: args.kind === 'state' ? 'Anubis State' : 'Anubis Config',
    startLine: args.lineNumber,
    startColumn: args.line.indexOf(args.name),
  });
  state.currentBehavior = null;
}

function createAnubisBehavior(state: AnubisState, args: AnubisBehaviorArgs): void {
  state.currentBehavior = createNode(state.ctx, {
    kind: 'method',
    name: args.name,
    qualifiedName: `${state.root.name}::${args.name}`,
    signature: `Anubis ${args.shape}`,
    startLine: args.lineNumber,
    startColumn: args.line.indexOf(args.name),
    containerId: state.root.id,
  });
}

function createAnubisHandler(state: AnubisState, args: AnubisHandlerArgs): void {
  const isEvent = args.name.startsWith('event:');
  const rawName = args.name.startsWith('event:') ? args.name.slice(6) : args.name.slice(9);
  createNode(state.ctx, {
    kind: 'method',
    name: args.name,
    qualifiedName: `${state.root.name}::${args.name}:${args.lineNumber}`,
    signature: args.signature,
    startLine: args.lineNumber,
    startColumn: args.line.indexOf(rawName),
    containerId: isEvent ? state.root.id : (state.currentBehavior?.id ?? state.root.id),
  });
  if (isEvent) state.currentBehavior = null;
}

function handleAnubisDefinition(state: AnubisState, line: string, lineNumber: number): boolean {
  const stateMatch = ANUBIS_STATE_DEF_RE.exec(line);
  if (stateMatch) {
    createAnubisRoot(state, { name: stateMatch[1] ?? '', kind: 'state', line, lineNumber });
    return true;
  }
  const configMatch = ANUBIS_CONFIG_DEF_RE.exec(line);
  if (configMatch) {
    createAnubisRoot(state, { name: configMatch[1] ?? '', kind: 'config', line, lineNumber });
    return true;
  }
  const nodeMatch = ANUBIS_NODE_DEF_RE.exec(line);
  if (nodeMatch) {
    createAnubisBehavior(state, { name: nodeMatch[1] ?? 'nodes', shape: nodeMatch[2] ?? 'Node', line, lineNumber });
    return true;
  }
  return false;
}

function handleAnubisHandler(state: AnubisState, line: string, lineNumber: number): void {
  const eventMatch = ANUBIS_EVENT_DEF_RE.exec(line);
  if (eventMatch) {
    createAnubisHandler(state, {
      name: `event:${eventMatch[1] ?? ''}`,
      signature: 'Anubis event handler',
      line,
      lineNumber,
    });
    return;
  }
  const callbackMatch = ANUBIS_CALLBACK_DEF_RE.exec(line);
  if (callbackMatch) {
    createAnubisHandler(state, {
      name: `callback:${callbackMatch[1] ?? ''}`,
      signature: 'Anubis node callback',
      line,
      lineNumber,
    });
  }
}

function addAnubisCodeRefs(state: AnubisState, line: string, lineNumber: number): void {
  const fromNodeId = state.currentBehavior?.id ?? state.root.id;
  for (const match of line.matchAll(ANUBIS_DOTTED_REF_RE)) {
    addReference(state.ctx, {
      fromNodeId,
      rawName: match[0],
      kind: 'references',
      line: lineNumber,
      column: match.index ?? 0,
    });
  }
  for (const match of line.matchAll(GUIDSTRING_RE)) {
    addReference(state.ctx, {
      fromNodeId,
      rawName: match[0],
      kind: 'references',
      line: lineNumber,
      column: match.index ?? 0,
    });
  }
}

function shouldKeepAnubisString(value: string): boolean {
  if (isBg3ResourceIdentifier(value)) return true;
  return isQualifiedIdentifier(value, '_.:-');
}

function extractLuaLongBracketValues(line: string): QuotedValue[] {
  const values: QuotedValue[] = [];
  let cursor = 0;
  while (cursor < line.length) {
    const open = line.indexOf('[[', cursor);
    if (open < 0) return values;
    const close = line.indexOf(']]', open + 2);
    if (close < 0) return values;
    values.push({ value: line.slice(open + 2, close), start: open + 2, raw: line.slice(open, close + 2) });
    cursor = close + 2;
  }
  return values;
}

function extractLuaStringValues(line: string): QuotedValue[] {
  return [...extractQuotedValues(line), ...extractLuaLongBracketValues(line)].sort((a, b) => a.start - b.start);
}

function addAnubisStringRefs(state: AnubisState, line: string, lineNumber: number): void {
  const fromNodeId = state.currentBehavior?.id ?? state.root.id;
  for (const match of extractLuaStringValues(line)) {
    const value = match.value;
    if (!shouldKeepAnubisString(value)) continue;
    for (const token of extractReferenceTokens(value)) {
      addReference(state.ctx, {
        fromNodeId,
        rawName: token,
        kind: 'references',
        line: lineNumber,
        column: match.start,
      });
    }
  }
}

function addAnubisCallRefs(state: AnubisState, line: string, lineNumber: number): void {
  const fromNodeId = state.currentBehavior?.id ?? state.root.id;
  for (const match of line.matchAll(ANUBIS_CALL_RE)) {
    const name = match[1] ?? '';
    if (!name || ANUBIS_CALL_SKIP.has(name) || ANUBIS_DSL_CONSTRUCTORS.has(name)) continue;
    addReference(state.ctx, {
      fromNodeId,
      rawName: name,
      kind: 'calls',
      line: lineNumber,
      column: match.index ?? 0,
    });
  }
}

function extractAnubisLine(state: AnubisState, rawLine: string, lineNumber: number): void {
  const line = stripLineComment(rawLine, '--').trim();
  if (!line) return;
  handleAnubisDefinition(state, line, lineNumber);
  handleAnubisHandler(state, line, lineNumber);
  addAnubisCodeRefs(state, line, lineNumber);
  addAnubisStringRefs(state, line, lineNumber);
  addAnubisCallRefs(state, line, lineNumber);
}

export function extractAnubis(filePath: string, source: string): ExtractionResult {
  const startTime = Date.now();
  const state = createAnubisState(filePath, source);
  const lines = source.split('\n');
  for (const [idx, rawLine] of lines.entries()) {
    extractAnubisLine(state, rawLine, idx + 1);
  }
  return finish(state.ctx, startTime);
}
