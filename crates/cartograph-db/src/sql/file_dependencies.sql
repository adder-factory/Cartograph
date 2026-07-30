WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                ), anchor AS (
                    SELECT files.file_id
                    FROM {schema}."files" AS files
                    JOIN current ON current.generation_id = files.generation_id
                    WHERE files.project_id = CAST($1 AS uuid)
                      AND files.normalized_path = $2
                ), links AS (
                    SELECT 'dependencies'::text AS direction,
                           target_files.normalized_path AS path,
                           target_files.language,
                           COUNT(*)::bigint AS edge_count,
                           SUM(edges.site_count)::bigint AS site_count,
                           array_agg(DISTINCT edges.edge_kind ORDER BY edges.edge_kind) AS edge_kinds
                    FROM {schema}."edges" AS edges
                    JOIN current ON current.generation_id = edges.generation_id
                    JOIN {schema}."symbols" AS source
                      ON source.project_id = edges.project_id
                     AND source.generation_id = edges.generation_id
                     AND source.symbol_id = edges.source_symbol_id
                    JOIN anchor ON anchor.file_id = source.file_id
                    JOIN {schema}."symbols" AS target
                      ON target.project_id = edges.project_id
                     AND target.generation_id = edges.generation_id
                     AND target.symbol_id = edges.target_symbol_id
                    JOIN {schema}."files" AS target_files
                      ON target_files.project_id = target.project_id
                     AND target_files.generation_id = target.generation_id
                     AND target_files.file_id = target.file_id
                    WHERE edges.project_id = CAST($1 AS uuid)
                      AND source.file_id <> target.file_id
                      AND edges.edge_kind <> 'contains'
                    GROUP BY target_files.normalized_path, target_files.language
                    UNION ALL
                    SELECT 'dependents'::text AS direction,
                           source_files.normalized_path AS path,
                           source_files.language,
                           COUNT(*)::bigint AS edge_count,
                           SUM(edges.site_count)::bigint AS site_count,
                           array_agg(DISTINCT edges.edge_kind ORDER BY edges.edge_kind) AS edge_kinds
                    FROM {schema}."edges" AS edges
                    JOIN current ON current.generation_id = edges.generation_id
                    JOIN {schema}."symbols" AS target
                      ON target.project_id = edges.project_id
                     AND target.generation_id = edges.generation_id
                     AND target.symbol_id = edges.target_symbol_id
                    JOIN anchor ON anchor.file_id = target.file_id
                    JOIN {schema}."symbols" AS source
                      ON source.project_id = edges.project_id
                     AND source.generation_id = edges.generation_id
                     AND source.symbol_id = edges.source_symbol_id
                    JOIN {schema}."files" AS source_files
                      ON source_files.project_id = source.project_id
                     AND source_files.generation_id = source.generation_id
                     AND source_files.file_id = source.file_id
                    WHERE edges.project_id = CAST($1 AS uuid)
                      AND source.file_id <> target.file_id
                      AND edges.edge_kind <> 'contains'
                    GROUP BY source_files.normalized_path, source_files.language
                ), ranked AS (
                    SELECT links.*,
                           COUNT(*) OVER (PARTITION BY direction)::bigint AS direction_total,
                           ROW_NUMBER() OVER (
                               PARTITION BY direction
                               ORDER BY site_count DESC, edge_count DESC, path
                           ) AS direction_rank
                    FROM links
                    WHERE $3::text = 'both' OR direction = $3
                )
                SELECT direction, path, language, edge_count, site_count,
                       edge_kinds, direction_total
                FROM ranked
                WHERE direction_rank <= $4
                ORDER BY CASE direction WHEN 'dependencies' THEN 0 ELSE 1 END,
                         direction_rank, path
