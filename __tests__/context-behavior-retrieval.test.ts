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

    const options = await prepareBehaviorRetrieval({
      search: { searchHybrid },
      task: 'How does extraction store nodes?',
      maxNodes: 80,
    });

    expect(searchHybrid).toHaveBeenCalledWith('How does extraction store nodes?', { limit: 160 });
    expect(options).toEqual({
      extraCandidates: [],
      behaviorBias: true,
      searchLimit: BEHAVIOR_QUESTION_SEARCH_LIMIT,
      trace: {
        requested: 'auto',
        strategy: 'hybrid',
        hybridAttempted: true,
        hybridCandidateCount: 0,
        reason: 'behavior-query',
      },
    });
  });

  it('never creates more entry-point seeds than the response node budget', async () => {
    const options = await prepareBehaviorRetrieval({
      search: { searchHybrid: async () => [] },
      task: 'When is indexing triggered?',
      maxNodes: 8,
    });

    expect(options.searchLimit).toBe(8);
  });

  it('does not call hybrid search for a non-behavior query', async () => {
    const searchHybrid = vi.fn(async () => []);

    const options = await prepareBehaviorRetrieval({
      search: { searchHybrid },
      task: 'Cartograph class fields',
      maxNodes: 20,
    });

    expect(searchHybrid).not.toHaveBeenCalled();
    expect(options).toEqual({
      extraCandidates: [],
      behaviorBias: false,
      trace: {
        requested: 'auto',
        strategy: 'lexical-graph',
        hybridAttempted: false,
        hybridCandidateCount: 0,
        reason: 'non-behavior-query',
      },
    });
  });

  it('honors explicit deterministic mode for behavior questions', async () => {
    const searchHybrid = vi.fn(async () => []);

    const options = await prepareBehaviorRetrieval({
      search: { searchHybrid },
      task: 'How does indexing decide whether to run maintenance?',
      maxNodes: 20,
      retrievalMode: 'deterministic',
    });

    expect(searchHybrid).not.toHaveBeenCalled();
    expect(options).toMatchObject({
      extraCandidates: [],
      behaviorBias: true,
      searchLimit: BEHAVIOR_QUESTION_SEARCH_LIMIT,
      trace: {
        requested: 'deterministic',
        strategy: 'lexical-graph',
        hybridAttempted: false,
        reason: 'explicit-deterministic',
      },
    });
  });

  it('reports explicit deterministic mode even when the task is not behavior-shaped', async () => {
    const searchHybrid = vi.fn(async () => []);

    const options = await prepareBehaviorRetrieval({
      search: { searchHybrid },
      task: 'Find the Config interface',
      maxNodes: 20,
      retrievalMode: 'deterministic',
    });

    expect(searchHybrid).not.toHaveBeenCalled();
    expect(options).toEqual({
      extraCandidates: [],
      behaviorBias: false,
      trace: {
        requested: 'deterministic',
        strategy: 'lexical-graph',
        hybridAttempted: false,
        hybridCandidateCount: 0,
        reason: 'explicit-deterministic',
      },
    });
  });

  it('falls back to lexical retrieval when hybrid search is unavailable', async () => {
    const searchHybrid = vi.fn(async () => {
      throw new Error('backend offline');
    });

    await expect(
      prepareBehaviorRetrieval({ search: { searchHybrid }, task: 'How does indexing run?', maxNodes: 20 }),
    ).resolves.toEqual({
      extraCandidates: [],
      behaviorBias: true,
      searchLimit: BEHAVIOR_QUESTION_SEARCH_LIMIT,
      trace: {
        requested: 'auto',
        strategy: 'lexical-graph',
        hybridAttempted: true,
        hybridCandidateCount: 0,
        reason: 'hybrid-failed',
      },
    });
  });
});
