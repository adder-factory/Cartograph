WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                ), selected AS (
                    SELECT files.normalized_path, files.language, files.byte_size,
                           COUNT(symbols.symbol_id) FILTER (
                               WHERE symbols.symbol_kind <> 'file'
                           )::bigint AS symbol_count
                    FROM {schema}."files" AS files
                    JOIN current ON current.generation_id = files.generation_id
                    LEFT JOIN {schema}."symbols" AS symbols
                      ON symbols.project_id = files.project_id
                     AND symbols.generation_id = files.generation_id
                     AND symbols.file_id = files.file_id
                    WHERE files.project_id = CAST($1 AS uuid)
                      AND ($2::text IS NULL
                           OR files.normalized_path = $2
                           OR LEFT(files.normalized_path, LENGTH($2) + 1) = $2 || '/')
                      AND ($3::text IS NULL OR files.language = $3)
                      AND ($4::text IS NULL OR files.normalized_path ~ $4)
                    GROUP BY files.file_id, files.normalized_path, files.language,
                             files.byte_size
                ), language_rollup AS (
                    SELECT language AS key, COUNT(*)::bigint AS files,
                           SUM(symbol_count)::bigint AS symbols,
                           SUM(byte_size)::bigint AS bytes
                    FROM selected
                    GROUP BY language
                ), path_parts AS (
                    SELECT selected.*,
                           regexp_split_to_array(selected.normalized_path, '/') AS parts
                    FROM selected
                ), directory_membership AS (
                    SELECT path_parts.normalized_path, path_parts.symbol_count,
                           path_parts.byte_size,
                           CASE
                             WHEN array_length(parts, 1) = 1 THEN '.'
                             ELSE array_to_string(parts[1:depth], '/')
                           END AS directory
                    FROM path_parts
                    CROSS JOIN LATERAL generate_series(
                        1,
                        GREATEST(array_length(parts, 1) - 1, 1)
                    ) AS levels(depth)
                ), directory_rollup AS (
                    SELECT directory AS key, COUNT(*)::bigint AS files,
                           SUM(symbol_count)::bigint AS symbols,
                           SUM(byte_size)::bigint AS bytes
                    FROM directory_membership
                    GROUP BY directory
                ), aggregates AS (
                    SELECT 'language'::text AS kind, key, files, symbols, bytes,
                           COUNT(*) OVER ()::bigint AS kind_total,
                           ROW_NUMBER() OVER (ORDER BY files DESC, key) AS kind_rank
                    FROM language_rollup
                    UNION ALL
                    SELECT 'directory'::text AS kind, key, files, symbols, bytes,
                           COUNT(*) OVER ()::bigint AS kind_total,
                           ROW_NUMBER() OVER (ORDER BY key) AS kind_rank
                    FROM directory_rollup
                )
                SELECT kind, key, files, symbols, bytes, kind_total
                FROM aggregates
                WHERE kind = 'language' OR kind_rank <= $5
                ORDER BY CASE kind WHEN 'language' THEN 0 ELSE 1 END,
                         CASE WHEN kind = 'language' THEN files END DESC,
                         key
