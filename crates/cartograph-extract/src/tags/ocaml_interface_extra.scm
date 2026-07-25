
; Interface declarations
;-----------------------

(
  (comment)? @doc .
  (value_specification
    (value_name) @name
  ) @definition.function
  (#strip! @doc "^\\(\\*+\\s*|\\s*\\*+\\)$")
)
