import type { ExtractionResult } from '../../types.js';
import type { Node } from '../../../types.js';
import {
  addReference,
  commandWord,
  createContext,
  createNode,
  extractQuotedValues,
  finish,
  pendingRefsForField,
  readWord,
  type Bg3Field,
  type QuotedValue,
} from './shared.js';

const STATS_NEW_SHAPES = new Set(['entry', 'spellset', 'equipment', 'treasuretable']);

function parseStatsNew(line: string): { shape: string; name: string; start: number } | null {
  const command = commandWord(line);
  if (command?.command !== 'new') return null;
  const shape = readWord(line, command.end);
  if (!shape || !STATS_NEW_SHAPES.has(shape.word.toLowerCase())) return null;
  const quoted = extractQuotedValues(line).find((value) => value.start > shape.end);
  return quoted ? { shape: shape.word, name: quoted.value, start: quoted.start } : null;
}

function parseStatsQuotedCommand(line: string, commandName: string): QuotedValue | null {
  const command = commandWord(line);
  if (command?.command !== commandName) return null;
  return extractQuotedValues(line).find((value) => value.start > command.end) ?? null;
}

function parseStatsData(line: string): { name: string; value: string; valueStart: number } | null {
  const command = commandWord(line);
  if (command?.command !== 'data') return null;
  const quoted = extractQuotedValues(line).filter((value) => value.start > command.end);
  const [name, value] = quoted;
  return name && value ? { name: name.value, value: value.value, valueStart: value.start } : null;
}

function parseStatsObjectCategory(line: string): QuotedValue | null {
  const command = commandWord(line);
  if (command?.command !== 'object') return null;
  const category = readWord(line, command.end);
  if (category?.word.toLowerCase() !== 'category') return null;
  return extractQuotedValues(line).find((value) => value.start > category.end) ?? null;
}

export function extractBg3Stats(filePath: string, source: string): ExtractionResult {
  const startTime = Date.now();
  const ctx = createContext(filePath, source, 'bg3_stats');
  let current: Node | null = null;

  const lines = source.split('\n');
  lines.forEach((line, idx) => {
    const lineNumber = idx + 1;
    const newStats = parseStatsNew(line);
    if (newStats) {
      current = createNode(ctx, {
        kind: 'resource',
        name: newStats.name,
        qualifiedName: `${ctx.filePath}::${newStats.name}`,
        signature: `new ${newStats.shape}`,
        startLine: lineNumber,
        startColumn: newStats.start,
      });
      return;
    }

    const typeValue = parseStatsQuotedCommand(line, 'type');
    if (typeValue && current) {
      current.signature = `${current.signature ?? 'entry'} type=${typeValue.value}`;
      return;
    }

    const usingValue = parseStatsQuotedCommand(line, 'using');
    if (usingValue && current) {
      addReference(ctx, {
        fromNodeId: current.id,
        rawName: usingValue.value,
        kind: 'extends',
        line: lineNumber,
        column: usingValue.start,
      });
      return;
    }

    const data = parseStatsData(line);
    if (data && current) {
      const field: Bg3Field = {
        name: data.name,
        value: data.value,
        line: lineNumber,
        column: data.valueStart,
      };
      for (const ref of pendingRefsForField(field)) {
        addReference(ctx, {
          fromNodeId: current.id,
          rawName: ref.name,
          kind: ref.kind,
          line: ref.line,
          column: ref.column,
        });
      }
      return;
    }

    const addedValue = parseStatsQuotedCommand(line, 'add') ?? parseStatsObjectCategory(line);
    if (addedValue && current) {
      addReference(ctx, {
        fromNodeId: current.id,
        rawName: addedValue.value,
        kind: 'references',
        line: lineNumber,
        column: addedValue.start,
      });
    }
  });

  return finish(ctx, startTime);
}
