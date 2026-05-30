import type { ExtractionResult } from '../types.js';
import { compact } from '../utils.js';
import { errMsg } from '../errors.js';
import { StandaloneExtractor } from './standalone-extractor.js';

/**
 * Custom extractor for Delphi DFM/FMX form files.
 *
 * DFM/FMX files describe the visual component hierarchy and event handler
 * bindings. They use a simple text format (object/end blocks) that we parse
 * with regex — no tree-sitter grammar exists for this format.
 *
 * Extracted information:
 * - Components as NodeKind `component`
 * - Nesting as EdgeKind `contains`
 * - Event handlers (OnClick = MethodName) as UnresolvedReference → EdgeKind `references`
 */
export class DfmExtractor extends StandaloneExtractor {
  /**
   * Extract components and event handler references from DFM/FMX source
   */
  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      const fileNodeId = this.createFileNode('pascal').id;
      this.parseComponents(fileNodeId);
    } catch (error) {
      this.errors.push({
        message: `DFM extraction error: ${errMsg(error)}`,
        severity: 'error',
        code: 'parse_error',
      });
    }

    return this.result(startTime);
  }

  /** Parse object/end blocks and extract components + event handlers */
  private parseComponents(fileNodeId: string): void {
    const lines = this.source.split('\n');
    const stack: string[] = [fileNodeId];

    const objectPattern = /^\s*(object|inherited|inline)\s+(\w+)\s*:\s*(\w+)/;
    const eventPattern = /^\s*(On\w+)\s*=\s*(\w+)\s*$/;
    const endPattern = /^\s*end\s*$/;
    const multiLineState = { active: false, endChar: ')' };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const lineNum = i + 1;

      if (advanceMultiLineState(line, multiLineState)) continue;

      const objMatch = line.match(objectPattern);
      if (objMatch) {
        this.emitComponent({ objMatch, lineNum, line, stack });
        continue;
      }

      const eventMatch = line.match(eventPattern);
      if (eventMatch) {
        this.emitEventHandler(eventMatch, lineNum, stack);
        continue;
      }

      if (endPattern.test(line) && stack.length > 1) stack.pop();
    }
  }

  /** Push a `component` node + `contains` edge for an `object/inherited/inline` line. */
  private emitComponent(args: { objMatch: RegExpMatchArray; lineNum: number; line: string; stack: string[] }): void {
    const { objMatch, lineNum, line, stack } = args;
    const [, , name, typeName] = objMatch;
    const nodeId = this.idFactory.next('component', name!);
    this.nodes.push(
      compact({
        id: nodeId,
        kind: 'component',
        name: name!,
        qualifiedName: `${this.filePath}#${name}`,
        filePath: this.filePath,
        language: 'pascal',
        startLine: lineNum,
        endLine: lineNum,
        startColumn: 0,
        endColumn: line.length,
        signature: typeName,
        updatedAt: Date.now(),
      }),
    );
    this.edges.push({ source: stack.at(-1)!, target: nodeId, kind: 'contains' });
    stack.push(nodeId);
  }

  /** Record an `OnX = MethodName` event-handler binding as an unresolved reference. */
  private emitEventHandler(eventMatch: RegExpMatchArray, lineNum: number, stack: string[]): void {
    const [, , methodName] = eventMatch;
    this.unresolvedReferences.push({
      fromNodeId: stack.at(-1)!,
      referenceName: methodName!,
      referenceKind: 'references',
      line: lineNum,
      column: 0,
    });
  }
}

/**
 * Advance the multi-line property state machine for one source line.
 * Returns true when the caller should `continue` (line is multi-line content
 * or a multi-line opener); false to fall through to component / event matching.
 */
function advanceMultiLineState(line: string, state: { active: boolean; endChar: string }): boolean {
  if (state.active) {
    if (line.trimEnd().endsWith(state.endChar)) state.active = false;
    return true;
  }
  if (/=\s*\(\s*$/.test(line)) {
    state.active = true;
    state.endChar = ')';
    return true;
  }
  if (/=\s*<\s*$/.test(line)) {
    state.active = true;
    state.endChar = '>';
    return true;
  }
  return false;
}
