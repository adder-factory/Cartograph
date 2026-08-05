SELECT generations.current_generation_id::text AS generation_id,
       encode(
           sha256(
               convert_to(
                   generations.current_generation_id::text
                   || '|'
                   || COALESCE(
                          (
                              SELECT previous.generation_id::text
                              FROM {schema}."index_generations" AS previous
                              WHERE previous.project_id = CAST($1 AS uuid)
                                AND previous.state = 'superseded'
                              ORDER BY previous.generation_sequence DESC
                              LIMIT 1
                          ),
                          ''
                      )
                   || '|'
                   || (
                          -- Per-symbol coverage fractions feed low_coverage and the
                          -- centrality percentile, and a re-import can redistribute
                          -- hit lines between symbols while leaving project-wide
                          -- totals identical. The report digest changes on every
                          -- import, so it is what actually fences this input; the
                          -- aggregate only adds cheap corroboration.
                          SELECT COALESCE(
                                     string_agg(
                                         sources.report_digest,
                                         ',' ORDER BY sources.source_id
                                     ),
                                     ''
                                 )
                          FROM {schema}."coverage_sources" AS sources
                          WHERE sources.project_id = CAST($1 AS uuid)
                      )
                   || '|'
                   || (
                          SELECT COUNT(*)::text
                                 || ':'
                                 || COALESCE(SUM(coverage.lines_found), 0)::text
                                 || ':'
                                 || COALESCE(SUM(coverage.lines_hit), 0)::text
                          FROM {schema}."symbol_coverage" AS coverage
                          WHERE coverage.project_id = CAST($1 AS uuid)
                            AND coverage.generation_id = generations.current_generation_id
                      )
                   || '|'
                   || (
                          -- Scores feed the semantic clone band directly, so a
                          -- rewritten score must move the fingerprint even when
                          -- the edge count is unchanged.
                          SELECT COUNT(*)::text
                                 || ':'
                                 || COALESCE(SUM(similarity.score)::text, '')
                                 || ':'
                                 || COALESCE(MIN(similarity.score)::text, '')
                                 || ':'
                                 || COALESCE(MAX(similarity.score)::text, '')
                          FROM {schema}."symbol_similarity_edges" AS similarity
                          WHERE similarity.project_id = CAST($1 AS uuid)
                            AND similarity.generation_id = generations.current_generation_id
                      )
                   || '|'
                   || (
                          SELECT COALESCE(
                                     string_agg(
                                         builds.model_id::text
                                         || ':'
                                         || builds.edges_written::text
                                         || ':'
                                         || builds.built_at::text,
                                         ',' ORDER BY builds.model_id
                                     ),
                                     ''
                                 )
                          FROM {schema}."symbol_similarity_builds" AS builds
                          WHERE builds.project_id = CAST($1 AS uuid)
                            AND builds.generation_id = generations.current_generation_id
                      )
                   || '|'
                   || to_char(date_trunc('day', clock_timestamp()), 'YYYY-MM-DD')
                   || '|'
                   || $2,
                   'UTF8'
               )
           ),
           'hex'
       ) AS inputs_digest
FROM {schema}."projects" AS generations
WHERE generations.project_id = CAST($1 AS uuid)
  AND generations.current_generation_id IS NOT NULL
