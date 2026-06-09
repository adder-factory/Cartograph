import * as path from 'node:path';
import type { ExtractionResult } from '../../types.js';
import type { Node } from '../../../types.js';
import {
  addReference,
  commandWord,
  createContext,
  createNode,
  extractQuotedValues,
  extractReferenceTokens,
  finish,
  isIdentifierBodyChar,
  isIdentifierStartChar,
  isQualifiedIdentifier,
  readWord,
  skipWhitespace,
  startsWithWordIgnoreCase,
  stripLineComment,
  type Bg3Context,
  type QuotedValue,
} from './shared.js';

const OSIRIS_API_DECLARATIONS = new Set(['syscall', 'sysquery', 'call', 'query', 'event']);
const OSIRIS_CONTROL_PREDICATES = new Set(['IF', 'AND', 'NOT']);

type OsirisPendingBlockKind = 'proc' | 'query' | 'rule';

interface OsirisPendingBlock {
  kind: OsirisPendingBlockKind;
  line: number;
}

interface OsirisPredicateReference {
  name: string;
  targetNode: Node;
  lineNumber: number;
  column: number;
}

interface OsirisDbReference {
  name: string;
  line: number;
  column: number;
}

interface OsirisApiDeclaration {
  kind: string;
  name: string;
  rest: string;
}

interface OsirisState {
  ctx: Bg3Context;
  goalName: string;
  goal: Node;
  dbNodes: Map<string, Node>;
  section: Node | null;
  currentRule: Node | null;
  pendingBlock: OsirisPendingBlock | null;
}

function createOsirisState(filePath: string, source: string): OsirisState {
  const ctx = createContext(filePath, source, 'osiris');
  const goalName = path.basename(filePath, path.extname(filePath));
  const goal = createNode(ctx, {
    kind: 'module',
    name: goalName,
    qualifiedName: goalName,
    signature: 'Osiris goal',
    startLine: 1,
    startColumn: 0,
  });
  return {
    ctx,
    goalName,
    goal,
    dbNodes: new Map(),
    section: null,
    currentRule: null,
    pendingBlock: null,
  };
}

function ensureOsirisDbNode(state: OsirisState, ref: OsirisDbReference): Node {
  const existing = state.dbNodes.get(ref.name);
  if (existing) return existing;
  const node = createNode(state.ctx, {
    kind: 'table',
    name: ref.name,
    qualifiedName: ref.name,
    signature: 'Osiris DB',
    startLine: ref.line,
    startColumn: ref.column,
    containerId: state.section?.id ?? state.goal.id,
  });
  state.dbNodes.set(ref.name, node);
  return node;
}

function ensureOsirisBlock(state: OsirisState, firstPredicate: string, line: number): Node {
  if (state.currentRule) return state.currentRule;
  const pending = state.pendingBlock ?? { kind: 'rule', line };
  const label = osirisBlockLabel(pending.kind);
  const signaturePrefix = osirisBlockSignaturePrefix(pending.kind);
  state.currentRule = createNode(state.ctx, {
    kind: 'method',
    name: `${label}:${firstPredicate}`,
    qualifiedName: `${state.goalName}::${label}:${line}`,
    signature: `${signaturePrefix} ${firstPredicate}`,
    startLine: pending.line,
    startColumn: 0,
    containerId: state.section?.id ?? state.goal.id,
  });
  state.pendingBlock = null;
  return state.currentRule;
}

function osirisBlockLabel(kind: OsirisPendingBlockKind): string {
  if (kind === 'query') return 'query';
  return kind === 'proc' ? 'proc' : 'rule';
}

function osirisBlockSignaturePrefix(kind: OsirisPendingBlockKind): string {
  if (kind === 'query') return 'QRY';
  return kind === 'proc' ? 'PROC' : 'IF';
}

function osirisSectionName(line: string): string | null {
  let normalized = line.trim();
  if (normalized.endsWith(':')) normalized = normalized.slice(0, -1).trim();
  const upper = normalized.toUpperCase();
  if (upper === 'INIT' || upper === 'INITSECTION') return 'INIT';
  if (upper === 'KB' || upper === 'KBSECTION') return 'KB';
  if (upper === 'EXIT' || upper === 'EXITSECTION') return 'EXIT';
  return null;
}

function handleOsirisSection(state: OsirisState, line: string, lineNumber: number): boolean {
  if (startsWithWordIgnoreCase(line, 'ENDEXITSECTION')) {
    state.currentRule = null;
    state.pendingBlock = null;
    return true;
  }
  const name = osirisSectionName(line);
  if (!name) return false;
  state.currentRule = null;
  state.pendingBlock = null;
  state.section = createNode(state.ctx, {
    kind: 'namespace',
    name,
    qualifiedName: `${state.goalName}::${name}`,
    signature: 'Osiris section',
    startLine: lineNumber,
    startColumn: 0,
    containerId: state.goal.id,
  });
  return true;
}

function handleOsirisRuleControl(state: OsirisState, line: string, lineNumber: number): boolean {
  if (startsWithWordIgnoreCase(line, 'IF')) {
    state.currentRule = null;
    state.pendingBlock = { kind: 'rule', line: lineNumber };
    return true;
  }
  if (startsWithWordIgnoreCase(line, 'PROC')) {
    state.currentRule = null;
    state.pendingBlock = { kind: 'proc', line: lineNumber };
    return true;
  }
  if (startsWithWordIgnoreCase(line, 'QRY')) {
    state.currentRule = null;
    state.pendingBlock = { kind: 'query', line: lineNumber };
    return true;
  }
  return startsWithWordIgnoreCase(line, 'THEN');
}

function addOsirisPredicateReference(state: OsirisState, ref: OsirisPredicateReference): void {
  if (ref.name.startsWith('DB_')) {
    ensureOsirisDbNode(state, { name: ref.name, line: ref.lineNumber, column: ref.column });
    addReference(state.ctx, {
      fromNodeId: ref.targetNode.id,
      rawName: ref.name,
      kind: 'references',
      line: ref.lineNumber,
      column: ref.column,
    });
    return;
  }
  addReference(state.ctx, {
    fromNodeId: ref.targetNode.id,
    rawName: ref.name,
    kind: 'calls',
    line: ref.lineNumber,
    column: ref.column,
  });
}

function extractOsirisPredicates(state: OsirisState, line: string, lineNumber: number): void {
  const fromNode = state.currentRule ?? state.goal;
  for (const predicate of extractFunctionLikeNames(line)) {
    const name = predicate.value;
    if (OSIRIS_CONTROL_PREDICATES.has(name)) continue;
    const pendingBlock = state.pendingBlock;
    const targetNode = pendingBlock ? ensureOsirisBlock(state, name, lineNumber) : fromNode;
    if (pendingBlock && pendingBlock.kind !== 'rule') continue;
    addOsirisPredicateReference(state, { name, targetNode, lineNumber, column: predicate.start });
  }
}

function extractOsirisStringRefs(state: OsirisState, line: string, lineNumber: number): void {
  for (const match of extractQuotedValues(line)) {
    const targetNode = state.currentRule ?? state.goal;
    for (const token of extractReferenceTokens(match.value)) {
      addReference(state.ctx, {
        fromNodeId: targetNode.id,
        rawName: token,
        kind: 'references',
        line: lineNumber,
        column: match.start,
      });
    }
  }
}

function extractFunctionLikeNames(line: string): QuotedValue[] {
  const names: QuotedValue[] = [];
  let cursor = 0;
  while (cursor < line.length) {
    if (!isIdentifierStartChar(line[cursor])) {
      cursor++;
      continue;
    }
    const start = cursor;
    cursor++;
    while (cursor < line.length && isIdentifierBodyChar(line[cursor])) cursor++;
    const name = line.slice(start, cursor);
    const next = skipWhitespace(line, cursor);
    if (line[next] === '(') names.push({ value: name, start, raw: name });
  }
  return names;
}

function commandBracePayload(line: string, commandName: string): string | null {
  const command = commandWord(line);
  if (command?.command !== commandName) return null;
  const open = line.indexOf('{', command.end);
  if (open < 0) return null;
  const close = line.lastIndexOf('}');
  if (close <= open) return null;
  return line.slice(open + 1, close);
}

function extractOsirisAlias(state: OsirisState, line: string, lineNumber: number): boolean {
  const payload = commandBracePayload(line, 'alias_type');
  if (!payload) return false;
  const name = payload.split(',')[0]?.trim() ?? '';
  if (!name) return false;
  createNode(state.ctx, {
    kind: 'type_alias',
    name,
    qualifiedName: name,
    signature: line,
    startLine: lineNumber,
    startColumn: line.indexOf(name),
    containerId: state.goal.id,
  });
  return true;
}

function extractOsirisEnum(state: OsirisState, line: string, lineNumber: number): boolean {
  const payload = commandBracePayload(line, 'enum_type');
  if (!payload) return false;
  const parts = payload.split(',').map((part) => part.trim());
  const name = parts[0] ?? '';
  if (!name) return false;
  const enumNode = createNode(state.ctx, {
    kind: 'enum',
    name,
    qualifiedName: name,
    signature: line,
    startLine: lineNumber,
    startColumn: line.indexOf(name),
    containerId: state.goal.id,
  });
  for (const member of parts.slice(3)) {
    const memberName = memberNameFromEnumPart(member);
    if (!memberName) continue;
    createNode(state.ctx, {
      kind: 'enum_member',
      name: memberName,
      qualifiedName: `${name}.${memberName}`,
      signature: member,
      startLine: lineNumber,
      startColumn: line.indexOf(memberName),
      containerId: enumNode.id,
    });
  }
  return true;
}

function memberNameFromEnumPart(member: string): string | null {
  const eq = member.indexOf('=');
  const name = (eq < 0 ? member : member.slice(0, eq)).trim();
  return isQualifiedIdentifier(name, '_') ? name : null;
}

function osirisApiCommand(line: string): { command: string; end: number } | null {
  const command = commandWord(line);
  if (!command) return null;
  if (!OSIRIS_API_DECLARATIONS.has(command.command)) return null;
  return command;
}

function osirisApiName(line: string, start: number): { word: string; end: number } | null {
  const name = readWord(line, start);
  if (!name) return null;
  if (!isQualifiedIdentifier(name.word, '_')) return null;
  return name;
}

function parseOsirisApiDeclaration(line: string): OsirisApiDeclaration | null {
  const command = osirisApiCommand(line);
  if (!command) return null;
  const name = osirisApiName(line, command.end);
  if (!name) return null;
  return {
    kind: command.command,
    name: name.word,
    rest: line.slice(name.end).trim(),
  };
}

function osirisApiSignature(declaration: OsirisApiDeclaration): string {
  if (!declaration.rest) return `${declaration.kind} ${declaration.name}`;
  return `${declaration.kind} ${declaration.name} ${declaration.rest}`;
}

function extractOsirisApiDeclaration(state: OsirisState, line: string, lineNumber: number): boolean {
  const declaration = parseOsirisApiDeclaration(line);
  if (!declaration) return false;
  createNode(state.ctx, {
    kind: 'function',
    name: declaration.name,
    qualifiedName: declaration.name,
    signature: osirisApiSignature(declaration),
    startLine: lineNumber,
    startColumn: line.indexOf(declaration.name),
    containerId: state.goal.id,
  });
  return true;
}

function extractOsirisDeclaration(state: OsirisState, line: string, lineNumber: number): boolean {
  if (extractOsirisAlias(state, line, lineNumber)) return true;
  if (extractOsirisEnum(state, line, lineNumber)) return true;
  return extractOsirisApiDeclaration(state, line, lineNumber);
}

function extractOsirisLine(state: OsirisState, rawLine: string, lineNumber: number): void {
  const line = stripLineComment(rawLine, '//').trim();
  if (!line) return;
  if (handleOsirisSection(state, line, lineNumber)) return;
  if (handleOsirisRuleControl(state, line, lineNumber)) return;
  if (extractOsirisDeclaration(state, line, lineNumber)) return;
  extractOsirisPredicates(state, line, lineNumber);
  extractOsirisStringRefs(state, line, lineNumber);
}

export function extractOsiris(filePath: string, source: string): ExtractionResult {
  const startTime = Date.now();
  const state = createOsirisState(filePath, source);
  const lines = source.split('\n');
  for (const [idx, rawLine] of lines.entries()) {
    extractOsirisLine(state, rawLine, idx + 1);
  }
  return finish(state.ctx, startTime);
}
