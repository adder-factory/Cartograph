INSERT INTO {quoted_schema}."symbol_similarity_builds" (
                project_id, generation_id, model_id, neighbors_per_symbol,
                minimum_score, source_symbols, edges_written, built_at
            )
            SELECT builds.project_id, CAST($2 AS uuid), builds.model_id,
                   builds.neighbors_per_symbol, builds.minimum_score,
                   builds.source_symbols, builds.edges_written, builds.built_at
            FROM {quoted_schema}."projects" AS projects
            JOIN {quoted_schema}."index_generations" AS previous
              ON previous.project_id = projects.project_id
             AND previous.generation_id = projects.current_generation_id
            JOIN {quoted_schema}."symbol_similarity_builds" AS builds
              ON builds.project_id = previous.project_id
             AND builds.generation_id = previous.generation_id
            WHERE projects.project_id = CAST($1 AS uuid)
              AND previous.content_digest = $3
              AND previous.content_digest_version = $4
            ON CONFLICT (project_id, generation_id, model_id) DO NOTHING
