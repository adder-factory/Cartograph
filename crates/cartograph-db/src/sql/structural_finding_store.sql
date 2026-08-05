, stored AS (
                INSERT INTO {schema}."structural_findings" (
                    project_id, generation_id, symbol_id, finding, path, qualified_name,
                    severity, start_line, end_line, metric_name, metric,
                    degree_centrality, outgoing_edges, unresolved_references, detail
                )
                SELECT CAST($1 AS uuid), CAST($2 AS uuid), findings.symbol_id, findings.finding,
                       findings.path, findings.qualified_name, findings.severity,
                       findings.start_line, findings.end_line, findings.metric_name,
                       findings.metric, findings.degree_centrality, findings.outgoing,
                       findings.unresolved, findings.detail
                FROM findings
                RETURNING 1
            )
            UPDATE {schema}."structural_finding_runs" AS runs
               SET analyzed_symbols = (SELECT COUNT(*) FROM base),
                   computed_at = clock_timestamp()
             WHERE runs.project_id = CAST($1 AS uuid)
               AND runs.generation_id = CAST($2 AS uuid)
