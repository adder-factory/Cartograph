import { describe, expect, it, vi } from 'vitest';
import {
  BEHAVIOR_QUESTION_SEARCH_LIMIT,
  looksLikeBehaviorQuestion,
  prepareBehaviorRetrieval,
} from '../src/context/behavior-retrieval.js';

describe('behavior retrieval preparation', () => {
  it('recognizes control-flow questions without classifying shape lookups', () => {
    expect(looksLikeBehaviorQuestion('How does the watcher trigger a sync?')).toBe(true);
    expect(looksLikeBehaviorQuestion('What causes the cache to refresh?')).toBe(true);
    expect(looksLikeBehaviorQuestion('FileWatcher interface fields')).toBe(false);
  });

  it('shares hybrid candidates and a bounded wider search window', async () => {
    const searchHybrid = vi.fn(async () => []);

    const options = await prepareBehaviorRetrieval({ searchHybrid }, 'How does extraction store nodes?', 80);

    expect(searchHybrid).toHaveBeenCalledWith('How does extraction store nodes?', { limit: 160 });
    expect(options).toEqual({
      extraCandidates: [],
      behaviorBias: true,
      searchLimit: BEHAVIOR_QUESTION_SEARCH_LIMIT,
    });
  });

  it('never creates more entry-point seeds than the response node budget', async () => {
    const options = await prepareBehaviorRetrieval({ searchHybrid: async () => [] }, 'When is indexing triggered?', 8);

    expect(options.searchLimit).toBe(8);
  });

  it('does not call hybrid search for a non-behavior query', async () => {
    const searchHybrid = vi.fn(async () => []);

    const options = await prepareBehaviorRetrieval({ searchHybrid }, 'Cartograph class fields', 20);

    expect(searchHybrid).not.toHaveBeenCalled();
    expect(options).toEqual({ extraCandidates: [], behaviorBias: false });
  });

  it('falls back to lexical retrieval when hybrid search is unavailable', async () => {
    const searchHybrid = vi.fn(async () => {
      throw new Error('backend offline');
    });

    await expect(prepareBehaviorRetrieval({ searchHybrid }, 'How does indexing run?', 20)).resolves.toEqual({
      extraCandidates: [],
      behaviorBias: true,
      searchLimit: BEHAVIOR_QUESTION_SEARCH_LIMIT,
    });
  });
});
