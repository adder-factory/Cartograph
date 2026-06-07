; Baseline code-navigation tags for tree-sitter-verilog.

(module_declaration
  (module_header
    (simple_identifier) @name)
) @definition.module

(package_declaration
  (package_identifier
    (simple_identifier) @name)
) @definition.module

(interface_declaration
  (interface_ansi_header
    (interface_identifier
      (simple_identifier) @name))
) @definition.interface

(class_declaration
  (class_identifier
    (simple_identifier) @name)
) @definition.class

(function_declaration
  (function_body_declaration
    (function_identifier
      (function_identifier
        (simple_identifier) @name)))
) @definition.function

(task_declaration
  (task_body_declaration
    (task_identifier
      (task_identifier
        (simple_identifier) @name)))
) @definition.function
