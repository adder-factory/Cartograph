WITH current AS (
                    SELECT current_generation_id AS generation_id
                    FROM {schema}."projects"
                    WHERE project_id = CAST($1 AS uuid)
                ), symbol_counts AS (
                    SELECT symbols.file_id,
                           COUNT(*) FILTER (WHERE symbols.symbol_kind <> 'file') AS symbols,
                           COUNT(*) FILTER (WHERE symbols.symbol_kind = 'route') AS routes,
                           COALESCE(MAX(symbols.pagerank), 0.0) AS centrality
                    FROM {schema}."symbols" AS symbols
                    JOIN current ON current.generation_id = symbols.generation_id
                    WHERE symbols.project_id = CAST($1 AS uuid)
                    GROUP BY symbols.file_id
                ), outgoing AS (
                    SELECT source.file_id, SUM(edges.site_count) AS edges
                    FROM {schema}."edges" AS edges
                    JOIN current ON current.generation_id = edges.generation_id
                    JOIN {schema}."symbols" AS source
                      ON source.project_id = edges.project_id
                     AND source.generation_id = edges.generation_id
                     AND source.symbol_id = edges.source_symbol_id
                    WHERE edges.project_id = CAST($1 AS uuid)
                      AND edges.edge_kind <> 'contains'
                    GROUP BY source.file_id
                ), incoming AS (
                    SELECT target.file_id, SUM(edges.site_count) AS edges,
                           COUNT(DISTINCT source.file_id) FILTER (
                               WHERE source.file_id <> target.file_id
                           ) AS external_dependents
                    FROM {schema}."edges" AS edges
                    JOIN current ON current.generation_id = edges.generation_id
                    JOIN {schema}."symbols" AS target
                      ON target.project_id = edges.project_id
                     AND target.generation_id = edges.generation_id
                     AND target.symbol_id = edges.target_symbol_id
                    JOIN {schema}."symbols" AS source
                      ON source.project_id = edges.project_id
                     AND source.generation_id = edges.generation_id
                     AND source.symbol_id = edges.source_symbol_id
                    WHERE edges.project_id = CAST($1 AS uuid)
                      AND edges.edge_kind <> 'contains'
                    GROUP BY target.file_id
                ), unresolved AS (
                    SELECT refs.file_id, SUM(refs.site_count) AS refs
                    FROM {schema}."references" AS refs
                    JOIN current ON current.generation_id = refs.generation_id
                    WHERE refs.project_id = CAST($1 AS uuid)
                      AND refs.target_symbol_id IS NULL
                    GROUP BY refs.file_id
                ), base AS (
                SELECT files.normalized_path,
                       files.language,
                       COALESCE(symbol_counts.symbols, 0)::bigint AS symbols,
                       COALESCE(incoming.edges, 0)::bigint AS incoming_edges,
                       COALESCE(outgoing.edges, 0)::bigint AS outgoing_edges,
                       COALESCE(unresolved.refs, 0)::bigint AS unresolved_references,
                       COALESCE(symbol_counts.routes, 0)::bigint AS routes,
                       (COALESCE(incoming.edges, 0) * 3
                       + COALESCE(outgoing.edges, 0) * 2
                       + COALESCE(unresolved.refs, 0)
                        + COALESCE(symbol_counts.routes, 0) * 4)::bigint AS structural_risk,
                       COALESCE(history.commit_count, 0)::bigint AS commit_count,
                       COALESCE(history.author_count, 0)::bigint AS author_count,
                       COALESCE(history.insertions, 0)::bigint AS insertions,
                       COALESCE(history.deletions, 0)::bigint AS deletions,
                       history.last_touched_at::text AS last_touched_at,
                       EXTRACT(EPOCH FROM history.last_touched_at)::bigint
                           AS last_touched_unix_seconds,
                       (history.normalized_path IS NOT NULL) AS history_available,
                       (
                           (COALESCE(incoming.edges, 0) * 3
                            + COALESCE(outgoing.edges, 0) * 2
                            + COALESCE(unresolved.refs, 0)
                            + COALESCE(symbol_counts.routes, 0) * 4) * 100
                           + LEAST(COALESCE(history.commit_count, 0), 1000) * 10
                           + LEAST(
                               (COALESCE(history.insertions, 0)
                                + COALESCE(history.deletions, 0)) / 10,
                               1000
                             )
                       )::bigint AS composite_risk,
                       COALESCE(symbol_counts.centrality, 0.0)::double precision AS centrality,
                       COALESCE(incoming.external_dependents, 0)::bigint AS external_dependents
                FROM {schema}."files" AS files
                JOIN current ON current.generation_id = files.generation_id
                LEFT JOIN symbol_counts ON symbol_counts.file_id = files.file_id
                LEFT JOIN incoming ON incoming.file_id = files.file_id
                LEFT JOIN outgoing ON outgoing.file_id = files.file_id
                LEFT JOIN unresolved ON unresolved.file_id = files.file_id
                LEFT JOIN {schema}."file_history" AS history
                  ON history.project_id = files.project_id
                 AND history.normalized_path = files.normalized_path
                WHERE files.project_id = CAST($1 AS uuid)
                  AND COALESCE(history.commit_count, 0) >= $2
                  AND COALESCE(symbol_counts.centrality, 0.0) >= $3
                  AND ($4::bigint IS NULL OR history.last_touched_at >=
                       clock_timestamp() - ($4::bigint * interval '1 day'))
                ), normalized AS (
                    SELECT base.*,
                           CASE WHEN MAX(structural_risk) OVER () = 0 THEN 0.0
                                ELSE structural_risk::double precision
                                     / MAX(structural_risk) OVER ()::double precision
                           END AS structural_pressure,
                           CASE WHEN MAX(commit_count * 10 + insertions + deletions) OVER () = 0
                                THEN 0.0
                                ELSE (commit_count * 10 + insertions + deletions)::double precision
                                     / MAX(commit_count * 10 + insertions + deletions) OVER ()::double precision
                           END AS churn_score
                    FROM base
                ), scored AS (
                    SELECT normalized.*,
                           ((centrality * 0.7 + structural_pressure * 0.3) * churn_score)
                               AS risk_score,
                           (churn_score * (1.0 - centrality)) AS maintenance_score,
                           ((centrality * 0.7 + structural_pressure * 0.3)
                               / (1.0 + churn_score)) AS brittle_score
                    FROM normalized
                )
                SELECT normalized_path, language, symbols, incoming_edges,
                       outgoing_edges, unresolved_references, routes, structural_risk,
                       commit_count, author_count, insertions, deletions,
                       last_touched_at, last_touched_unix_seconds, history_available,
                       composite_risk, centrality, structural_pressure, churn_score,
                       risk_score, maintenance_score, brittle_score, external_dependents
                FROM scored
                WHERE {category_filter}
                ORDER BY {ordering}, normalized_path
                LIMIT $5
