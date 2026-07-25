; Baseline code-navigation tags for tree-sitter-haskell.

(header
  module: (module (module_id) @name)
) @definition.module

(function
  name: (variable) @name
) @definition.function

(data_type
  name: (name) @name
) @definition.type

(newtype
  name: (name) @name
) @definition.type

(class
  name: (name) @name
) @definition.class

(signature
  name: (variable) @name
) @definition.function
