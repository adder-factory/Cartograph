/**
 * Per-language tree-sitter node-kind sets the biomarker engine
 * consults. Tree-sitter grammars don't share a vocabulary across
 * languages, so each language maps its native node names onto a
 * small, normalised vocabulary the engine reasons about:
 *
 *   - branching:   nodes that add a new branch to cyclomatic complexity
 *                  (if/case/for/while/catch).
 *   - nesting:     nodes that add a new logical-nesting level.
 *   - boolean_op:  binary boolean operators (&&, ||) and similar — used
 *                  to count operands inside a conditional.
 *   - conditional: top-level conditional nodes whose internal boolean
 *                  operands feed the Complex Conditional biomarker.
 *
 * Languages without an entry get no biomarker findings — safe default.
 * Adding TS/JS first (most common in codebases this targets); other
 * languages can drop in by adding a key here.
 */

export interface LangMap {
  branching: ReadonlySet<string>;
  nesting: ReadonlySet<string>;
  booleanOp: ReadonlySet<string>;
  conditional: ReadonlySet<string>;
  /** Node kinds that count toward "the &&/|| operands inside a
   *  conditional" — for the Complex Conditional biomarker. Includes
   *  comparison operators since `(a > b && c < d || e === f)` has
   *  three comparisons + two boolean operators = 5 operands. */
  conditionalOperand: ReadonlySet<string>;
}

const TS_JS: LangMap = {
  branching: new Set([
    // McCabe counts each decision point that adds a path. `else_clause`
    // is the *implicit default* of an `if` and is NOT counted —
    // including it would inflate every if/else pair to +2.
    'if_statement',
    'for_statement',
    'for_in_statement',
    'for_of_statement',
    'while_statement',
    'do_statement',
    'switch_case',
    'switch_default',
    'catch_clause',
    'ternary_expression',
  ]),
  nesting: new Set([
    'if_statement',
    'for_statement',
    'for_in_statement',
    'for_of_statement',
    'while_statement',
    'do_statement',
    'switch_statement',
    'try_statement',
    'catch_clause',
  ]),
  booleanOp: new Set([
    'binary_expression', // && / || are binary_expression with operator field
    'logical_expression',
  ]),
  conditional: new Set([
    'if_statement',
    'ternary_expression',
    'while_statement',
    'do_statement',
    'for_statement',
    'switch_statement',
  ]),
  conditionalOperand: new Set([
    'binary_expression',
    'logical_expression',
    'unary_expression',
    'identifier',
    'member_expression',
    'call_expression',
  ]),
};

const PY: LangMap = {
  branching: new Set([
    // McCabe excludes the implicit default — keep `if`, `elif`,
    // `except`, `case` (each adds a path) but NOT `else_clause` or
    // `try_statement` (the latter is the container; `except_clause`
    // is the actual decision point that gets counted).
    'if_statement',
    'elif_clause',
    'for_statement',
    'while_statement',
    'except_clause',
    'conditional_expression',
    'case_clause',
  ]),
  nesting: new Set([
    'if_statement',
    'for_statement',
    'while_statement',
    'try_statement',
    'with_statement',
    'match_statement',
  ]),
  booleanOp: new Set(['boolean_operator']),
  conditional: new Set(['if_statement', 'conditional_expression', 'while_statement']),
  conditionalOperand: new Set(['comparison_operator', 'boolean_operator', 'identifier', 'attribute', 'call']),
};

const GO: LangMap = {
  branching: new Set([
    'if_statement',
    'for_statement',
    'expression_case',
    'default_case',
    'select_statement',
    'communication_case',
  ]),
  nesting: new Set(['if_statement', 'for_statement', 'switch_statement', 'select_statement']),
  booleanOp: new Set(['binary_expression']),
  conditional: new Set(['if_statement', 'for_statement']),
  conditionalOperand: new Set([
    'binary_expression',
    'unary_expression',
    'identifier',
    'selector_expression',
    'call_expression',
  ]),
};

const RUST: LangMap = {
  // F#31 (2026-05-26) — Rust per-symbol biomarkers (large_method,
  // complex_method, nested_complexity, long_parameter_list,
  // brain_method) never fired because `MAPS` lacked a `rust` key.
  // Surfaced by the 2026-05-26 bug-hunt against helix-editor/helix:
  // 438-LOC `handle_debugger_message` reported Code Health 10/10
  // until this entry landed. Node-kind names verified against the
  // vendored `src/extraction/wasm/rust.wasm` grammar via a
  // throwaway `/tmp/debug-rust-ast.mjs` probe (reviewer-memo §11).
  branching: new Set([
    // McCabe — each decision point that adds a path. `else_clause` is
    // the implicit default of an `if_expression` and is excluded.
    // `match_expression` is the container; `match_arm` is the per-arm
    // decision point. `loop_expression` is unconditional (no test
    // condition) and adds no branch — it appears in `nesting` only.
    'if_expression',
    'for_expression',
    'while_expression',
    'match_arm',
  ]),
  nesting: new Set(['if_expression', 'for_expression', 'while_expression', 'loop_expression', 'match_expression']),
  // Rust's `&&` / `||` are both `binary_expression` nodes with operator
  // fields — the same shape as Java / JS in this grammar.
  booleanOp: new Set(['binary_expression']),
  conditional: new Set(['if_expression', 'while_expression', 'for_expression', 'match_expression']),
  conditionalOperand: new Set([
    'binary_expression',
    'unary_expression',
    'identifier',
    'field_expression',
    'call_expression',
  ]),
};

const JAVA: LangMap = {
  branching: new Set([
    'if_statement',
    'for_statement',
    'enhanced_for_statement',
    'while_statement',
    'do_statement',
    'switch_label',
    'catch_clause',
    'ternary_expression',
  ]),
  nesting: new Set([
    'if_statement',
    'for_statement',
    'enhanced_for_statement',
    'while_statement',
    'do_statement',
    'switch_expression',
    'try_statement',
  ]),
  booleanOp: new Set(['binary_expression']),
  conditional: new Set(['if_statement', 'ternary_expression', 'while_statement', 'do_statement']),
  conditionalOperand: new Set([
    'binary_expression',
    'unary_expression',
    'identifier',
    'field_access',
    'method_invocation',
  ]),
};

// LangMap audit batch (2026-05-26) — entries for 9 additional languages
// previously absent from MAPS. Node-kind names verified via
// /tmp/debug-langmap-probe.mjs + /tmp/debug-langmap-bool.mjs +
// /tmp/debug-ruby-ast.mjs against each language's vendored wasm
// grammar (reviewer-memo §11).

const KOTLIN: LangMap = {
  // Kotlin uses `when_entry` per match-arm (like Rust's `match_arm`)
  // and three named binary-op shapes (`conjunction_expression` for &&,
  // `disjunction_expression` for ||, `comparison_expression` for <>).
  branching: new Set(['if_expression', 'for_statement', 'while_statement', 'when_entry', 'catch_block']),
  nesting: new Set([
    'if_expression',
    'for_statement',
    'while_statement',
    'try_expression',
    'catch_block',
    'when_expression',
  ]),
  booleanOp: new Set(['conjunction_expression', 'disjunction_expression']),
  conditional: new Set(['if_expression', 'when_expression', 'while_statement', 'for_statement']),
  conditionalOperand: new Set([
    'conjunction_expression',
    'disjunction_expression',
    'comparison_expression',
    'equality_expression',
    'simple_identifier',
    'navigation_expression',
    'call_expression',
  ]),
};

const CSHARP: LangMap = {
  branching: new Set([
    'if_statement',
    'for_statement',
    'while_statement',
    'do_statement',
    'switch_section',
    'catch_clause',
    'ternary_expression',
  ]),
  nesting: new Set([
    'if_statement',
    'for_statement',
    'while_statement',
    'do_statement',
    'try_statement',
    'switch_statement',
  ]),
  booleanOp: new Set(['binary_expression']),
  conditional: new Set(['if_statement', 'while_statement', 'for_statement', 'switch_statement', 'ternary_expression']),
  conditionalOperand: new Set([
    'binary_expression',
    'unary_expression',
    'identifier',
    'member_access_expression',
    'invocation_expression',
  ]),
};

// C and C++ share most node names; C++ adds try/catch. Two separate
// constants to keep the per-language Set objects distinct (avoids
// surprise mutation across language entries).
const C_BRANCHING = ['if_statement', 'for_statement', 'while_statement', 'do_statement', 'case_statement'];
const C_NESTING = ['if_statement', 'for_statement', 'while_statement', 'switch_statement'];
const C_OPERAND = ['binary_expression', 'unary_expression', 'identifier', 'field_expression', 'call_expression'];

const C: LangMap = {
  branching: new Set(C_BRANCHING),
  nesting: new Set(C_NESTING),
  booleanOp: new Set(['binary_expression']),
  conditional: new Set(['if_statement', 'while_statement', 'for_statement', 'switch_statement']),
  conditionalOperand: new Set(C_OPERAND),
};

const CPP: LangMap = {
  branching: new Set([...C_BRANCHING, 'catch_clause']),
  nesting: new Set([...C_NESTING, 'try_statement']),
  booleanOp: new Set(['binary_expression']),
  conditional: new Set(['if_statement', 'while_statement', 'for_statement', 'switch_statement']),
  conditionalOperand: new Set(C_OPERAND),
};

const PHP: LangMap = {
  branching: new Set([
    'if_statement',
    'for_statement',
    'foreach_statement',
    'while_statement',
    'do_statement',
    'case_statement',
    'catch_clause',
    'conditional_expression',
  ]),
  nesting: new Set([
    'if_statement',
    'for_statement',
    'foreach_statement',
    'while_statement',
    'do_statement',
    'try_statement',
    'switch_statement',
  ]),
  booleanOp: new Set(['binary_expression']),
  conditional: new Set([
    'if_statement',
    'while_statement',
    'for_statement',
    'switch_statement',
    'conditional_expression',
  ]),
  conditionalOperand: new Set([
    'binary_expression',
    'unary_op_expression',
    'name',
    'variable_name',
    'member_access_expression',
    'function_call_expression',
  ]),
};

const SCALA: LangMap = {
  // Scala collapses all infix forms (`&&`, `||`, comparisons, arithmetic)
  // into one `infix_expression` kind — the operator distinguishes via a
  // sibling `operator_identifier`. The single-node treatment matches
  // Java/Rust's `binary_expression` semantics for our purposes.
  branching: new Set(['if_expression', 'for_expression', 'while_expression', 'case_clause', 'catch_clause']),
  nesting: new Set(['if_expression', 'for_expression', 'while_expression', 'try_expression', 'match_expression']),
  booleanOp: new Set(['infix_expression']),
  conditional: new Set(['if_expression', 'while_expression', 'for_expression', 'match_expression']),
  conditionalOperand: new Set([
    'infix_expression',
    'prefix_expression',
    'identifier',
    'field_expression',
    'call_expression',
  ]),
};

const DART: LangMap = {
  // Dart's grammar splits logical / relational / equality into separate
  // node types — list both `logical_*` for &&/|| and `relational_*` /
  // `equality_*` for <>/==.
  branching: new Set([
    'if_statement',
    'for_statement',
    'while_statement',
    'do_statement',
    'switch_label',
    'catch_clause',
  ]),
  nesting: new Set([
    'if_statement',
    'for_statement',
    'while_statement',
    'do_statement',
    'try_statement',
    'switch_statement',
  ]),
  booleanOp: new Set(['logical_and_expression', 'logical_or_expression']),
  conditional: new Set(['if_statement', 'while_statement', 'for_statement', 'switch_statement']),
  conditionalOperand: new Set([
    'logical_and_expression',
    'logical_or_expression',
    'relational_expression',
    'equality_expression',
    'identifier',
  ]),
};

const RUBY: LangMap = {
  // Ruby's tree-sitter grammar uses bare node names (no `_statement` /
  // `_expression` suffix) AND splits each control construct into TWO
  // shapes: a block-form (`if cond ... end`) and a postfix-modifier
  // form (`expr if cond`). Both shapes add a path under McCabe so
  // both go in `branching`. `elsif` is a per-branch `case`-like
  // decision point — counted. `else` is the implicit default —
  // excluded. `begin` / `case` are containers (nesting only); their
  // per-arm `rescue` / `when` are the actual branches.
  branching: new Set([
    'if',
    'elsif',
    'if_modifier',
    'unless',
    'unless_modifier',
    'while',
    'while_modifier',
    'until',
    'until_modifier',
    'for',
    'when',
    'rescue',
  ]),
  nesting: new Set(['if', 'unless', 'while', 'until', 'for', 'case', 'begin']),
  // Ruby uses `binary` (not `binary_expression`) for all binary ops:
  // `&&`, `||`, comparisons, arithmetic — same single-node treatment
  // as Scala's `infix_expression`.
  booleanOp: new Set(['binary']),
  conditional: new Set(['if', 'unless', 'while', 'until', 'case', 'if_modifier', 'unless_modifier']),
  conditionalOperand: new Set(['binary', 'unary', 'identifier', 'call', 'constant']),
};

const SWIFT: LangMap = {
  // Swift uses `switch_entry` per match-arm (like Kotlin's
  // `when_entry`) and Kotlin-style `conjunction_expression` /
  // `disjunction_expression`. Swift has no do-while loop — `do {}`
  // is purely the try-catch container (do-while loops parse as
  // `repeat_while_statement`), so `do_statement` belongs in nesting
  // only; `catch_block` is the sole branching node for try-catch
  // (mirroring Java's `try_statement` nesting + `catch_clause`
  // branching split).
  branching: new Set(['if_statement', 'for_statement', 'while_statement', 'switch_entry', 'catch_block']),
  nesting: new Set(['if_statement', 'for_statement', 'while_statement', 'do_statement', 'switch_statement']),
  booleanOp: new Set(['conjunction_expression', 'disjunction_expression']),
  conditional: new Set(['if_statement', 'while_statement', 'for_statement', 'switch_statement']),
  conditionalOperand: new Set([
    'conjunction_expression',
    'disjunction_expression',
    'comparison_expression',
    'equality_expression',
    'simple_identifier',
    'navigation_expression',
    'call_expression',
  ]),
};

/**
 * Lookup table from cartograph's language identifier to the LangMap.
 * Language identifiers come from `Language` union in `src/types.ts`.
 */
const MAPS: Record<string, LangMap> = {
  typescript: TS_JS,
  javascript: TS_JS,
  tsx: TS_JS,
  jsx: TS_JS,
  python: PY,
  go: GO,
  java: JAVA,
  rust: RUST,
  // LangMap audit batch — 8 languages added 2026-05-26. See the
  // per-language `const` definitions above for AST-shape rationale +
  // probe provenance (reviewer-memo §11).
  kotlin: KOTLIN,
  csharp: CSHARP,
  c: C,
  cpp: CPP,
  php: PHP,
  scala: SCALA,
  dart: DART,
  swift: SWIFT,
  ruby: RUBY,
};

export function getLangMap(language: string): LangMap | null {
  return MAPS[language] ?? null;
}
