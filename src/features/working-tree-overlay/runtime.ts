import * as fsp from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import type Cartograph from '../../index.js';
import { whatChanged } from '../../change-oracle/index.js';
import {
  detectLanguage,
  extractFromSource,
  isLanguageSupported,
  loadGrammarsForLanguages,
  shouldIncludeFile,
} from '../../extraction/index.js';
import { errMsg } from '../../errors.js';
import type { Language, Node } from '../../types.js';
import type { SearchResult } from '../../search/types.js';
import { validatePathWithinRootReal } from '../../utils.js';
import { buildContextRoute } from '../context-route/index.js';
import {
  WorkingTreeOverlayReportSchema,
  type WorkingTreeOverlayFacet,
  type WorkingTreeOverlayMode,
  type WorkingTreeOverlayReport,
} from './contract.js';

export interface BuildWorkingTreeOverlayOptions {
  task: string;
  mode?: WorkingTreeOverlayMode;
  maxFiles?: number;
}

export interface WorkingTreeOverlayResult {
  report: WorkingTreeOverlayReport;
  extraCandidates: SearchResult[];
  evidenceByNodeId: ReadonlyMap<string, readonly string[]>;
}

interface OverlaySource {
  filePath: string;
  source: string;
  language: Language;
  facets: WorkingTreeOverlayFacet[];
}

const DEFAULT_OVERLAY_FILE_LIMIT = 20;
const MAX_OVERLAY_FILE_LIMIT = 100;
const OVERLAY_HIGH_SCORE = 30;
const OVERLAY_MEDIUM_SCORE = 24;

export async function buildWorkingTreeOverlay(
  cg: Cartograph,
  options: BuildWorkingTreeOverlayOptions,
): Promise<WorkingTreeOverlayResult> {
  const mode = options.mode ?? 'auto';
  if (mode === 'off') return emptyOverlay(mode, 'off');

  const snapshot = whatChanged(cg.projectRoot, cg.queries, {
    facets: new Set(['gitDiff', 'contentDrift', 'vanished']),
    gitRef: 'HEAD',
  });
  const facetsByPath = collectChangedFacets(snapshot);
  const changedFiles = [...facetsByPath.keys()].sort((a, b) => a.localeCompare(b));
  if (changedFiles.length === 0) return emptyOverlay(mode, 'clean');

  const skipped: Array<{ filePath: string; reason: string }> = [];
  const maxFiles = Math.max(1, Math.min(options.maxFiles ?? DEFAULT_OVERLAY_FILE_LIMIT, MAX_OVERLAY_FILE_LIMIT));
  const rankedFiles = rankChangedFiles(changedFiles, options.task);
  const selected = rankedFiles.slice(0, maxFiles);
  for (const filePath of rankedFiles.slice(maxFiles)) {
    skipped.push({ filePath, reason: `working-tree overlay file cap (${maxFiles})` });
  }

  const sources = await readOverlaySources(cg, selected, facetsByPath, snapshot.vanished, skipped);
  await loadGrammarsForLanguages([...new Set(sources.map((source) => source.language))]);
  const liveNodes: Node[] = [];
  const facetsByNodeId = new Map<string, WorkingTreeOverlayFacet[]>();
  const extractedFiles: string[] = [];
  for (const source of sources) {
    try {
      const extraction = extractFromSource(source.filePath, source.source, source.language);
      liveNodes.push(...extraction.nodes);
      for (const node of extraction.nodes) facetsByNodeId.set(node.id, source.facets);
      extractedFiles.push(source.filePath);
      for (const error of extraction.errors.filter((row) => row.severity === 'error')) {
        skipped.push({ filePath: source.filePath, reason: `partial extraction: ${error.message}` });
      }
    } catch (error) {
      skipped.push({ filePath: source.filePath, reason: `extraction failed: ${errMsg(error)}` });
    }
  }

  const route = buildContextRoute({ task: options.task, nodes: liveNodes });
  const liveNodesById = new Map(liveNodes.map((node) => [node.id, node]));
  const evidenceByNodeId = new Map<string, readonly string[]>();
  const extraCandidates: SearchResult[] = [];
  const candidates = route.candidates
    .filter((candidate) => candidate.confidence !== 'low')
    .flatMap((candidate) => {
      const node = liveNodesById.get(candidate.nodeId);
      const facets = facetsByNodeId.get(candidate.nodeId);
      if (!node || !facets || facets.length === 0) return [];
      const evidence = [
        ...candidate.evidence,
        `working-tree source read from disk without persisting an index sync (${facets.join(' + ')})`,
      ];
      evidenceByNodeId.set(node.id, evidence);
      extraCandidates.push({
        node,
        score: candidate.confidence === 'high' ? OVERLAY_HIGH_SCORE : OVERLAY_MEDIUM_SCORE,
      });
      return [
        {
          nodeId: node.id,
          name: node.name,
          kind: node.kind,
          filePath: node.filePath,
          line: node.startLine,
          confidence: candidate.confidence,
          facets,
          evidence,
          provenance: 'working-tree' as const,
        },
      ];
    });

  const status = skipped.length > 0 || extractedFiles.length < changedFiles.length ? 'partial' : 'ready';
  const report = WorkingTreeOverlayReportSchema.parse({
    mode,
    status,
    changedFiles,
    extractedFiles: extractedFiles.sort((a, b) => a.localeCompare(b)),
    candidates,
    skipped,
  });
  return { report, extraCandidates, evidenceByNodeId };
}

function collectChangedFacets(snapshot: ReturnType<typeof whatChanged>): Map<string, WorkingTreeOverlayFacet[]> {
  const byPath = new Map<string, WorkingTreeOverlayFacet[]>();
  if (snapshot.gitDiff) {
    for (const filePath of snapshot.gitDiff.paths) byPath.set(filePath, ['gitDiff']);
  }
  for (const filePath of snapshot.contentDrift) {
    const current = byPath.get(filePath) ?? [];
    if (!current.includes('contentDrift')) current.push('contentDrift');
    byPath.set(filePath, current);
  }
  return byPath;
}

function rankChangedFiles(files: readonly string[], task: string): string[] {
  const tokens = new Set(task.toLowerCase().match(/[a-z0-9_]+/g) ?? []);
  return [...files].sort((a, b) => {
    const scoreDiff = pathTaskScore(b, tokens) - pathTaskScore(a, tokens);
    return scoreDiff || a.localeCompare(b);
  });
}

function pathTaskScore(filePath: string, taskTokens: ReadonlySet<string>): number {
  const pathTokens = filePath.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  return pathTokens.reduce((score, token) => score + (taskTokens.has(token) ? 1 : 0), 0);
}

async function readOverlaySources(
  cg: Cartograph,
  files: readonly string[],
  facetsByPath: ReadonlyMap<string, WorkingTreeOverlayFacet[]>,
  vanished: ReadonlySet<string>,
  skipped: Array<{ filePath: string; reason: string }>,
): Promise<OverlaySource[]> {
  const out: OverlaySource[] = [];
  for (const filePath of files) {
    if (vanished.has(filePath)) {
      skipped.push({ filePath, reason: 'file was deleted from the working tree' });
      continue;
    }
    if (!shouldIncludeFile(filePath, cg.config)) {
      skipped.push({ filePath, reason: 'file is outside configured include/exclude policy' });
      continue;
    }
    const absolutePath = validatePathWithinRootReal(cg.projectRoot, filePath);
    if (!absolutePath) {
      skipped.push({ filePath, reason: 'path is missing or resolves outside the project root' });
      continue;
    }
    try {
      const stat = await fsp.stat(absolutePath);
      if (!stat.isFile()) {
        skipped.push({ filePath, reason: 'path is not a regular file' });
        continue;
      }
      if (stat.size > cg.config.maxFileSize) {
        skipped.push({ filePath, reason: `file exceeds maxFileSize (${cg.config.maxFileSize} bytes)` });
        continue;
      }
      const source = await fsp.readFile(absolutePath, 'utf8');
      if (Buffer.byteLength(source, 'utf8') > cg.config.maxFileSize) {
        skipped.push({ filePath, reason: `decoded source exceeds maxFileSize (${cg.config.maxFileSize} bytes)` });
        continue;
      }
      const language = detectLanguage(filePath, source);
      if (!isLanguageSupported(language)) {
        skipped.push({ filePath, reason: `unsupported language (${language})` });
        continue;
      }
      const facets = facetsByPath.get(filePath);
      if (!facets || facets.length === 0) continue;
      out.push({ filePath, source, language, facets });
    } catch (error) {
      skipped.push({ filePath, reason: `read failed: ${errMsg(error)}` });
    }
  }
  return out;
}

function emptyOverlay(mode: WorkingTreeOverlayMode, status: 'off' | 'clean'): WorkingTreeOverlayResult {
  return {
    report: WorkingTreeOverlayReportSchema.parse({
      mode,
      status,
      changedFiles: [],
      extractedFiles: [],
      candidates: [],
      skipped: [],
    }),
    extraCandidates: [],
    evidenceByNodeId: new Map(),
  };
}
