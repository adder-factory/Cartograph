                FROM {schema}."structural_findings" AS findings
                WHERE findings.project_id = CAST($1 AS uuid)
                  AND findings.generation_id = (
                      SELECT projects.current_generation_id
                      FROM {schema}."projects" AS projects
                      WHERE projects.project_id = CAST($1 AS uuid)
                  )
                  AND ($3::text IS NULL OR finding = $3)
                  AND CASE severity
                        WHEN 'error' THEN 3
                        WHEN 'warning' THEN 2
                        ELSE 1
                      END >= $4
                  AND ($5::double precision IS NULL OR metric >= $5)
                  AND ($6::double precision IS NULL OR metric <= $6)
                  AND ($7::double precision IS NULL OR degree_centrality >= $7)
                  AND ($8::text IS NULL OR LEFT(path, LENGTH($8)) <> $8)
                  AND ($9::text[] IS NULL OR symbol_id::text = ANY($9))
                  AND (NOT $10::boolean OR NOT (
                      path ~* '(^|/)(fixtures?|test-beds?|__tests__|__mocks__|tests?|specs?|integration|testing|testlib)(/|$)'
                      OR path ~* '(\.test\.|\.spec\.|_test\.|_spec\.)[a-z0-9]+$'
                      OR path ~ '([A-Za-z](Test|Tests|TestCase|Spec))\.[a-z0-9]+$'
                      OR path ~* '(^|/)(bench(es|marks?)?|scripts?|examples?|samples?|demos?)(/|$)'
                  ))
                  AND ($11::text IS NULL OR LEFT(path, LENGTH($11)) = $11)
