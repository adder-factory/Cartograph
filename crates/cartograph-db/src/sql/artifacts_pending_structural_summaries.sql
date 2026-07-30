WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                ), candidates AS MATERIALIZED (
                    SELECT symbols.generation_id, symbols.symbol_id,
                           files.normalized_path, symbols.symbol_kind,
                           COALESCE(NULLIF(documents.metadata ->> 'name', ''),
                                    symbols.qualified_name) AS name,
                           symbols.qualified_name, symbols.signature, documents.code,
                           symbols.start_line, symbols.end_line,
                           symbols.structural_digest, symbols.declaration_only
                    FROM {schema}."symbols" AS symbols
                    JOIN current ON current.generation_id = symbols.generation_id
                    JOIN {schema}."files" AS files
                      ON files.project_id = symbols.project_id
                     AND files.generation_id = symbols.generation_id
                     AND files.file_id = symbols.file_id
                    LEFT JOIN {schema}."search_documents" AS documents
                      ON documents.project_id = symbols.project_id
                     AND documents.generation_id = symbols.generation_id
                     AND documents.symbol_id = symbols.symbol_id
                     AND documents.document_kind = 'symbol'
                    LEFT JOIN {schema}."agent_artifacts" AS cached
                      ON cached.project_id = symbols.project_id
                     AND cached.artifact_kind = 'summary'
                     AND cached.scope_kind = 'symbol'
                     AND cached.scope_key = symbols.symbol_id::text
                     AND cached.state = 'complete'
                     AND cached.source_digest = symbols.structural_digest
                    WHERE symbols.project_id = CAST($1 AS uuid)
                      AND symbols.symbol_kind IN (
                          'class', 'function', 'method', 'interface', 'struct',
                          'trait', 'protocol', 'enum', 'type_alias', 'component', 'route'
                      )
                      AND length(COALESCE(documents.natural_text, '')) < $7
                      AND cached.id IS NULL
                      AND ($2::uuid IS NULL OR symbols.symbol_id > $2::uuid)
                    ORDER BY symbols.symbol_id
                    LIMIT $3
                )
                SELECT candidates.generation_id::text AS generation_id,
                       candidates.symbol_id::text AS symbol_id,
                       candidates.normalized_path AS path,
                       candidates.symbol_kind AS symbol_kind,
                       candidates.name AS name,
                       candidates.qualified_name AS qualified_name,
                       left(candidates.signature, $4) AS signature,
                       left(candidates.code, $6) AS code,
                       candidates.start_line AS start_line,
                       candidates.end_line AS end_line,
                       candidates.structural_digest AS content_hash,
                       candidates.declaration_only AS declaration_only,
                       COALESCE((
                           SELECT jsonb_agg(
                               jsonb_build_object(
                                   'edgeKind', edges.edge_kind,
                                   'targetSymbolId', targets.symbol_id::text,
                                   'targetKind', targets.symbol_kind,
                                   'targetName', COALESCE(
                                       NULLIF(target_docs.metadata ->> 'name', ''),
                                       targets.qualified_name
                                   ),
                                   'targetQualifiedName', targets.qualified_name,
                                   'targetPath', target_files.normalized_path,
                                   'targetSummary', COALESCE(
                                       left(target_summaries.body, $5),
                                       NULLIF(left(target_docs.natural_text, $5), '')
                                   )
                               ) ORDER BY edges.edge_kind, targets.qualified_name,
                                          targets.symbol_id
                           )
                           FROM {schema}."edges" AS edges
                           JOIN {schema}."symbols" AS targets
                             ON targets.project_id = edges.project_id
                            AND targets.generation_id = edges.generation_id
                            AND targets.symbol_id = edges.target_symbol_id
                           JOIN {schema}."files" AS target_files
                             ON target_files.project_id = targets.project_id
                            AND target_files.generation_id = targets.generation_id
                            AND target_files.file_id = targets.file_id
                           LEFT JOIN {schema}."agent_artifacts" AS target_summaries
                             ON target_summaries.project_id = targets.project_id
                            AND target_summaries.artifact_kind = 'summary'
                            AND target_summaries.scope_kind = 'symbol'
                            AND target_summaries.scope_key = targets.symbol_id::text
                            AND target_summaries.state = 'complete'
                            AND target_summaries.source_digest = targets.structural_digest
                           LEFT JOIN LATERAL (
                               SELECT documents.natural_text, documents.metadata
                               FROM {schema}."search_documents" AS documents
                               WHERE documents.project_id = targets.project_id
                                 AND documents.generation_id = targets.generation_id
                                 AND documents.symbol_id = targets.symbol_id
                                 AND documents.document_kind = 'symbol'
                               ORDER BY documents.id
                               LIMIT 1
                           ) AS target_docs ON true
                           WHERE edges.project_id = CAST($1 AS uuid)
                             AND edges.generation_id = candidates.generation_id
                             AND edges.source_symbol_id = candidates.symbol_id
                       ), '[]'::jsonb)::text AS edges
                FROM candidates
                ORDER BY candidates.symbol_id
