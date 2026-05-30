/**
 * Index-hook algo-version self-heal invariant (F#85, 2026-05-29).
 *
 * Every self-healing index-hook derives its `*_ALGO_VERSION` from
 * `computeAlgoHash(import.meta.url, [<source basenames>])` so a logic change
 * forces a one-shot full re-mine on the next sync. A hook that passes `[]`
 * hashes NOTHING — `computeAlgoHash` returns the empty-input SHA constant
 * (`e3b0c44298fc1c14`) for every such caller, so its stored version never
 * changes and the self-heal silently no-ops on a logic edit (it only re-mines
 * on first run + changed-file syncs). All 10 hooks shipped with `[]` until
 * this fix. These invariants catch a regression back to `[]`.
 */
import { describe, it, expect } from 'vitest';
import { GO_IMPLEMENTS_ALGO_VERSION } from '../src/index-hooks/go-implements.js';
import { DRUPAL_HOOKS_ALGO_VERSION } from '../src/index-hooks/drupal-hooks.js';
import { DRUPAL_PLUGINS_ALGO_VERSION } from '../src/index-hooks/drupal-plugins.js';
import { DRUPAL_SERVICE_TAGS_ALGO_VERSION } from '../src/index-hooks/drupal-service-tags.js';
import { NESTJS_ROUTES_ALGO_VERSION } from '../src/index-hooks/nestjs-routes.js';
import { MYBATIS_BINDING_ALGO_VERSION } from '../src/index-hooks/mybatis-binding.js';
import { SPRING_VALUE_BINDING_ALGO_VERSION } from '../src/index-hooks/spring-value-binding.js';
import { VALUE_REF_EDGES_ALGO_VERSION } from '../src/index-hooks/value-ref-edges.js';
import { FABRIC_NATIVE_IMPL_ALGO_VERSION } from '../src/index-hooks/fabric-native-impl.js';
import { RN_EVENT_CHANNEL_ALGO_VERSION } from '../src/index-hooks/rn-event-channel.js';

/** `computeAlgoHash(url, [])` — the no-op constant a `[]` caller produces. */
const EMPTY_HASH = 'e3b0c44298fc1c14';

const HOOK_ALGO_VERSIONS: Readonly<Record<string, string>> = {
  'go-implements': GO_IMPLEMENTS_ALGO_VERSION,
  'drupal-hooks': DRUPAL_HOOKS_ALGO_VERSION,
  'drupal-plugins': DRUPAL_PLUGINS_ALGO_VERSION,
  'drupal-service-tags': DRUPAL_SERVICE_TAGS_ALGO_VERSION,
  'nestjs-routes': NESTJS_ROUTES_ALGO_VERSION,
  'mybatis-binding': MYBATIS_BINDING_ALGO_VERSION,
  'spring-value-binding': SPRING_VALUE_BINDING_ALGO_VERSION,
  'value-ref-edges': VALUE_REF_EDGES_ALGO_VERSION,
  'fabric-native-impl': FABRIC_NATIVE_IMPL_ALGO_VERSION,
  'rn-event-channel': RN_EVENT_CHANNEL_ALGO_VERSION,
};

describe('index-hook algo-version self-heal (F#85)', () => {
  it('every hook hashes real source — none is the empty-`[]` constant', () => {
    for (const [name, version] of Object.entries(HOOK_ALGO_VERSIONS)) {
      expect(version, `${name} must pass its source basenames to computeAlgoHash, not [] (F#85)`).not.toBe(EMPTY_HASH);
    }
  });

  it('hook algo-versions are distinct (each derived from its own source)', () => {
    const values = Object.values(HOOK_ALGO_VERSIONS);
    expect(new Set(values).size, 'two hooks share an algo-version — likely a stray [] or a copy-pasted basename').toBe(
      values.length,
    );
  });
});
