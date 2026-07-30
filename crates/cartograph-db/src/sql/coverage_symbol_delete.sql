DELETE FROM {schema}."symbol_coverage"
                WHERE project_id = CAST($1 AS uuid)
                  AND generation_id = CAST($2 AS uuid)
                  AND source_id = CAST($3 AS uuid)
