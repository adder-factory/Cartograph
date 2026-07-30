WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                ), requested(group_key, normalized_path) AS (
                    SELECT * FROM unnest($2::text[], $3::text[])
                ), ranked AS (
                    SELECT requested.group_key,
                           COUNT(*) OVER (
                               PARTITION BY requested.group_key
                           )::bigint AS total,
                           ROW_NUMBER() OVER (
                               PARTITION BY requested.group_key
                               ORDER BY files.normalized_path,
                                        symbols.start_line,
                                        symbols.symbol_id
                           ) AS group_rank,
                           symbols.symbol_id::text,
                           files.normalized_path,
                           files.language,
                           symbols.symbol_kind,
                           symbols.qualified_name,
                           symbols.start_line,
                           symbols.end_line
                    FROM requested
                    JOIN current ON true
                    JOIN {schema}."files" AS files
                      ON files.project_id = CAST($1 AS uuid)
                     AND files.generation_id = current.generation_id
                     AND files.normalized_path = requested.normalized_path
                    JOIN {schema}."symbols" AS symbols
                      ON symbols.project_id = files.project_id
                     AND symbols.generation_id = files.generation_id
                     AND symbols.file_id = files.file_id
                    WHERE symbols.symbol_kind NOT IN ('file', 'import', 'parameter')
                      AND ($4::text IS NULL OR symbols.symbol_id <> CAST($4 AS uuid))
                )
                SELECT group_key, total, symbol_id, normalized_path, language,
                       symbol_kind, qualified_name, start_line, end_line
                FROM ranked
                WHERE group_rank <= $5
                ORDER BY group_key, group_rank
