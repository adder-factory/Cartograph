WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                ), ranked AS (
                    SELECT files.generation_id,
                           files.normalized_path,
                           files.content_hash,
                           symbols.symbol_id,
                           symbols.qualified_name,
                           symbols.symbol_kind,
                           left(summaries.body, $6) AS summary,
                           summaries.updated_at,
                           COUNT(*) OVER (PARTITION BY files.file_id) AS summarized_symbols,
                           ROW_NUMBER() OVER (
                               PARTITION BY files.file_id
                               ORDER BY symbols.exported DESC,
                                        (symbols.visibility = 'public') DESC,
                                        symbols.pagerank DESC NULLS LAST,
                                        symbols.start_line,
                                        symbols.symbol_id
                           ) AS evidence_rank
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
                      AND ($3::text IS NULL OR files.normalized_path > $3)
                ), rollups AS (
                    SELECT generation_id,
                           normalized_path,
                           content_hash,
                           MAX(summarized_symbols)::bigint AS summarized_symbols,
                           MAX(updated_at) AS latest_symbol_summary_at,
                           jsonb_agg(
                               jsonb_build_object(
                                   'symbolId', symbol_id::text,
                                   'qualifiedName', qualified_name,
                                   'symbolKind', symbol_kind,
                                   'summary', summary
                               ) ORDER BY evidence_rank
                           ) FILTER (WHERE evidence_rank <= $5) AS items
                    FROM ranked
                    GROUP BY generation_id, normalized_path, content_hash
                )
                SELECT rollups.generation_id::text,
                       rollups.normalized_path,
                       rollups.content_hash,
                       rollups.summarized_symbols,
                       rollups.items::text,
                       rollups.summarized_symbols > $5
                FROM rollups
                LEFT JOIN {schema}."agent_artifacts" AS cached
                  ON cached.project_id = CAST($1 AS uuid)
                 AND cached.artifact_kind = 'summary'
                 AND cached.scope_kind = 'file'
                 AND cached.scope_key = rollups.normalized_path
                 AND cached.state = 'complete'
                WHERE cached.id IS NULL
                   OR cached.generation_id IS DISTINCT FROM rollups.generation_id
                   OR (
                        $2 <> 'structural:v2'
                        AND cached.metadata ->> 'model' IS DISTINCT FROM $2
                   )
                   OR cached.metadata ->> 'anchorDigest' IS DISTINCT FROM $7
                   OR cached.metadata ->> 'fileContentHash' IS DISTINCT FROM rollups.content_hash
                   OR cached.metadata ->> 'summarizedSymbols'
                        IS DISTINCT FROM rollups.summarized_symbols::text
                   OR cached.metadata ->> 'rollupDigest' IS DISTINCT FROM cached.source_digest
                   OR cached.updated_at < rollups.latest_symbol_summary_at
                ORDER BY rollups.normalized_path
                LIMIT $4
