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

`high_fan_out` measures distinct resolved target symbols. Repeated sites to the
same dependency and recursive self-edges do not inflate the finding. Detail
groups dependencies into calls, modules, types, composition, data flow, and
other edges. Cohesive functions that only assemble and return a facade of
focused one-call delegates abstain; mixed orchestration remains actionable.
The rule applies to executable and container symbols, not declarative constant
tables or framework-owned convention exports.
`long_parameter_list` counts caller-supplied parameters, excluding an explicit
language receiver such as Rust `self`, TypeScript's erased `this` parameter,
and conventional Python method `self`/`cls` receivers.

## Evidence contract

Each finding carries its detector, severity, metric name/value, threshold,
symbol/file identity, generation, and graph pressure used for ranking. Findings
are filtered in PostgreSQL before the response cap. Rollup mode is untruncated;
ranked mode returns an exact pre-limit count and explicit truncation.

Thresholds are native release behavior and are enforced in
`crates/cartograph-db/src/insights.rs`. Extraction metrics are produced under
`crates/cartograph-extract/src/walk/`; graph/history/coverage inputs remain
separately attributable. Do not duplicate threshold tables in another runtime.

`large_method` and the size component of `brain_method` use AST-owned code
lines. Comment blocks and opaque multiline literals count once, and nested
callable bodies belong to their own symbols. Physical source spans remain the
navigation and history boundary.

`magic_number` normalizes language numeric suffixes before applying the benign
0/1/2 rules, so typed spellings such as Rust `0_u32` retain their numeric
meaning.

`hardcoded_url` is context classified. Request/client destinations and values
assigned to endpoint-like configuration are actionable and expose
`request_destination`, `service_configuration`, or `mixed_endpoint_use` in
their detail. Form placeholders, navigation/documentation links, presentation
or vendor asset `src` values, URL-validation examples, and plain data literals
abstain. The response includes request/configuration/presentation counts so an
agent can explain the classification instead of treating every URL-shaped
string as a deployment endpoint.

`god_class` measures production behavioral methods rather than accessors or
test-only helpers. A method contributes to the size metric only when it owns at
least five code lines, and a container must also own at least five methods with
cyclomatic complexity of three or more. This keeps record accessors, settings
objects, and fluent request builders out of the finding population while still
surfacing stateful containers that combine a broad API with substantial logic.

`nested_complexity` treats direct `else if` and `elif` branches as a flat
decision ladder. They still add cyclomatic branches; a nested `if` inside an
`else` block still increases depth.

`unresolved_reference_pressure` counts unresolved references that could still
denote project declarations. Expected macro-expansion, dynamic receiver,
member-access, language-intrinsic, explicit non-local import, shell-command, and
manifest-dependency boundaries retain distinct unresolved provenance but do not
inflate that project-actionable metric. Static embedded-SQL table references
resolve to indexed SQL declarations when possible; otherwise their typed
read/write/DDL provenance remains an explicit external-schema boundary rather
than project-code symbol pressure. Relative and project-local imports stay
actionable. The references remain queryable; this classification does not
fabricate a target or convert ambiguity into a resolved edge.

`unused_export` is deliberately conservative at external boundaries. Explicit
public API declarations and files modeled as test/fixture sources are not
claimed unused merely because the indexed checkout cannot contain their
outside consumer. Internal/module exports are actionable only with zero
cross-file incoming edges; one resolved type-only or runtime consumer is enough
to abstain. Declaration-only type members never enter the export finding
population. Ambiguous targetless receiver calls conservatively count as
potential incoming use for same-named internal methods; this avoids a
dead-export claim when the graph cannot prove the receiver type. Framework-owned
exports retain their convention-specific entry-point rules.

All biomarker detectors operate on production symbol documents. Files in a
modeled test/fixture path and Rust declarations owned by `#[cfg(test)]`, a test
attribute, or an inline test module are published as test documents and stay
queryable, but do not enter the production finding population.

`forof_await` is specific to JavaScript-family `for ... of` loops whose own
body contains an `await`. Rust and other language loops, `for ... in`,
`for await ... of`, nested callbacks, and nested loops do not contribute to the
enclosing loop's metric. It also abstains when an awaited assignment feeds the
next iteration, when control can `break` or `return` after the await, or when
the loop contains the explicit `cartograph: serial-await` intent marker. A
finding therefore represents independent iterations with no detected ordering
dependency; detail reports the awaited-expression ownership and each abstention
category.

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
copies. Identifier/literal-normalized and partial candidates additionally need
a privacy-safe identifier-fingerprint overlap. Cross-file candidates use a
strict overlap floor; same-file candidates may use their shared module context
with a smaller but nonzero overlap. Cross-domain shapes with renamed callees
therefore abstain. The selected tier, peer provenance, line floor, and class
members remain visible so a semantic resemblance is never presented as an
exact duplicate. Each class emits one representative finding with
`recordScope: clone_class`; partial-clone representatives and class sizes come
from the complete in-memory overlap component rather than the bounded ten-peer
display list. Semantic representatives, class sizes, maximum scores, and
bounded member lists come from a current-generation connected component rather
than a local-neighbor minimum. Symmetric per-member rows are suppressed.

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
