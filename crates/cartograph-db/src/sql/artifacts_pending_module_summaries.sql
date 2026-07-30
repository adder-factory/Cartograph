WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                ), summarized AS (
                    SELECT files.generation_id,
                           regexp_replace(files.normalized_path, '/[^/]+$', '') AS directory,
                           files.normalized_path,
                           symbols.symbol_id,
                           symbols.qualified_name,
                           symbols.symbol_kind,
                           symbols.exported,
                           symbols.visibility,
                           symbols.pagerank,
                           symbols.start_line,
                           left(summaries.body, $6) AS summary,
                           summaries.updated_at
                    FROM {schema}."files" AS files
                    JOIN current ON current.generation_id = files.generation_id
                    JOIN {schema}."symbols" AS symbols
                      ON symbols.project_id = files.project_id
                     AND symbols.generation_id = files.generation_id
                     AND symbols.file_id = files.file_id
                    JOIN {schema}."agent_artifacts" AS summaries
                      ON summaries.project_id = symbols.project_id
                     AND summaries.artifact_kind = 'summary'
                     AND summaries.scope_kind = 'symbol'
                     AND summaries.scope_key = symbols.symbol_id::text
                     AND summaries.source_digest = symbols.structural_digest
                     AND summaries.state = 'complete'
                    WHERE files.project_id = CAST($1 AS uuid)
                      AND POSITION('/' IN files.normalized_path) > 0
                ), tool_counts AS (
                    SELECT files.generation_id,
                           regexp_replace(files.normalized_path, '/[^/]+$', '') AS directory,
                           COUNT(*)::bigint AS tool_export_constants
                    FROM {schema}."files" AS files
                    JOIN current ON current.generation_id = files.generation_id
                    JOIN {schema}."symbols" AS symbols
                      ON symbols.project_id = files.project_id
                     AND symbols.generation_id = files.generation_id
                     AND symbols.file_id = files.file_id
                    WHERE files.project_id = CAST($1 AS uuid)
                      AND POSITION('/' IN files.normalized_path) > 0
                      AND symbols.symbol_kind = 'constant'
                      AND symbols.qualified_name ~ '_TOOL$'
                    GROUP BY files.generation_id, directory
                ), ranked AS (
                    SELECT summarized.*,
                           COUNT(*) OVER (PARTITION BY directory) AS summarized_symbols,
                           ROW_NUMBER() OVER (
                               PARTITION BY directory
                               ORDER BY exported DESC,
                                        (visibility = 'public') DESC,
                                        pagerank DESC NULLS LAST,
                                        normalized_path,
                                        start_line,
                                        symbol_id
                           ) AS evidence_rank
                    FROM summarized
                    WHERE ($3::text IS NULL OR directory > $3)
                ), rollups AS (
                    SELECT generation_id,
                           directory,
                           MAX(summarized_symbols)::bigint AS summarized_symbols,
                           MAX(updated_at) AS latest_symbol_summary_at,
                           jsonb_agg(
                               jsonb_build_object(
                                   'symbolId', symbol_id::text,
                                   'path', normalized_path,
                                   'qualifiedName', qualified_name,
                                   'symbolKind', symbol_kind,
                                   'summary', summary
                               ) ORDER BY evidence_rank
                           ) FILTER (WHERE evidence_rank <= $5) AS items
                    FROM ranked
                    GROUP BY generation_id, directory
                    HAVING MAX(summarized_symbols) >= $8
                )
                SELECT rollups.generation_id::text AS generation_id,
                       rollups.directory AS directory,
                       rollups.summarized_symbols AS summarized_symbols,
                       COALESCE(tool_counts.tool_export_constants, 0)
                           AS tool_export_constants,
                       rollups.items::text AS items,
                       rollups.summarized_symbols > $5 AS items_truncated
                FROM rollups
                LEFT JOIN tool_counts
                  ON tool_counts.generation_id = rollups.generation_id
                 AND tool_counts.directory = rollups.directory
                LEFT JOIN {schema}."agent_artifacts" AS cached
                  ON cached.project_id = CAST($1 AS uuid)
                 AND cached.artifact_kind = 'summary'
                 AND cached.scope_kind = 'module'
                 AND cached.scope_key = rollups.directory
                 AND cached.state = 'complete'
                WHERE cached.id IS NULL
                   OR cached.generation_id IS DISTINCT FROM rollups.generation_id
                   OR (
                        $2 <> 'structural:v2'
                        AND cached.metadata ->> 'model' IS DISTINCT FROM $2
                   )
                   OR cached.metadata ->> 'anchorDigest' IS DISTINCT FROM $7
                   OR cached.metadata ->> 'summarizedSymbols'
                        IS DISTINCT FROM rollups.summarized_symbols::text
                   OR cached.metadata ->> 'toolExportConstants'
                        IS DISTINCT FROM COALESCE(tool_counts.tool_export_constants, 0)::text
                   OR cached.metadata ->> 'rollupDigest' IS DISTINCT FROM cached.source_digest
                   OR cached.updated_at < rollups.latest_symbol_summary_at
                ORDER BY rollups.directory
                LIMIT $4
