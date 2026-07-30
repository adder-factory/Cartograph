INSERT INTO {schema}."coverage_sources" (
                    project_id, label, report_format, report_digest, report_metadata
                ) VALUES (CAST($1 AS uuid), $2, 'lcov', $3, CAST($4 AS jsonb))
                ON CONFLICT (project_id, label) DO UPDATE
                SET report_format = EXCLUDED.report_format,
                    report_digest = EXCLUDED.report_digest,
                    report_metadata = EXCLUDED.report_metadata,
                    loaded_at = clock_timestamp()
                RETURNING source_id::text
