WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                ), degrees AS (
                    SELECT symbols.symbol_id,
                           COUNT(edges.source_symbol_id) FILTER (
                               WHERE edges.edge_kind NOT IN ('contains', 'def_use')
                           ) AS outgoing_edges
                    FROM {schema}."symbols" AS symbols
                    JOIN current ON current.generation_id = symbols.generation_id
                    LEFT JOIN {schema}."edges" AS edges
                      ON edges.project_id = symbols.project_id
                     AND edges.generation_id = symbols.generation_id
                     AND edges.source_symbol_id = symbols.symbol_id
                    WHERE symbols.project_id = CAST($1 AS uuid)
                    GROUP BY symbols.symbol_id
                )
                SELECT symbols.symbol_id::text,
                       files.normalized_path,
                       files.language,
                       symbols.symbol_kind,
                       symbols.qualified_name,
                       symbols.start_line,
                       0::bigint AS incoming_edges,
                       COALESCE(degrees.outgoing_edges, 0)::bigint,
                       COALESCE(documents.code, '') AS safe_code,
                       EXISTS (
                           SELECT 1
                           FROM {schema}."edges" AS containment
                           JOIN {schema}."symbols" AS parent
                             ON parent.project_id = containment.project_id
                            AND parent.generation_id = containment.generation_id
                            AND parent.symbol_id = containment.source_symbol_id
                           JOIN {schema}."edges" AS contract
                             ON contract.project_id = parent.project_id
                            AND contract.generation_id = parent.generation_id
                            AND contract.source_symbol_id = parent.symbol_id
                            AND contract.edge_kind IN ('implements', 'extends')
                           WHERE containment.project_id = symbols.project_id
                             AND containment.generation_id = symbols.generation_id
                             AND containment.target_symbol_id = symbols.symbol_id
                             AND containment.edge_kind = 'contains'
                       ) AS interface_dispatch_risk
                FROM {schema}."symbols" AS symbols
                JOIN current ON current.generation_id = symbols.generation_id
                JOIN {schema}."files" AS files
                  ON files.project_id = symbols.project_id
                 AND files.generation_id = symbols.generation_id
                 AND files.file_id = symbols.file_id
                LEFT JOIN degrees ON degrees.symbol_id = symbols.symbol_id
                LEFT JOIN LATERAL (
                    SELECT search.code
                    FROM {schema}."search_documents" AS search
                    WHERE search.project_id = symbols.project_id
                      AND search.generation_id = symbols.generation_id
                      AND search.symbol_id = symbols.symbol_id
                      AND search.document_kind IN ('symbol', 'test')
                    ORDER BY search.id
                    LIMIT 1
                ) AS documents ON true
                WHERE symbols.project_id = CAST($1 AS uuid)
                  AND symbols.symbol_kind IN (
                      'function', 'method', 'class', 'struct', 'component', 'resource'
                  )
                  AND NOT symbols.exported
                  AND NOT EXISTS (
                      SELECT 1 FROM {schema}."edges" AS incoming
                      WHERE incoming.project_id = symbols.project_id
                        AND incoming.generation_id = symbols.generation_id
                        AND incoming.target_symbol_id = symbols.symbol_id
                        AND incoming.source_symbol_id <> symbols.symbol_id
                        AND incoming.edge_kind IN (
                            'calls', 'references', 'instantiates', 'tests', 'exports',
                            'implements', 'extends', 'overrides', 'decorates'
                        )
                  )
                  AND ($2::boolean OR NOT (
                      files.normalized_path ~* '(^|/)(__tests__|tests?|specs?|scripts?|bench(es|marks?)?|examples?|samples?|demos?)(/|$)'
                      OR files.normalized_path ~* '(\.test\.|\.spec\.|_test\.|_spec\.)'
                  ))
                  AND (NOT $3::boolean OR NOT (
                      files.normalized_path ~* '(^|/)(fixtures?|test-beds?|__mocks__|mocks?)(/|$)'
                  ))
                  AND NOT (
                      files.language = 'rust'
                      AND symbols.qualified_name ~ '(^|::|[.#/$])main$'
                      AND files.normalized_path ~ '(^|/)(build|main)\.rs$|(^|/)bin/[^/]+\.rs$'
                  )
                  AND NOT (
                      files.normalized_path LIKE 'src/installer/targets/%'
                      AND symbols.symbol_kind = 'method'
                      AND symbols.qualified_name ~ '(^|::|[.#/$])(supportsLocation|detect|install|uninstall|printConfig|describePaths)$'
                  )
                  AND NOT (
                      symbols.symbol_kind = 'method'
                      AND COALESCE(symbols.visibility, 'public') NOT IN ('private', 'protected')
                      AND EXISTS (
                          SELECT 1
                          FROM {schema}."edges" AS containment
                          JOIN {schema}."symbols" AS parent
                            ON parent.project_id = containment.project_id
                           AND parent.generation_id = containment.generation_id
                           AND parent.symbol_id = containment.source_symbol_id
                          WHERE containment.project_id = symbols.project_id
                            AND containment.generation_id = symbols.generation_id
                            AND containment.target_symbol_id = symbols.symbol_id
                            AND containment.edge_kind = 'contains'
                            AND parent.exported
                            AND parent.symbol_kind IN ('class', 'struct', 'trait', 'protocol', 'interface')
                      )
                  )
                ORDER BY COALESCE(degrees.outgoing_edges, 0) DESC,
                         files.normalized_path,
                         symbols.start_line,
                         symbols.symbol_id
                LIMIT $4
