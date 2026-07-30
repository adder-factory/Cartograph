WITH RECURSIVE current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                      AND current_generation_id IS NOT NULL
                ), seed_files AS MATERIALIZED (
                    SELECT files.file_id, files.normalized_path
                    FROM {schema}."files" AS files
                    JOIN current ON current.generation_id = files.generation_id
                    WHERE files.project_id = CAST($1 AS uuid)
                      AND files.normalized_path = ANY(CAST($2 AS text[]))
                ), seed_symbols AS MATERIALIZED (
                    SELECT symbols.symbol_id
                    FROM {schema}."symbols" AS symbols
                    JOIN current ON current.generation_id = symbols.generation_id
                    JOIN seed_files ON seed_files.file_id = symbols.file_id
                    WHERE symbols.project_id = CAST($1 AS uuid)
                ), walk(symbol_id, depth) AS (
                    SELECT seed_symbols.symbol_id, 0::integer
                    FROM seed_symbols
                    UNION
                    SELECT edges.source_symbol_id, walk.depth + 1
                    FROM walk
                    JOIN current ON true
                    JOIN {schema}."edges" AS edges
                      ON edges.project_id = CAST($1 AS uuid)
                     AND edges.generation_id = current.generation_id
                     AND edges.target_symbol_id = walk.symbol_id
                    WHERE walk.depth < $3
                      AND edges.edge_kind IN (
                          'calls', 'imports', 'references', 'implements', 'extends',
                          'tests', 'type_of', 'returns', 'instantiates', 'overrides',
                          'decorates', 'field_access', 'def_use', 'exports'
                      )
                ), reached_symbols AS MATERIALIZED (
                    SELECT walk.symbol_id, MIN(walk.depth)::integer AS distance
                    FROM walk
                    GROUP BY walk.symbol_id
                ), reached_files AS MATERIALIZED (
                    SELECT files.file_id,
                           files.normalized_path,
                           MIN(reached_symbols.distance)::integer AS distance,
                           CASE WHEN CAST($5 AS text) IS NULL THEN
                               EXISTS (
                                   SELECT 1
                                   FROM {schema}."search_documents" AS documents
                                   WHERE documents.project_id = files.project_id
                                     AND documents.generation_id = files.generation_id
                                     AND documents.file_id = files.file_id
                                     AND documents.document_kind = 'test'
                               )
                           ELSE files.normalized_path ~ CAST($5 AS text)
                           END AS is_test
                    FROM reached_symbols
                    JOIN current ON true
                    JOIN {schema}."symbols" AS symbols
                      ON symbols.project_id = CAST($1 AS uuid)
                     AND symbols.generation_id = current.generation_id
                     AND symbols.symbol_id = reached_symbols.symbol_id
                    JOIN {schema}."files" AS files
                      ON files.project_id = symbols.project_id
                     AND files.generation_id = symbols.generation_id
                     AND files.file_id = symbols.file_id
                    GROUP BY files.project_id, files.generation_id,
                             files.file_id, files.normalized_path
                ), summary AS (
                    SELECT current.generation_id::text,
                           COALESCE((
                               SELECT array_agg(seed_files.normalized_path ORDER BY seed_files.normalized_path)
                               FROM seed_files
                           ), ARRAY[]::text[]) AS matched_inputs,
                           (SELECT COUNT(*)::bigint FROM reached_files WHERE distance > 0)
                               AS dependent_file_count,
                           (SELECT COUNT(*)::bigint FROM reached_files WHERE is_test)
                               AS affected_test_file_count,
                           (SELECT COUNT(*)::bigint
                              FROM reached_files
                             WHERE distance > 0
                               AND normalized_path ~ '(^|/)index\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$')
                               AS reached_barrel_count,
                           ARRAY(
                               SELECT normalized_path
                               FROM reached_files
                               WHERE distance > 0
                                 AND normalized_path ~ '(^|/)index\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$'
                               ORDER BY normalized_path
                               LIMIT {MAX_REPORTED_BARRELS}
                           ) AS reached_barrels
                    FROM current
                ), selected_tests AS (
                    SELECT normalized_path, distance
                    FROM reached_files
                    WHERE is_test
                    ORDER BY distance, normalized_path
                    LIMIT $4
                )
                SELECT summary.generation_id,
                       summary.matched_inputs,
                       summary.dependent_file_count,
                       summary.affected_test_file_count,
                       summary.reached_barrel_count,
                       summary.reached_barrels,
                       selected_tests.normalized_path,
                       selected_tests.distance
                FROM summary
                LEFT JOIN selected_tests ON true
                ORDER BY selected_tests.distance NULLS LAST,
                         selected_tests.normalized_path NULLS LAST
