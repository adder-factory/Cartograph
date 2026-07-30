SELECT current_generation_id::text
                FROM {schema}."projects"
                WHERE project_id = CAST($1 AS uuid)
                FOR UPDATE
