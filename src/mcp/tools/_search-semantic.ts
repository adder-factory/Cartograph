/**
 * @internal — semantic-mode handler for the consolidated
 * `cartograph_search({mode: 'semantic'})` family. Lives in its own
 * file (prefixed `_` to discourage external import) to keep the
 * family dispatcher small. Logic preserved verbatim from the prior
 * `similar.ts` so eval baseline is unchanged.
 *
 * Two sub-shapes (mutually exclusive within mode='semantic'):
 *  - `symbol`: peers of one source symbol (requires source to have
 *    an embedding row).
 *  - `query`: free-text concept search (text embedded on the fly,
 *    nearest cluster returned).
 */

import type { ToolResult } from '../tool-types.js';
import type Cartograph from '../../index.js';
import { hasSymbolEmbedding } from '../../db/queries-embeddings.js';
import { getSymbolDescriptions, type SymbolDescription } from '../../db/queries-summaries.js';
import { clamp, numArg } from '../../utils.js';
import { getEmbeddingModel } from '../../llm/provider.js';
import { textResult, truncateOutput } from './shared.js';
import { type ToolOutcome, ok, err } from './_outcome.js';
import { findSymbol, symbolNotFound, withDisambiguationBanner } from './symbol-resolver.js';
import type { ToolCtx } from './types.js';
import type { Node, SearchResult } from '../../types.js';
import { llmFindImplementations, llmFindSimilar } from '../../cartograph-llm-service.js';
import { renderMarkdownCardList, type MarkdownCardListSpec } from './_result-spec.js';

export async function handleSearchSemantic(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  const limit = clamp(numArg(args['limit'], 10), 1, 100);
  const symbolArg = args['symbol'] as string | undefined;
  const queryArg = args['query'] as string | undefined;

  if (!symbolArg && !queryArg) {
    return err('mode=semantic: pass either `symbol` (peers of one symbol) or `query` (cluster nearest to a concept).');
  }
  if (symbolArg && queryArg) {
    return err('mode=semantic: `symbol` and `query` are mutually exclusive — pick one.');
  }

  if (queryArg) {
    return ok(
      await handleSemanticConcept({
        cg,
        query: queryArg,
        languageFilter: args['languageFilter'] as string | undefined,
        limit,
      }),
    );
  }

  return ok(
    await handleSemanticSymbol({
      cg,
      symbol: symbolArg!,
      refIds: ctx.refIds,
      limit,
      sameLanguage: args['sameLanguage'] === true,
      differentLanguage: args['differentLanguage'] === true,
    }),
  );
}

/** `mode=semantic, query=<concept>` branch: free-text concept search.
 *  Embeds the query string on the fly and returns the nearest cluster. */
interface HandleSemanticConceptArgs {
  cg: Cartograph;
  query: string;
  languageFilter: string | undefined;
  limit: number;
}

/**
 * Build the concept-cluster card-list spec — H2 outer heading carries
 * the query string + hit count; one H3 card per result with the
 * cosine score in the heading and `file:line` + optional
 * `\`signature\`` in the body.
 *
 * `score` renders as raw decimal via `toFixed(3)` (NOT multiplied
 * by 100): the in-memory cache path (`topKByCosineMatrix`) can return
 * raw dot products exceeding 1.0 when embeddings aren't L2-normalised,
 * so `*100` would yield grotesque "12439% similar" labels. Kept
 * consistent with the peer-symbol tool ({@link buildSearchSemanticSymbolSpec}).
 *
 * Caller (`handleSemanticConcept`) short-circuits the empty-results
 * path via `textResult(reason)` BEFORE this builder is called, so
 * `emptyState` is the never-rendered empty string.
 */
export function buildSearchSemanticConceptSpec(
  query: string,
  results: ReadonlyArray<SearchResult>,
): MarkdownCardListSpec<SearchResult> {
  // Title uses unconditional plural "hits" — pre-migration template
  // literal didn't pluralize, so `results.length === 1` renders "(1
  // hits)". Kept verbatim for byte-parity with the eval baseline; the
  // wording-lint test locks this exact string. Do NOT switch to
  // `1 hit / N hits` here without updating both spots together — same
  // singular/plural shape `buildSearchFuzzySpec` uses correctly is a
  // wording-cleanup follow-up, not a structural migration concern.
  return {
    title: `Concept cluster for "${query}" (${results.length} hits)`,
    rows: results,
    rowHeading: (r) => `${r.node.name} (${r.node.kind}) — score ${r.score.toFixed(3)}`,
    rowBody: (r) => {
      const body: string[] = [`${r.node.filePath}:${r.node.startLine}`];
      if (r.node.signature) body.push(`\`${r.node.signature}\``);
      return body;
    },
    emptyState: '',
  };
}

async function handleSemanticConcept(args: HandleSemanticConceptArgs): Promise<ToolResult> {
  const { cg, query, languageFilter, limit } = args;
  const opts: { limit?: number; languageFilter?: string } = { limit };
  if (languageFilter) opts.languageFilter = languageFilter;
  const results = await llmFindImplementations(cg.llm, query, opts);
  if (results.length === 0) {
    const llmConfig = await cg.llm.getEffectiveLlmConfig();
    const embModel = getEmbeddingModel(llmConfig);
    const reason = embModel
      ? `No symbols matched the concept "${query}". Either no embeddings have been generated yet (run \`cartograph_admin({action: 'summarize'})\` to populate them) or the corpus genuinely has no peers for that concept.`
      : 'No embedding model configured. Set config.llm.embeddingLlm (legacy config.llm.embeddings or flat config.llm.embeddingModel also accepted).';
    return textResult(reason);
  }
  return textResult(truncateOutput(renderMarkdownCardList(buildSearchSemanticConceptSpec(query, results)).trimEnd()));
}

interface SemanticSymbolArgs {
  cg: Cartograph;
  symbol: string;
  refIds: ToolCtx['refIds'];
  limit: number;
  sameLanguage: boolean;
  differentLanguage: boolean;
}

/**
 * Build the peer-symbol card-list spec — H2 outer heading carries the
 * source symbol's name + kind + location; one H3 card per neighbour
 * with `[score X, lang Y]` in the heading and `file:line` + optional
 * `> description _(via source)_` blockquote in the body.
 *
 * Heading shape uses TWO spaces between `(kind)` and `[score …]` —
 * byte-parity with the pre-migration template literal. Score renders
 * via `toFixed(3)` (raw decimal), matching {@link buildSearchSemanticConceptSpec}.
 *
 * Caller (`handleSemanticSymbol`) short-circuits the empty-results
 * path via `textResult(explainEmptySemanticSymbolResult(...))` BEFORE
 * this builder is called, so `emptyState` is the never-rendered empty
 * string.
 */
export function buildSearchSemanticSymbolSpec(args: {
  sourceNode: Pick<Node, 'name' | 'kind' | 'filePath' | 'startLine'>;
  results: ReadonlyArray<SearchResult>;
  descriptions: Map<string, SymbolDescription>;
}): MarkdownCardListSpec<SearchResult> {
  const { sourceNode, results, descriptions } = args;
  return {
    title: `Similar to ${sourceNode.name} (${sourceNode.kind}) — ${sourceNode.filePath}:${sourceNode.startLine}`,
    rows: results,
    rowHeading: (r) => `${r.node.name} (${r.node.kind})  [score ${r.score.toFixed(3)}, lang ${r.node.language}]`,
    rowBody: (r) => {
      const loc = r.node.startLine ? `:${r.node.startLine}` : '';
      const body: string[] = [`${r.node.filePath}${loc}`];
      const d = descriptions.get(r.node.id);
      if (d) body.push(`> ${d.text} _(via ${d.source})_`);
      return body;
    },
    emptyState: '',
  };
}

/** `mode=semantic, symbol=<name>` branch: embedding-peer search.
 *  Resolves the source symbol, looks up its embedding row, returns
 *  cosine-nearest neighbours. */
async function handleSemanticSymbol(args: SemanticSymbolArgs): Promise<ToolResult> {
  const { cg, symbol, refIds, limit, sameLanguage, differentLanguage } = args;
  const match = findSymbol(cg, symbol, refIds);
  if (!match) return textResult(symbolNotFound(cg, symbol));

  const results = await llmFindSimilar(cg.llm, match.node.id, { limit, sameLanguage, differentLanguage });
  if (results.length === 0) {
    return textResult(await explainEmptySemanticSymbolResult(cg, match.node));
  }

  const descriptions = getSymbolDescriptions(
    cg.queries,
    results.map((r) => r.node.id),
  );
  const body = renderMarkdownCardList(buildSearchSemanticSymbolSpec({ sourceNode: match.node, results, descriptions }));
  // Banner-at-top convention (structural fix #30): when the source
  // symbol was one of N homonyms, the picked node drives every
  // similarity result that follows — agents need to spot the
  // disambiguation BEFORE acting on the peer list. Pre-#30 the note
  // was silently dropped here, so the agent could act on the
  // wrong-symbol's semantic peers.
  return textResult(withDisambiguationBanner(match.note, truncateOutput(body)));
}

/** Build the empty-result reason for a symbol search. Three sub-cases:
 *  no model configured / no embedding row for this symbol / no peer
 *  passed cosine threshold. */
async function explainEmptySemanticSymbolResult(cg: Cartograph, node: { id: string; name: string }): Promise<string> {
  const llmConfig = await cg.llm.getEffectiveLlmConfig();
  const embModel = getEmbeddingModel(llmConfig);
  if (!embModel) {
    return 'No embedding model configured. Run `cartograph admin install-models --write-config` to auto-wire the recommended stack (llama-server HTTP for every tier — embedding on :8080, chat on :8081, ask on :8082, reranker on :8083). Other OpenAI-compat backends (Ollama on :11434, mlx_lm.server on :8000, LM Studio on :1234) also work — set `config.llm.embeddingLlm.endpoint` accordingly.';
  }
  if (!hasSymbolEmbedding(cg.queries, node.id, embModel)) {
    return `Source symbol \`${node.name}\` has no embedding row for model \`${embModel}\` yet — the background pass hasn't reached this symbol. Run \`cartograph_admin({action: 'summarize'})\` (which embeds as a side-effect), or wait for the next sync.`;
  }
  return `Source has an embedding under model \`${embModel}\`, but no neighbours scored above the cosine threshold. The symbol may genuinely be unique in this codebase, or its summary captures something the rest of the corpus doesn't talk about.`;
}
