INSERT INTO {quoted_schema}."symbol_similarity_edges" (
                project_id, generation_id, model_id, source_symbol_id,
                target_symbol_id, score, neighbor_rank, built_at
            )
            SELECT edges.project_id, CAST($2 AS uuid), edges.model_id,
                   edges.source_symbol_id, edges.target_symbol_id,
                   edges.score, edges.neighbor_rank, edges.built_at
            FROM {quoted_schema}."projects" AS projects
            JOIN {quoted_schema}."index_generations" AS previous
              ON previous.project_id = projects.project_id
             AND previous.generation_id = projects.current_generation_id
            JOIN {quoted_schema}."symbol_similarity_edges" AS edges
              ON edges.project_id = previous.project_id
             AND edges.generation_id = previous.generation_id
            WHERE projects.project_id = CAST($1 AS uuid)
              AND previous.content_digest = $3
              AND previous.content_digest_version = $4
            ON CONFLICT (
                project_id, generation_id, model_id, source_symbol_id, target_symbol_id
            ) DO NOTHING
