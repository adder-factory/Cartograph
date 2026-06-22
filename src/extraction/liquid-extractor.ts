import { z } from 'zod';
import type { ExtractionResult, UnresolvedReference } from './types.js';
import type { Edge, Node } from '../types.js';
import type { NodeIdFactory } from './tree-sitter-helpers.js';
import { compact } from '../utils.js';
import { errMsg } from '../errors.js';
import { StandaloneExtractor } from './standalone-extractor.js';

/**
 * LiquidExtractor - Extracts relationships from Liquid template files
 *
 * Liquid is a templating language (used by Shopify, Jekyll, etc.) that doesn't
 * have traditional functions or classes. Instead, we extract:
 * - Section references ({% section 'name' %})
 * - Snippet references ({% render 'name' %} and {% include 'name' %})
 * - Schema blocks ({% schema %}...{% endschema %})
 */

// ---------------------------------------------------------------------------
// Module-level state type
// ---------------------------------------------------------------------------

interface LiquidState {
  filePath: string;
  source: string;
  nodes: Node[];
  edges: Edge[];
  unresolvedReferences: UnresolvedReference[];
  idFactory: NodeIdFactory;
}

const liquidLocalizedSchemaNameSchema = z.record(z.string(), z.unknown()).refine((value) => !Array.isArray(value));
const liquidSchemaBlockSchema = z.looseObject({
  name: z.union([z.string(), liquidLocalizedSchemaNameSchema]).optional(),
});

type LiquidSchemaName = z.infer<typeof liquidSchemaBlockSchema>['name'];

// ---------------------------------------------------------------------------
// Pure utility helpers (no state needed)
// ---------------------------------------------------------------------------

/** Get the 1-indexed line number for a character offset in `source`. */
function liquidGetLineNumber(source: string, index: number): number {
  const substring = source.substring(0, index);
  return (substring.match(/\n/g) || []).length + 1;
}

/** Get the character index of the start of a 1-indexed line. */
function liquidGetLineStart(source: string, lineNumber: number): number {
  const lines = source.split('\n');
  let index = 0;
  for (let i = 0; i < lineNumber - 1 && i < lines.length; i++) {
    index += lines[i]!.length + 1; // +1 for newline
  }
  return index;
}

function liquidSchemaNameFromJson(raw: string | undefined): string {
  if (!raw) return 'schema';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'schema';
  }

  const result = liquidSchemaBlockSchema.safeParse(parsed);
  return result.success ? liquidSchemaNameFromValue(result.data.name) : 'schema';
}

function liquidSchemaNameFromValue(name: LiquidSchemaName): string {
  const direct = nonEmptyString(name);
  if (direct) return direct;
  if (!name || typeof name !== 'object' || Array.isArray(name)) return 'schema';

  const english = Object.hasOwn(name, 'en') ? nonEmptyString(name['en']) : null;
  if (english) return english;
  for (const value of Object.values(name)) {
    const candidate = nonEmptyString(value);
    if (candidate) return candidate;
  }
  return 'schema';
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ---------------------------------------------------------------------------
// State-mutating free function
// ---------------------------------------------------------------------------

/**
 * Shared helper for liquid `{% render/include/section 'name' %}`
 * extraction: emits an import node, a component node, and an
 * unresolved reference to the partner file. Each tag type just
 * varies the partner-path template and the qualified-name prefix.
 */
/**
 * Shared helper for liquid `{% render/include/section 'name' %}`
 * extraction: emits an import node, a component node, and an
 * unresolved reference to the partner file. Each tag type just
 * varies the partner-path template and the qualified-name prefix.
 */
function liquidEmitPartnerRef(
  st: LiquidState,
  args: {
    fileNodeId: string;
    fullMatch: string;
    matchIndex: number;
    name: string;
    qualifiedTag: string; // e.g. 'render:snippet', 'section:hero'
    refPathTemplate: string; // e.g. 'snippets/hero.liquid'
  },
): void {
  const { fileNodeId, fullMatch, matchIndex, name, qualifiedTag, refPathTemplate } = args;
  const line = liquidGetLineNumber(st.source, matchIndex);
  const startColumn = matchIndex - liquidGetLineStart(st.source, line);
  const endColumn = startColumn + fullMatch.length;
  const at = { startLine: line, endLine: line, startColumn, endColumn, updatedAt: Date.now() };

  // Import node (searchability)
  const importNodeId = st.idFactory.next('import', name);
  st.nodes.push({
    id: importNodeId,
    kind: 'import',
    name,
    qualifiedName: `${st.filePath}::import:${name}`,
    filePath: st.filePath,
    language: 'liquid',
    signature: fullMatch,
    ...at,
  });
  st.edges.push({ source: fileNodeId, target: importNodeId, kind: 'contains' });

  // Component node + unresolved cross-file reference
  const nodeId = st.idFactory.next('component', qualifiedTag);
  st.nodes.push({
    id: nodeId,
    kind: 'component',
    name,
    qualifiedName: `${st.filePath}::${qualifiedTag}`,
    filePath: st.filePath,
    language: 'liquid',
    ...at,
  });
  st.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });
  st.unresolvedReferences.push({
    fromNodeId: fileNodeId,
    referenceName: refPathTemplate,
    referenceKind: 'references',
    line,
    column: startColumn,
  });
}

// ---------------------------------------------------------------------------
// Class — thin orchestrator
// ---------------------------------------------------------------------------

export class LiquidExtractor extends StandaloneExtractor {
  /**
   * Extract from Liquid source
   */
  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      // Create file node
      const fileNodeId = this.createFileNode('liquid').id;

      // Extract render/include statements (snippet references)
      this.extractSnippetReferences(fileNodeId);

      // Extract section references
      this.extractSectionReferences(fileNodeId);

      // Extract schema block
      this.extractSchema(fileNodeId);

      // Extract assign statements as variables
      this.extractAssignments(fileNodeId);
    } catch (error) {
      this.errors.push({
        message: `Liquid extraction error: ${errMsg(error)}`,
        severity: 'error',
        code: 'parse_error',
      });
    }

    return this.result(startTime);
  }

  /**
   * Extract {% render 'snippet' %} and {% include 'snippet' %} references
   */
  private extractSnippetReferences(fileNodeId: string): void {
    const st = this.state();
    const renderRegex = /\{%-?\s*(render|include)\s+['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = renderRegex.exec(this.source)) !== null) {
      const [fullMatch, tagType, snippetName] = match;
      liquidEmitPartnerRef(st, {
        fileNodeId,
        fullMatch,
        matchIndex: match.index,
        name: snippetName!,
        qualifiedTag: `${tagType}:${snippetName}`,
        refPathTemplate: `snippets/${snippetName}.liquid`,
      });
    }
  }

  /**
   * Extract {% section 'name' %} references
   */
  private extractSectionReferences(fileNodeId: string): void {
    const st = this.state();
    const sectionRegex = /\{%-?\s*section\s+['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = sectionRegex.exec(this.source)) !== null) {
      const [fullMatch, sectionName] = match;
      liquidEmitPartnerRef(st, {
        fileNodeId,
        fullMatch,
        matchIndex: match.index,
        name: sectionName!,
        qualifiedTag: `section:${sectionName}`,
        refPathTemplate: `sections/${sectionName}.liquid`,
      });
    }
  }

  /**
   * Extract {% schema %}...{% endschema %} blocks.
   *
   * One leading destructure bundles every inherited field used in
   * this loop (`source`, `idFactory`, `filePath`, `nodes`, `edges`)
   * into locals. Beyond ergonomics, it keeps the `field_access`
   * extractor from emitting one `this.x` edge per loop iteration —
   * those used to trip a false-positive `feature_envy` on inherited
   * extractor-base fields (the detector counts ancestor-class
   * accesses as foreign).
   */
  private extractSchema(fileNodeId: string): void {
    const { source, idFactory, filePath, nodes, edges } = this;
    const schemaRegex = /\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/g;
    let match: RegExpExecArray | null;

    while ((match = schemaRegex.exec(source)) !== null) {
      const [fullMatch, schemaContent] = match;
      const startLine = liquidGetLineNumber(source, match.index);
      const endLine = liquidGetLineNumber(source, match.index + fullMatch.length);

      const schemaName = liquidSchemaNameFromJson(schemaContent);

      const nodeId = idFactory.next('constant', `schema:${schemaName}`);

      const node: Node = compact({
        id: nodeId,
        kind: 'constant',
        name: schemaName,
        qualifiedName: `${filePath}::schema:${schemaName}`,
        filePath,
        language: 'liquid',
        startLine,
        endLine,
        startColumn: match.index - liquidGetLineStart(source, startLine),
        endColumn: 0,
        docstring: schemaContent?.trim().substring(0, 200),
        updatedAt: Date.now(),
      });

      nodes.push(node);
      edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });
    }
  }

  /**
   * Extract {% assign var = value %} statements
   */
  private extractAssignments(fileNodeId: string): void {
    const assignRegex = /\{%-?\s*assign\s+(\w+)\s*=/g;
    let match: RegExpExecArray | null;

    while ((match = assignRegex.exec(this.source)) !== null) {
      const [, variableName] = match;
      const line = liquidGetLineNumber(this.source, match.index);

      const nodeId = this.idFactory.next('variable', variableName!);

      const node: Node = {
        id: nodeId,
        kind: 'variable',
        name: variableName!,
        qualifiedName: `${this.filePath}::${variableName}`,
        filePath: this.filePath,
        language: 'liquid',
        startLine: line,
        endLine: line,
        startColumn: match.index - liquidGetLineStart(this.source, line),
        endColumn: match.index - liquidGetLineStart(this.source, line) + match[0].length,
        updatedAt: Date.now(),
      };

      this.nodes.push(node);
      this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });
    }
  }

  /**
   * Expose mutable state to module-scope free functions. The
   * extractor class structurally satisfies {@link LiquidState} —
   * a `this`-as-state cast avoids per-field `this.x` reads that
   * the `field_access` extractor used to read as cross-class
   * accesses (false-positive `feature_envy` on inherited fields).
   */
  private state(): LiquidState {
    return this as unknown as LiquidState;
  }
}
