/**
 * Score-trace collector for `cartograph_context`'s `explain` mode.
 *
 * The retrieval scorer in `context/index.ts` is multi-channel — lexical
 * FTS merge, semantic-extra seeding, co-occurrence boost, camel/compound
 * matching, PageRank centrality, behaviour bias — and every pass mutates
 * `SearchResult.score` IN PLACE. That makes "why did symbol X rank where
 * it did?" impossible to answer without hand-instrumentation (friction
 * F-r9-1 needed a temporary `[PROBE]` log line).
 *
 * `ScoreTrace` is the standing instrument: `cbCollectAndScoreCandidates`
 * calls `snapshot()` at each pass boundary, and `finalize()` turns the
 * snapshots into a per-candidate breakdown. It is purely observational —
 * it never touches the scores — and is only constructed when the caller
 * passes `explain: true`, so the non-explain path pays nothing.
 */

import type { CandidateScoreTrace, Node, ScoreExplanation, ScorePassEntry, SearchResult } from '../types.js';

/** Default cap on near-miss (non-surviving) candidates in the output. */
const DEFAULT_NEAR_MISS_LIMIT = 8;

/** One tracked candidate: its node metadata + score per pass index. */
interface ScoreTraceRow {
  node: Node;
  /** Score after pass `i`; `undefined` where the candidate was absent. */
  scores: (number | undefined)[];
}

/**
 * Accumulates per-pass score snapshots over a single retrieval run.
 * Construct one per `findRelevantContext` call (only when explaining),
 * call `snapshot()` after each scoring pass, then `finalize()`.
 */
export class ScoreTrace {
  private readonly passNames: string[] = [];
  private readonly rows = new Map<string, ScoreTraceRow>();

  /**
   * Record every result's current score under `pass`. Candidates first
   * seen at a later pass are back-filled with `undefined` for the
   * passes they missed, so a candidate's absence is itself legible.
   */
  snapshot(pass: string, results: ReadonlyArray<SearchResult>): void {
    const idx = this.passNames.length;
    this.passNames.push(pass);
    for (const r of results) {
      let row = this.rows.get(r.node.id);
      if (!row) {
        row = { node: r.node, scores: new Array<number | undefined>(idx).fill(undefined) };
        this.rows.set(r.node.id, row);
      }
      while (row.scores.length < idx) row.scores.push(undefined);
      row.scores[idx] = r.score;
    }
  }

  /**
   * Turn the collected snapshots into a {@link ScoreExplanation}.
   * `survivors` is the final selected-candidate set (the symbols that
   * survived retrieval scoring and seed the context) — those rows are
   * marked `survived` and listed ahead of the near-misses.
   *
   * The survivor rows are emitted in the SAME order `survivors` was
   * passed in — i.e. the order the candidates appear in the context
   * output. Re-sorting them by `finalScore` here would make the trace
   * disagree with the result it is explaining (the scorer's final
   * ranking is not strictly final-score-descending).
   */
  finalize(
    query: string,
    survivors: ReadonlyArray<SearchResult>,
    nearMissLimit: number = DEFAULT_NEAR_MISS_LIMIT,
  ): ScoreExplanation {
    const survivorRank = new Map<string, number>();
    survivors.forEach((s, i) => {
      survivorRank.set(s.node.id, i);
    });
    const survivorIds = new Set(survivors.map((s) => s.node.id));
    const passCount = this.passNames.length;
    const candidates: CandidateScoreTrace[] = [];

    for (const [id, row] of this.rows) {
      const passes: ScorePassEntry[] = [];
      for (let i = 0; i < passCount; i++) {
        const s = row.scores[i];
        if (s !== undefined) passes.push({ pass: this.passNames[i]!, score: s });
      }
      candidates.push({
        nodeId: id,
        name: row.node.name,
        kind: row.node.kind,
        filePath: row.node.filePath,
        line: row.node.startLine,
        finalScore: passes.length > 0 ? passes.at(-1)!.score : 0,
        survived: survivorIds.has(id),
        passes,
      });
    }

    // Defensive: the live `findRelevantContext` path snapshots
    // `final-roots` on the exact array it then passes here, so every
    // survivor is normally covered. But `finalize` is a public method —
    // a caller that passes a survivor never seen in a snapshot still
    // gets a row (empty pass list) rather than a silent drop.
    const traced = new Set(candidates.map((c) => c.nodeId));
    for (const s of survivors) {
      if (traced.has(s.node.id)) continue;
      candidates.push({
        nodeId: s.node.id,
        name: s.node.name,
        kind: s.node.kind,
        filePath: s.node.filePath,
        line: s.node.startLine,
        finalScore: s.score,
        survived: true,
        passes: [],
      });
    }

    // Survivor rows keep the caller's order (the context output order);
    // near-misses sort by final score descending — they have no
    // intrinsic output order, so highest-scoring-first is the useful one.
    const survivorRows = candidates
      .filter((c) => c.survived)
      .sort((a, b) => (survivorRank.get(a.nodeId) ?? 0) - (survivorRank.get(b.nodeId) ?? 0));
    const nearMiss = candidates
      .filter((c) => !c.survived)
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, Math.max(0, nearMissLimit));

    return {
      query,
      passNames: [...this.passNames],
      candidates: [...survivorRows, ...nearMiss],
    };
  }
}

/** Render a signed delta suffix, or '' when the score didn't move. */
function fmtDelta(delta: number): string {
  if (Math.abs(delta) < 0.005) return '';
  return `  (${delta > 0 ? '+' : ''}${delta.toFixed(2)})`;
}

/** Width the pass-name column is padded to inside the rendered block. */
const PASS_NAME_COL = 18;

/**
 * Render a {@link ScoreExplanation} as a markdown section. The
 * per-candidate breakdown is wrapped in a fenced code block so the
 * column alignment survives markdown rendering.
 */
export function renderScoreExplanation(exp: ScoreExplanation): string {
  if (exp.candidates.length === 0) return '';

  const survivors = exp.candidates.filter((c) => c.survived).length;
  const nearMiss = exp.candidates.length - survivors;
  const lines: string[] = [
    '',
    '### Score trace (explain mode)',
    '',
    `Per-candidate score after each scoring pass — ${survivors} selected ` +
      `candidate${survivors === 1 ? '' : 's'} (\`[+]\`, in context-output order)` +
      (nearMiss > 0
        ? ` and the top ${nearMiss} near-miss${nearMiss === 1 ? '' : 'es'} (\`[-]\`, by final score)`
        : '') +
      '. A candidate listed from a later pass entered the pool there.',
    '',
    '```',
  ];

  for (const c of exp.candidates) {
    const mark = c.survived ? '[+]' : '[-]';
    lines.push(`${mark} ${c.name} (${c.kind})  ${c.filePath}:${c.line}  final ${c.finalScore.toFixed(2)}`);
    let prev: number | undefined;
    for (const p of c.passes) {
      const delta = prev === undefined ? '' : fmtDelta(p.score - prev);
      lines.push(`      ${p.pass.padEnd(PASS_NAME_COL)} ${p.score.toFixed(2)}${delta}`);
      prev = p.score;
    }
    if (c.passes.length === 0) {
      lines.push('      (no per-pass score recorded)');
    }
  }

  lines.push('```', '');
  return lines.join('\n');
}
