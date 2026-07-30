WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                ), population AS (
                    SELECT COUNT(*)::double precision AS symbol_count
                    FROM {schema}."symbols" AS symbols
                    JOIN current ON current.generation_id = symbols.generation_id
                    WHERE symbols.project_id = CAST($1 AS uuid)
                      AND symbols.symbol_kind NOT IN ('file', 'import', 'parameter')
                ), incoming AS (
                    SELECT edges.target_symbol_id, SUM(edges.site_count)::bigint AS edge_count
                    FROM {schema}."edges" AS edges
                    JOIN current ON current.generation_id = edges.generation_id
                    WHERE edges.project_id = CAST($1 AS uuid)
                      AND edges.edge_kind <> 'contains'
                    GROUP BY edges.target_symbol_id
                ), test_pressure AS (
                    SELECT edges.target_symbol_id,
                           COUNT(DISTINCT files.file_id)::bigint AS test_files
                    FROM {schema}."edges" AS edges
                    JOIN current ON current.generation_id = edges.generation_id
                    JOIN {schema}."symbols" AS sources
                      ON sources.project_id = edges.project_id
                     AND sources.generation_id = edges.generation_id
                     AND sources.symbol_id = edges.source_symbol_id
                    JOIN {schema}."files" AS files
                     ON files.project_id = sources.project_id
                     AND files.generation_id = sources.generation_id
                     AND files.file_id = sources.file_id
                    WHERE edges.project_id = CAST($1 AS uuid)
                      AND (
                          files.normalized_path ~* '(^|/)(__tests__|tests?|specs?)(/|$)'
                          OR files.normalized_path ~* '(\.test\.|\.spec\.|_test\.|_spec\.)'
                          OR EXISTS (
                              SELECT 1
                              FROM {schema}."search_documents" AS documents
                              WHERE documents.project_id = files.project_id
                                AND documents.generation_id = files.generation_id
                                AND documents.file_id = files.file_id
                                AND documents.document_kind = 'test'
                          )
                      )
                    GROUP BY edges.target_symbol_id
                ), selected AS (
                    SELECT DISTINCT ON (coverage.symbol_id)
                           coverage.symbol_id, coverage.project_id, coverage.generation_id,
                           coverage.lines_found, coverage.lines_hit,
                           coverage.coverage_fraction, sources.label
                    FROM {schema}."symbol_coverage" AS coverage
                    JOIN current ON current.generation_id = coverage.generation_id
                    JOIN {schema}."coverage_sources" AS sources
                      ON sources.project_id = coverage.project_id
                     AND sources.source_id = coverage.source_id
                    WHERE coverage.project_id = CAST($1 AS uuid)
                      AND ($2::text IS NULL OR sources.label = $2)
                    ORDER BY coverage.symbol_id,
                             coverage.coverage_fraction DESC NULLS LAST,
                             sources.label
                ), scored AS (
                    SELECT selected.symbol_id, files.normalized_path, files.language,
                           symbols.symbol_kind, symbols.qualified_name, selected.label,
                           selected.lines_found, selected.lines_hit,
                           selected.coverage_fraction,
                           COALESCE(incoming.edge_count, 0)::bigint AS incoming_edges,
                           COALESCE(test_pressure.test_files, 0)::bigint AS direct_test_files,
                           LEAST(
                               1.0,
                               COALESCE(incoming.edge_count, 0)::double precision
                               / GREATEST(population.symbol_count - 1.0, 1.0)
                           ) AS degree_centrality
                    FROM selected
                    JOIN {schema}."symbols" AS symbols
                      ON symbols.project_id = selected.project_id
                     AND symbols.generation_id = selected.generation_id
                     AND symbols.symbol_id = selected.symbol_id
                    JOIN {schema}."files" AS files
                      ON files.project_id = symbols.project_id
                     AND files.generation_id = symbols.generation_id
                     AND files.file_id = symbols.file_id
                    CROSS JOIN population
                    LEFT JOIN incoming ON incoming.target_symbol_id = selected.symbol_id
                    LEFT JOIN test_pressure
                      ON test_pressure.target_symbol_id = selected.symbol_id
                )
                SELECT symbol_id::text, normalized_path, language, symbol_kind,
                       qualified_name, label, lines_found, lines_hit, coverage_fraction,
                       incoming_edges, direct_test_files, degree_centrality
                FROM scored
                WHERE ($3::text IS NULL OR symbol_id = CAST($3 AS uuid))
                  AND ($4::boolean OR NOT (
                      normalized_path ~* '(^|/)(__tests__|tests?|specs?)(/|$)'
                      OR normalized_path ~* '(\.test\.|\.spec\.|_test\.|_spec\.)'
                  ))
                  AND ($5::double precision IS NULL
                       OR COALESCE(coverage_fraction, 0.0) <= $5)
                  AND ($6::double precision IS NULL OR degree_centrality >= $6)
                  AND ($7::text[] IS NULL OR symbol_kind = ANY($7))
                  AND ($8::text IS NULL OR LEFT(normalized_path, LENGTH($8)) = $8)
                ORDER BY coverage_fraction ASC NULLS FIRST,
                         degree_centrality DESC, incoming_edges DESC,
                         normalized_path, qualified_name, symbol_id
                LIMIT $9
