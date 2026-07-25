; Baseline code-navigation tags for tree-sitter-julia.

(module_definition
  name: (identifier) @name
) @definition.module

(struct_definition
  (type_head (identifier) @name)
) @definition.struct

(abstract_definition
  (type_head (identifier) @name)
) @definition.type

(primitive_definition
  (type_head (identifier) @name)
) @definition.type

(function_definition
  (signature
    [
      (call_expression (identifier) @name)
      (typed_expression (call_expression (identifier) @name) (_))
    ])
) @definition.function

(macro_definition
  (signature
    (call_expression (identifier) @name))
) @definition.macro

(call_expression
  (identifier) @name
) @reference.call

(macrocall_expression
  (macro_identifier) @name
) @reference.call
