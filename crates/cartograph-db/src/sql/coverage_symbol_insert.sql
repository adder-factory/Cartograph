INSERT INTO {schema}."symbol_coverage" (
                    project_id, generation_id, source_id, symbol_id,
                    lines_found, lines_hit, functions_found, functions_hit
                )
                SELECT CAST($1 AS uuid), CAST($2 AS uuid), CAST($3 AS uuid),
                       CAST(rows.symbol_id AS uuid), rows.lines_found, rows.lines_hit,
                       rows.functions_found, rows.functions_hit
                FROM UNNEST(
                    $4::text[], $5::bigint[], $6::bigint[], $7::bigint[], $8::bigint[]
                ) AS rows(
                    symbol_id, lines_found, lines_hit, functions_found, functions_hit
                )
