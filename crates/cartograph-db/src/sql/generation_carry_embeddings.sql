INSERT INTO {quoted_schema}."document_embeddings" (
                project_id, generation_id, document_id, model_id,
                source_digest, embedding, created_at, updated_at
            )
            SELECT previous_embeddings.project_id, CAST($2 AS uuid),
                   next_documents.document_id, previous_embeddings.model_id,
                   previous_embeddings.source_digest, previous_embeddings.embedding,
                   previous_embeddings.created_at, clock_timestamp()
            FROM {quoted_schema}."projects" AS projects
            JOIN {quoted_schema}."document_embeddings" AS previous_embeddings
              ON previous_embeddings.project_id = projects.project_id
             AND previous_embeddings.generation_id = projects.current_generation_id
            JOIN {quoted_schema}."search_documents" AS previous_documents
              ON previous_documents.project_id = previous_embeddings.project_id
             AND previous_documents.generation_id = previous_embeddings.generation_id
             AND previous_documents.document_id = previous_embeddings.document_id
            JOIN {quoted_schema}."search_documents" AS next_documents
              ON next_documents.project_id = previous_documents.project_id
             AND next_documents.generation_id = CAST($2 AS uuid)
             AND next_documents.document_id = previous_documents.document_id
             AND next_documents.path = previous_documents.path
             AND next_documents.language = previous_documents.language
             AND next_documents.document_kind = previous_documents.document_kind
             AND next_documents.qualified_name = previous_documents.qualified_name
             AND next_documents.code = previous_documents.code
             AND next_documents.natural_text = previous_documents.natural_text
            JOIN {quoted_schema}."embedding_models" AS models
              ON models.model_id = previous_embeddings.model_id
             AND models.state = 'active'
            WHERE projects.project_id = CAST($1 AS uuid)
              AND projects.current_generation_id IS NOT NULL
            ON CONFLICT (project_id, generation_id, document_id, model_id) DO NOTHING
