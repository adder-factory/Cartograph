INSERT INTO {quoted_schema}."symbol_coverage" (
                project_id, generation_id, source_id, symbol_id,
                lines_found, lines_hit, functions_found, functions_hit, updated_at
            )
            SELECT previous_coverage.project_id, CAST($2 AS uuid),
                   previous_coverage.source_id, next_symbols.symbol_id,
                   previous_coverage.lines_found, previous_coverage.lines_hit,
                   previous_coverage.functions_found, previous_coverage.functions_hit,
                   clock_timestamp()
            FROM {quoted_schema}."projects" AS projects
            JOIN {quoted_schema}."symbol_coverage" AS previous_coverage
              ON previous_coverage.project_id = projects.project_id
             AND previous_coverage.generation_id = projects.current_generation_id
            JOIN {quoted_schema}."symbols" AS previous_symbols
              ON previous_symbols.project_id = previous_coverage.project_id
             AND previous_symbols.generation_id = previous_coverage.generation_id
             AND previous_symbols.symbol_id = previous_coverage.symbol_id
            JOIN {quoted_schema}."symbols" AS next_symbols
              ON next_symbols.project_id = previous_symbols.project_id
             AND next_symbols.generation_id = CAST($2 AS uuid)
             AND next_symbols.symbol_id = previous_symbols.symbol_id
             AND next_symbols.structural_digest = previous_symbols.structural_digest
            WHERE projects.project_id = CAST($1 AS uuid)
              AND projects.current_generation_id IS NOT NULL
            ON CONFLICT (project_id, generation_id, source_id, symbol_id) DO NOTHING
