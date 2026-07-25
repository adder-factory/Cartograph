# Native code-health detectors

Cartograph v2 derives deterministic, generation-fenced findings from native
extraction metrics, graph structure, Git/coverage evidence, architecture
policy, and duplicate-code analysis. The detector path does not require an
LLM. LLM-based dead-code judging is a separately labeled advisory workflow and
never authorizes deletion.

The public detector names are:

- size and complexity: `large_method`, `complex_method`,
  `nested_complexity`, `complex_conditional`, `brain_method`,
  `long_parameter_list`, `god_class`, `feature_envy`;
- maintainability: `magic_number`, `hardcoded_url`, `recently_grew`,
  `stale_doc`, `unused_export`, `duplicate_code`, `incomplete_marker`,
  `empty_function_body`;
- correctness and performance: `accidental_quadratic`, `empty_catch`,
  `sync_io_in_async`, `forof_await`, `unsafe_json_parse`,
  `http_no_timeout`;
- type and agent residue: `ts_any_cast`, `ts_ignore_suppression`,
  `agent_debug_log`;
- security: `secrets_handling`, `dynamic_eval`, `insecure_hash`,
  `random_for_security`, `sql_string_concat`, `env_no_validation`;
- evidence and architecture: `low_coverage`, `illegal_import`,
  `high_fan_out`, `unresolved_reference_pressure`.

## Evidence contract

Each finding carries its detector, severity, metric name/value, threshold,
symbol/file identity, generation, and graph pressure used for ranking. Findings
are filtered in PostgreSQL before the response cap. Rollup mode is untruncated;
ranked mode returns an exact pre-limit count and explicit truncation.

Thresholds are native release behavior and are enforced in
`crates/cartograph-db/src/insights.rs`. Extraction metrics are produced under
`crates/cartograph-extract/src/walk/`; graph/history/coverage inputs remain
separately attributable. Do not duplicate threshold tables in another runtime.

`low_coverage` exists only when a generation-fenced LCOV source is loaded.
`recently_grew` and issue/churn signals require bounded Git history.
`illegal_import` requires explicit project `layers` policy. Absence of those
inputs is reported as unavailable/not configured, not a clean finding.

## Duplicate-code tiers

Duplicate analysis distinguishes:

1. exact normalized body copies;
2. identifier/literal-normalized shape clones;
3. optional wider partial clones (`duplicateCodePartialClones: true`);
4. generation/model-scoped semantic peers when matching embeddings exist.

Path globs in `duplicateCodeAllowlist` exempt deliberate generated/vendor
copies. The selected tier, peer provenance, and line floor remain visible so a
semantic resemblance is never presented as an exact duplicate.

## Privacy and safety

Extraction stores privacy-safe metrics and category masks, not secret literals.
Signatures/search documents reject literal-bearing or credential-shaped values.
Findings point an agent to exact source it must inspect; they are not proof of a
vulnerability, dead code, or safe automated edit.

Use:

```sh
cartograph biomarkers --help
cartograph review agent-audit --help
cartograph hotspots --help
cartograph coverage --help
cartograph dead-code --help
```

MCP mirrors are `cartograph_biomarkers`, `cartograph_review`,
`cartograph_hotspots`, `cartograph_coverage`, and `cartograph_dead_code`.
