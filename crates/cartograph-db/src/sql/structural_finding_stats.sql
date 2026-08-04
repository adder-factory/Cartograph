WITH run AS (
    SELECT runs.generation_id, runs.analyzed_symbols
    FROM {schema}."structural_finding_runs" AS runs
    JOIN {schema}."projects" AS projects
      ON projects.project_id = runs.project_id
     AND projects.current_generation_id = runs.generation_id
    WHERE runs.project_id = CAST($1 AS uuid)
), totals AS (
    SELECT COUNT(stored.*)::bigint AS total,
           COUNT(stored.*) FILTER (WHERE stored.severity = 'info')::bigint AS info,
           COUNT(stored.*) FILTER (WHERE stored.severity = 'warning')::bigint AS warning,
           COUNT(stored.*) FILTER (WHERE stored.severity = 'error')::bigint AS error,
           COUNT(stored.*) FILTER (WHERE stored.finding = 'large_method')::bigint AS very_long,
           COUNT(stored.*) FILTER (WHERE stored.finding = 'high_fan_out')::bigint AS fan_out,
           COUNT(stored.*) FILTER (
               WHERE stored.finding = 'unresolved_reference_pressure'
           )::bigint AS unresolved_pressure
    FROM run
    LEFT JOIN {schema}."structural_findings" AS stored
      ON stored.project_id = CAST($1 AS uuid)
     AND stored.generation_id = run.generation_id
), by_kind AS (
    SELECT stored.finding, COUNT(*)::bigint AS count
    FROM run
    JOIN {schema}."structural_findings" AS stored
      ON stored.project_id = CAST($1 AS uuid)
     AND stored.generation_id = run.generation_id
    GROUP BY stored.finding
)
SELECT run.analyzed_symbols AS analyzed_symbols,
       totals.total AS total_findings,
       totals.info AS info_findings,
       totals.warning AS warning_findings,
       totals.error AS error_findings,
       totals.very_long AS very_long_symbols,
       totals.fan_out AS high_fan_out_symbols,
       totals.unresolved_pressure AS unresolved_reference_pressure,
       GREATEST(
           0.0,
           100.0 - (
               totals.error * 4.0 + totals.warning * 2.0 + totals.info
           ) * 100.0 / GREATEST(run.analyzed_symbols, 1)
       )::real AS code_health_score,
       COALESCE((
           SELECT jsonb_object_agg(finding, count ORDER BY finding)::text
           FROM by_kind
       ), '{}') AS by_finding
FROM run
CROSS JOIN totals
