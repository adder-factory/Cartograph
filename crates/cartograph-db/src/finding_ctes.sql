WITH current AS (
                SELECT current_generation_id AS generation_id
                FROM {schema}."projects"
                WHERE project_id = CAST($1 AS uuid)
            ), code_documents AS MATERIALIZED (
                SELECT DISTINCT ON (documents.symbol_id)
                       documents.symbol_id,
                       documents.metadata,
                       documents.document_kind
                FROM {schema}."search_documents" AS documents
                JOIN current ON current.generation_id = documents.generation_id
                WHERE documents.project_id = CAST($1 AS uuid)
                  AND documents.symbol_id IS NOT NULL
                  AND documents.document_kind IN ('symbol', 'test')
                ORDER BY documents.symbol_id,
                         CASE WHEN documents.document_kind = 'test' THEN 0 ELSE 1 END,
                         documents.id
            ), population AS (
                SELECT GREATEST(COUNT(*) - 1, 1)::double precision AS possible_peers
                FROM {schema}."symbols" AS symbols
                JOIN current ON current.generation_id = symbols.generation_id
                JOIN code_documents AS population_document
                  ON population_document.symbol_id = symbols.symbol_id
                 AND population_document.document_kind = 'symbol'
                WHERE symbols.project_id = CAST($1 AS uuid)
                  AND symbols.symbol_kind NOT IN ('file', 'import', 'parameter')
            ), previous AS (
                SELECT generations.generation_id, generations.published_at
                FROM {schema}."index_generations" AS generations
                WHERE generations.project_id = CAST($1 AS uuid)
                  AND generations.state = 'superseded'
                ORDER BY generations.generation_sequence DESC
                LIMIT 1
            ), outgoing AS (
                SELECT edges.source_symbol_id AS symbol_id,
                       COUNT(DISTINCT edges.target_symbol_id)::bigint AS dependencies
                FROM {schema}."edges" AS edges
                JOIN current ON current.generation_id = edges.generation_id
                WHERE edges.project_id = CAST($1 AS uuid)
                  AND edges.edge_kind <> 'contains'
                  AND edges.target_symbol_id <> edges.source_symbol_id
                GROUP BY edges.source_symbol_id
            ), unresolved AS (
                SELECT refs.owner_symbol_id AS symbol_id,
                       SUM(refs.site_count)::bigint AS sites
                FROM {schema}."references" AS refs
                JOIN current ON current.generation_id = refs.generation_id
                WHERE refs.project_id = CAST($1 AS uuid)
                  AND refs.target_symbol_id IS NULL
                  AND refs.owner_symbol_id IS NOT NULL
                  AND refs.resolution_provenance NOT IN (
                        'native-dynamic-unresolved',
                        'native-member-unresolved',
                        'native-rust-external',
                        'native-rust-intrinsic',
                        'native-rust-macro-unexpanded',
                        'native-external-reference',
                        'native-javascript-intrinsic',
                        'native-shell-command',
                        'native-manifest-reference'
                      )
                  AND refs.resolution_provenance NOT LIKE
                      'native-embedded-sql-%-unresolved'
                GROUP BY refs.owner_symbol_id
            ), dynamic_method_calls AS (
                SELECT refs.file_id,
                       regexp_replace(
                           refs.reference_name,
                           E'^.*\\.([A-Za-z_][A-Za-z0-9_]*)(::[^.]*)?$',
                           E'\\1'
                       ) AS simple_name,
                       SUM(refs.site_count)::bigint AS sites
                FROM {schema}."references" AS refs
                JOIN current ON current.generation_id = refs.generation_id
                WHERE refs.project_id = CAST($1 AS uuid)
                  AND refs.target_symbol_id IS NULL
                  AND refs.reference_kind = 'calls'
                  AND refs.resolution_provenance = 'native-dynamic-unresolved'
                GROUP BY refs.file_id, simple_name
            ), potential_method_incoming AS (
                SELECT methods.symbol_id,
                       SUM(dynamic_method_calls.sites)::bigint AS sites
                FROM {schema}."symbols" AS methods
                JOIN current ON current.generation_id = methods.generation_id
                JOIN dynamic_method_calls
                  ON dynamic_method_calls.simple_name = methods.simple_name
                 AND dynamic_method_calls.file_id <> methods.file_id
                WHERE methods.project_id = CAST($1 AS uuid)
                  AND methods.symbol_kind = 'method'
                  AND methods.exported
                  AND methods.visibility = 'internal'
                GROUP BY methods.symbol_id
            ), incoming AS (
                SELECT edges.target_symbol_id AS symbol_id,
                       SUM(edges.site_count)::bigint AS sites,
                       COUNT(*) FILTER (
                           WHERE source.file_id <> target.file_id
                       )::bigint AS external_edges
                FROM {schema}."edges" AS edges
                JOIN current ON current.generation_id = edges.generation_id
                JOIN {schema}."symbols" AS source
                  ON source.project_id = edges.project_id
                 AND source.generation_id = edges.generation_id
                 AND source.symbol_id = edges.source_symbol_id
                JOIN {schema}."symbols" AS target
                  ON target.project_id = edges.project_id
                 AND target.generation_id = edges.generation_id
                 AND target.symbol_id = edges.target_symbol_id
                WHERE edges.project_id = CAST($1 AS uuid)
                  AND edges.edge_kind <> 'contains'
                GROUP BY edges.target_symbol_id
            ), members AS (
                SELECT parent.symbol_id,
                       COUNT(child.symbol_id) FILTER (
                           WHERE child.symbol_kind IN ('function', 'method')
                             AND child_documents.id IS NOT NULL
                             AND COALESCE(
                                   (child_documents.metadata #>> ARRAY['health','code_lines'])::double precision,
                                   0.0
                                 ) >= 5.0
                       )::bigint AS behavioral_methods,
                       COUNT(child.symbol_id) FILTER (
                           WHERE child.symbol_kind IN ('function', 'method')
                             AND child_documents.id IS NOT NULL
                             AND COALESCE(
                                   (child_documents.metadata #>> ARRAY['health','cyclomatic'])::double precision,
                                   0.0
                                 ) >= 3.0
                       )::bigint AS complex_methods
                FROM {schema}."symbols" AS parent
                JOIN current ON current.generation_id = parent.generation_id
                LEFT JOIN {schema}."edges" AS containment
                  ON containment.project_id = parent.project_id
                 AND containment.generation_id = parent.generation_id
                 AND containment.source_symbol_id = parent.symbol_id
                 AND containment.edge_kind = 'contains'
                LEFT JOIN {schema}."symbols" AS child
                  ON child.project_id = containment.project_id
                 AND child.generation_id = containment.generation_id
                 AND child.symbol_id = containment.target_symbol_id
                LEFT JOIN {schema}."search_documents" AS child_documents
                  ON child_documents.project_id = child.project_id
                 AND child_documents.generation_id = child.generation_id
                 AND child_documents.symbol_id = child.symbol_id
                 AND child_documents.document_kind = 'symbol'
                WHERE parent.project_id = CAST($1 AS uuid)
                GROUP BY parent.symbol_id
            ), production_clone_symbols AS (
                SELECT symbols.*, files.normalized_path,
                       search.metadata AS search_metadata
                FROM {schema}."symbols" AS symbols
                JOIN current ON current.generation_id = symbols.generation_id
                JOIN {schema}."files" AS files
                  ON files.project_id = symbols.project_id
                 AND files.generation_id = symbols.generation_id
                 AND files.file_id = symbols.file_id
                JOIN {schema}."search_documents" AS search
                  ON search.project_id = symbols.project_id
                 AND search.generation_id = symbols.generation_id
                 AND search.symbol_id = symbols.symbol_id
                 AND search.document_kind = 'symbol'
                WHERE symbols.project_id = CAST($1 AS uuid)
                  AND symbols.symbol_kind IN ('function', 'method', 'component')
                  AND COALESCE(
                        (search.metadata ->> 'duplicate_detection_enabled')::boolean,
                        true
                      )
                  AND files.normalized_path !~* '(^|/)(fixtures?|test-beds?|__tests__|__mocks__|tests?|specs?|integration|testing|testlib)(/|$)'
                  AND files.normalized_path !~* '(\.test\.|\.spec\.|_test\.|_spec\.)[a-z0-9]+$'
                  AND files.normalized_path !~ '([A-Za-z](Test|Tests|TestCase|Spec))\.[a-z0-9]+$'
                  AND files.normalized_path !~* '(^|/)(test[-_][^/]*|test|mocks?|fixtures?)\.[a-z0-9]+$'
                  AND files.normalized_path !~* '(^|/)(bench(es|marks?)?|scripts?|examples?|samples?|demos?)(/|$)'
                  AND files.normalized_path !~* '\.(gen|generated)\.[a-z0-9]+$'
                  AND files.normalized_path !~* '^(publish|release|build|deploy|bundle|prepublish|postinstall)\.[mc]?[jt]s$'
            ), duplicates AS (
                SELECT structural_digest, COUNT(*)::bigint AS copies
                FROM production_clone_symbols
                WHERE end_line - start_line + 1 >= 6
                GROUP BY structural_digest
                HAVING COUNT(*) > 1
            ), clone_shapes AS (
                SELECT symbols.search_metadata ->> 'clone_shape_digest' AS clone_shape_digest,
                       COUNT(*)::bigint AS copies
                FROM production_clone_symbols AS symbols
                LEFT JOIN duplicates
                  ON duplicates.structural_digest = symbols.structural_digest
                WHERE duplicates.structural_digest IS NULL
                  AND symbols.end_line - symbols.start_line + 1 >= 12
                  AND COALESCE(
                        (symbols.search_metadata #>> ARRAY['health','literal_bytes'])::double precision,
                        0.0
                      ) / GREATEST(symbols.end_byte - symbols.start_byte, 1)::double precision <= 0.6
                  AND symbols.search_metadata ->> 'clone_shape_digest' IS NOT NULL
                GROUP BY symbols.search_metadata ->> 'clone_shape_digest'
                HAVING COUNT(*) > 1
                   AND COUNT(DISTINCT symbols.structural_digest) > 1
            ), syntactically_unclaimed_clone_symbols AS (
                SELECT symbols.*
                FROM production_clone_symbols AS symbols
                LEFT JOIN duplicates
                  ON duplicates.structural_digest = symbols.structural_digest
                LEFT JOIN clone_shapes
                  ON clone_shapes.clone_shape_digest =
                     symbols.search_metadata ->> 'clone_shape_digest'
                WHERE duplicates.structural_digest IS NULL
                  AND NOT (
                        clone_shapes.clone_shape_digest IS NOT NULL
                        AND symbols.end_line - symbols.start_line + 1 >= 12
                        AND COALESCE(
                              (symbols.search_metadata #>> ARRAY['health','literal_bytes'])::double precision,
                              0.0
                            ) / GREATEST(
                                  symbols.end_byte - symbols.start_byte,
                                  1
                                )::double precision <= 0.6
                      )
                  AND COALESCE(
                        (symbols.search_metadata #>> ARRAY['partial_clone','peer_count'])::bigint,
                        0
                      ) = 0
                  AND symbols.end_line - symbols.start_line + 1 >= 6
            ), semantic_clone_pairs AS (
                SELECT edges.source_symbol_id AS source_symbol_id,
                       edges.target_symbol_id AS target_symbol_id,
                       MAX(edges.score) AS score
                FROM {schema}."symbol_similarity_edges" AS edges
                JOIN current ON current.generation_id = edges.generation_id
                JOIN {schema}."symbol_similarity_builds" AS builds
                  ON builds.project_id = edges.project_id
                 AND builds.generation_id = edges.generation_id
                 AND builds.model_id = edges.model_id
                JOIN syntactically_unclaimed_clone_symbols AS source
                  ON source.project_id = edges.project_id
                 AND source.generation_id = edges.generation_id
                 AND source.symbol_id = edges.source_symbol_id
                JOIN syntactically_unclaimed_clone_symbols AS target
                  ON target.project_id = edges.project_id
                 AND target.generation_id = edges.generation_id
                 AND target.symbol_id = edges.target_symbol_id
                WHERE edges.project_id = CAST($1 AS uuid)
                  AND edges.score >= 0.95
                  AND edges.score <= 1.0
                  AND edges.source_symbol_id <> edges.target_symbol_id
                GROUP BY edges.source_symbol_id, edges.target_symbol_id
            ), undirected_semantic_clone_pairs AS (
                SELECT source_symbol_id AS symbol_id, target_symbol_id AS peer_symbol_id, score
                FROM semantic_clone_pairs
                UNION ALL
                SELECT target_symbol_id AS symbol_id, source_symbol_id AS peer_symbol_id, score
                FROM semantic_clone_pairs
            ), semantic_clone_peers AS (
                SELECT symbol_id, COUNT(DISTINCT peer_symbol_id)::bigint AS peers,
                       MAX(score) AS maximum_score
                FROM undirected_semantic_clone_pairs
                GROUP BY symbol_id
            ), source_classes AS (
                SELECT methods.symbol_id, containers.symbol_id AS class_id
                FROM {schema}."symbols" AS methods
                JOIN current ON current.generation_id = methods.generation_id
                JOIN {schema}."edges" AS containment
                  ON containment.project_id = methods.project_id
                 AND containment.generation_id = methods.generation_id
                 AND containment.target_symbol_id = methods.symbol_id
                 AND containment.edge_kind = 'contains'
                JOIN {schema}."symbols" AS containers
                  ON containers.project_id = containment.project_id
                 AND containers.generation_id = containment.generation_id
                 AND containers.symbol_id = containment.source_symbol_id
                WHERE methods.project_id = CAST($1 AS uuid)
                  AND methods.symbol_kind = 'method'
                  AND containers.symbol_kind IN ('class','struct','trait')
            ), field_classes AS (
                SELECT fields.symbol_id AS field_id, containers.symbol_id AS class_id
                FROM {schema}."symbols" AS fields
                JOIN current ON current.generation_id = fields.generation_id
                JOIN {schema}."edges" AS containment
                  ON containment.project_id = fields.project_id
                 AND containment.generation_id = fields.generation_id
                 AND containment.target_symbol_id = fields.symbol_id
                 AND containment.edge_kind = 'contains'
                JOIN {schema}."symbols" AS containers
                  ON containers.project_id = containment.project_id
                 AND containers.generation_id = containment.generation_id
                 AND containers.symbol_id = containment.source_symbol_id
                WHERE fields.project_id = CAST($1 AS uuid)
                  AND fields.symbol_kind IN ('field','property','method')
                  AND containers.symbol_kind IN ('class','struct','trait','interface')
            ), feature_envy_accesses AS (
                SELECT refs.owner_symbol_id AS symbol_id,
                       source_classes.class_id AS source_class_id,
                       field_classes.field_id,
                       field_classes.class_id AS field_class_id,
                       refs.site_count
                FROM {schema}."references" AS refs
                JOIN current ON current.generation_id = refs.generation_id
                JOIN source_classes ON source_classes.symbol_id = refs.owner_symbol_id
                JOIN field_classes ON field_classes.field_id = refs.target_symbol_id
                WHERE refs.project_id = CAST($1 AS uuid)
                  AND refs.reference_kind = 'field_access'
            ), feature_envy AS (
                SELECT symbol_id,
                       COUNT(DISTINCT field_id) FILTER (
                           WHERE field_class_id <> source_class_id
                       )::bigint AS atfd,
                       COUNT(DISTINCT field_class_id) FILTER (
                           WHERE field_class_id <> source_class_id
                       )::bigint AS fdp,
                       SUM(site_count) FILTER (
                           WHERE field_class_id = source_class_id
                       )::bigint AS own_accesses,
                       SUM(site_count) FILTER (
                           WHERE field_class_id <> source_class_id
                       )::bigint AS foreign_accesses
                FROM feature_envy_accesses
                GROUP BY symbol_id
            ), prior_symbols AS (
                SELECT symbols.symbol_id,
                       symbols.end_line - symbols.start_line + 1 AS lines,
                       previous.published_at
                FROM {schema}."symbols" AS symbols
                JOIN previous ON previous.generation_id = symbols.generation_id
                WHERE symbols.project_id = CAST($1 AS uuid)
            ), selected_coverage AS (
                SELECT DISTINCT ON (coverage.symbol_id)
                       coverage.symbol_id, coverage.coverage_fraction
                FROM {schema}."symbol_coverage" AS coverage
                JOIN current ON current.generation_id = coverage.generation_id
                WHERE coverage.project_id = CAST($1 AS uuid)
                  AND coverage.lines_found > 0
                ORDER BY coverage.symbol_id,
                         coverage.coverage_fraction DESC NULLS LAST,
                         coverage.source_id
            ), ranked_coverage AS (
                SELECT coverage.symbol_id, coverage.coverage_fraction,
                       percent_rank() OVER (
                           ORDER BY COALESCE(incoming.sites, 0)
                       ) AS centrality_percentile
                FROM selected_coverage AS coverage
                LEFT JOIN incoming ON incoming.symbol_id = coverage.symbol_id
            ), base AS (
                SELECT symbols.symbol_id, files.normalized_path AS path,
                       symbols.qualified_name, symbols.symbol_kind,
                       symbols.structural_digest,
                       documents.metadata ->> 'clone_shape_digest' AS clone_shape_digest,
                       documents.metadata #> ARRAY['partial_clone','listed_peer_symbol_ids'] AS partial_clone_listed_peer_ids,
                       symbols.start_line, symbols.end_line,
                       symbols.end_line - symbols.start_line + 1 AS lines,
                       symbols.exported, symbols.default_export,
                       COALESCE(symbols.visibility = 'public', false) AS declared_external_api,
                       documents.document_kind = 'test' AS test_source,
                       (
                           (
                               files.normalized_path ~ '(^|/)routes/.*\.[jt]sx?$'
                               AND symbols.qualified_name ~ '(^|::|[.#/$])Route$'
                           )
                           OR (
                               files.normalized_path ~ '(^|/)app/routes/.*\.[jt]sx?$'
                               AND (
                                   symbols.default_export
                                   OR symbols.qualified_name ~ '(^|::|[.#/$])(loader|clientLoader|action|clientAction|headers|handle|links|meta|shouldRevalidate|middleware|clientMiddleware|unstable_middleware|unstable_clientMiddleware|ErrorBoundary|HydrateFallback)$'
                               )
                           )
                           OR (
                               files.normalized_path ~ '(^|/)app/root\.[jt]sx?$'
                               AND (
                                   symbols.default_export
                                   OR symbols.qualified_name ~ '(^|::|[.#/$])(loader|clientLoader|action|clientAction|headers|handle|links|meta|shouldRevalidate|middleware|clientMiddleware|unstable_middleware|unstable_clientMiddleware|ErrorBoundary|HydrateFallback|Layout)$'
                               )
                           )
                           OR (
                               files.normalized_path ~ '(^|/)app/entry\.server\.[jt]sx?$'
                               AND (
                                   symbols.default_export
                                   OR symbols.qualified_name ~ '(^|::|[.#/$])(handleRequest|handleDataRequest|handleError|streamTimeout)$'
                               )
                           )
                           OR (
                               files.normalized_path ~ '(^|/)app/(.*/)?(page|layout|template|route|error|global-error|loading|not-found|default|sitemap|robots|manifest|icon|apple-icon|opengraph-image|twitter-image)\.(ts|tsx|js|jsx|mjs)$'
                               AND symbols.qualified_name ~ '(^|::|[.#/$])(dynamic|dynamicParams|revalidate|fetchCache|runtime|preferredRegion|maxDuration|experimental_ppr|generateStaticParams|generateImageMetadata|generateSitemaps)$'
                           )
                           OR (
                               files.normalized_path ~ '(^|/)app/(.*/)?route\.(ts|tsx|js|jsx|mjs)$'
                               AND symbols.qualified_name ~ '(^|::|[.#/$])(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$'
                           )
                           OR (
                               files.normalized_path ~ '(^|/)app/(.*/)?(page|layout|template|error|global-error|loading|not-found|default|sitemap|robots|manifest|icon|apple-icon|opengraph-image|twitter-image)\.(ts|tsx|js|jsx|mjs)$'
                               AND symbols.qualified_name ~ '(^|::|[.#/$])(metadata|generateMetadata|viewport|generateViewport)$'
                           )
                           OR (
                               files.normalized_path ~ '^(src/)?middleware\.(ts|js|mjs)$'
                               AND symbols.qualified_name ~ '(^|::|[.#/$])(middleware|config)$'
                           )
                           OR (
                               files.normalized_path ~ '^(src/)?instrumentation\.(ts|js|mjs)$'
                               AND symbols.qualified_name ~ '(^|::|[.#/$])(register|onRequestError)$'
                           )
                       ) AS framework_convention_export,
                       LEAST(
                           1.0,
                           COALESCE(incoming.sites, 0)::double precision
                           / population.possible_peers
                       ) AS degree_centrality,
                       COALESCE(outgoing.dependencies, 0)::bigint AS outgoing,
                       COALESCE(unresolved.sites, 0)::bigint AS unresolved,
                       (
                           COALESCE(incoming.external_edges, 0)
                           + COALESCE(potential_method_incoming.sites, 0)
                       )::bigint AS external_incoming,
                       COALESCE(members.behavioral_methods, 0)::bigint AS behavioral_methods,
                       COALESCE(members.complex_methods, 0)::bigint AS complex_methods,
                       COALESCE(duplicates.copies, 0)::bigint AS duplicate_copies,
                       COALESCE(clone_shape_match.copies, 0)::bigint AS clone_shape_copies,
                       COALESCE(
                           (documents.metadata #>> ARRAY['partial_clone','peer_count'])::bigint,
                           0
                       ) AS partial_clone_peers,
                       COALESCE(
                           (documents.metadata #>> ARRAY['partial_clone','maximum_overlap_ppm'])::double precision,
                           0.0
                       ) AS partial_clone_maximum_overlap_ppm,
                       COALESCE(
                           (documents.metadata #>> ARRAY['partial_clone','minimum_overlap_ppm'])::double precision,
                           0.0
                       ) AS partial_clone_minimum_overlap_ppm,
                       COALESCE(semantic_clone_peers.peers, 0)::bigint AS semantic_clone_peers,
                       COALESCE(semantic_clone_peers.maximum_score, 0.0)::double precision AS semantic_clone_maximum_score,
                       COALESCE(feature_envy.atfd, 0)::bigint AS feature_envy_atfd,
                       COALESCE(feature_envy.fdp, 0)::bigint AS feature_envy_fdp,
                       COALESCE(feature_envy.own_accesses, 0)::bigint AS own_accesses,
                       COALESCE(feature_envy.foreign_accesses, 0)::bigint AS foreign_accesses,
                       COALESCE(feature_envy.own_accesses, 0)::double precision /
                           GREATEST(
                               COALESCE(feature_envy.own_accesses, 0)
                               + COALESCE(feature_envy.foreign_accesses, 0),
                               1
                           )::double precision AS local_attribute_access,
                       prior_symbols.lines AS prior_lines,
                       prior_symbols.published_at AS prior_published_at,
                       ranked_coverage.coverage_fraction,
                       ranked_coverage.centrality_percentile,
                       COALESCE(
                           NULLIF(
                               (documents.metadata #>> ARRAY['health','code_lines'])::double precision,
                               0.0
                           ),
                           symbols.end_line - symbols.start_line + 1
                       ) AS code_lines,
                       COALESCE((documents.metadata #>> ARRAY['health','parameter_count'])::double precision, 0.0) AS parameter_count,
                       COALESCE((documents.metadata #>> ARRAY['health','cyclomatic'])::double precision, 0.0) AS cyclomatic,
                       COALESCE((documents.metadata #>> ARRAY['health','max_nesting'])::double precision, 0.0) AS max_nesting,
                       COALESCE((documents.metadata #>> ARRAY['health','max_conditional_operands'])::double precision, 0.0) AS max_conditional_operands,
                       COALESCE((documents.metadata #>> ARRAY['health','magic_numbers'])::double precision, 0.0) AS magic_numbers,
                       COALESCE((documents.metadata #>> ARRAY['health','hardcoded_urls'])::double precision, 0.0) AS hardcoded_urls,
                       COALESCE((documents.metadata #>> ARRAY['health','secrets_score'])::double precision, 0.0) AS secrets_score,
                       COALESCE((documents.metadata #>> ARRAY['health','stale_doc_numbers'])::double precision, 0.0) AS stale_doc_numbers,
                       COALESCE((documents.metadata #>> ARRAY['health','accidental_quadratic'])::double precision, 0.0) AS accidental_quadratic,
                       COALESCE((documents.metadata #>> ARRAY['health','empty_catches'])::double precision, 0.0) AS empty_catches,
                       COALESCE((documents.metadata #>> ARRAY['health','sync_io_in_async'])::double precision, 0.0) AS sync_io_in_async,
                       COALESCE((documents.metadata #>> ARRAY['health','sequential_await_loops'])::double precision, 0.0) AS sequential_await_loops,
                       COALESCE((documents.metadata #>> ARRAY['health','ts_any_casts'])::double precision, 0.0) AS ts_any_casts,
                       COALESCE((documents.metadata #>> ARRAY['health','ts_suppressions'])::double precision, 0.0) AS ts_suppressions,
                       COALESCE((documents.metadata #>> ARRAY['health','debug_logs'])::double precision, 0.0) AS debug_logs,
                       COALESCE((documents.metadata #>> ARRAY['health','incomplete_markers'])::double precision, 0.0) AS incomplete_markers,
                       COALESCE((documents.metadata #>> ARRAY['health','dynamic_eval'])::double precision, 0.0) AS dynamic_eval,
                       COALESCE((documents.metadata #>> ARRAY['health','insecure_hash'])::double precision, 0.0) AS insecure_hash,
                       COALESCE((documents.metadata #>> ARRAY['health','insecure_random'])::double precision, 0.0) AS insecure_random,
                       COALESCE((documents.metadata #>> ARRAY['health','http_without_timeout'])::double precision, 0.0) AS http_without_timeout,
                       COALESCE((documents.metadata #>> ARRAY['health','sql_string_concatenation'])::double precision, 0.0) AS sql_string_concatenation,
                       COALESCE((documents.metadata #>> ARRAY['health','unsafe_json_parse'])::double precision, 0.0) AS unsafe_json_parse,
                       COALESCE((documents.metadata #>> ARRAY['health','unvalidated_env'])::double precision, 0.0) AS unvalidated_env,
                       COALESCE((documents.metadata #>> ARRAY['health','empty_body'])::double precision, 0.0) AS empty_body
                FROM {schema}."symbols" AS symbols
                JOIN current ON current.generation_id = symbols.generation_id
                JOIN {schema}."files" AS files
                  ON files.project_id = symbols.project_id
                 AND files.generation_id = symbols.generation_id
                 AND files.file_id = symbols.file_id
                LEFT JOIN outgoing ON outgoing.symbol_id = symbols.symbol_id
                LEFT JOIN unresolved ON unresolved.symbol_id = symbols.symbol_id
                LEFT JOIN incoming ON incoming.symbol_id = symbols.symbol_id
                LEFT JOIN potential_method_incoming
                  ON potential_method_incoming.symbol_id = symbols.symbol_id
                LEFT JOIN members ON members.symbol_id = symbols.symbol_id
                LEFT JOIN duplicates ON duplicates.structural_digest = symbols.structural_digest
                LEFT JOIN LATERAL (
                    SELECT clone_shapes.copies
                    FROM {schema}."search_documents" AS clone_document
                    JOIN clone_shapes
                      ON clone_shapes.clone_shape_digest =
                         clone_document.metadata ->> 'clone_shape_digest'
                    WHERE clone_document.project_id = symbols.project_id
                      AND clone_document.generation_id = symbols.generation_id
                      AND clone_document.symbol_id = symbols.symbol_id
                      AND clone_document.document_kind = 'symbol'
                    ORDER BY clone_document.id
                    LIMIT 1
                ) AS clone_shape_match ON true
                LEFT JOIN feature_envy ON feature_envy.symbol_id = symbols.symbol_id
                LEFT JOIN semantic_clone_peers ON semantic_clone_peers.symbol_id = symbols.symbol_id
                LEFT JOIN prior_symbols ON prior_symbols.symbol_id = symbols.symbol_id
                LEFT JOIN ranked_coverage ON ranked_coverage.symbol_id = symbols.symbol_id
                CROSS JOIN population
                JOIN code_documents AS documents
                  ON documents.symbol_id = symbols.symbol_id
                 AND documents.document_kind = 'symbol'
                WHERE symbols.project_id = CAST($1 AS uuid)
                  AND symbols.symbol_kind NOT IN ('file', 'import', 'parameter')
            ), findings AS (
                SELECT base.symbol_id, base.path, base.qualified_name,
                       candidate.finding, candidate.metric_name, candidate.metric,
                       CASE
                         WHEN candidate.metric >= candidate.error_threshold THEN 'error'
                         WHEN candidate.metric >= candidate.warning_threshold THEN 'warning'
                         ELSE 'info'
                       END AS severity,
                       base.start_line, base.end_line, base.degree_centrality,
                       base.outgoing, base.unresolved,
                       CASE WHEN candidate.finding = 'duplicate_code' THEN
                         jsonb_strip_nulls(jsonb_build_object(
                           'cloneType', CASE
                             WHEN base.duplicate_copies > 1 THEN 'exact'
                             WHEN base.clone_shape_copies > 1 THEN 'near'
                             WHEN base.partial_clone_peers > 0 THEN 'partial'
                             ELSE 'semantic'
                           END,
                           'classSize', CASE
                             WHEN base.duplicate_copies > 1 THEN base.duplicate_copies
                             WHEN base.clone_shape_copies > 1 THEN base.clone_shape_copies
                             WHEN base.partial_clone_peers > 0 THEN base.partial_clone_peers + 1
                             ELSE base.semantic_clone_peers + 1
                           END,
                           'loc', base.lines,
                           'maximumOverlap', CASE
                             WHEN base.partial_clone_peers > 0
                             THEN base.partial_clone_maximum_overlap_ppm / 1000000.0
                             ELSE NULL
                           END,
                           'minimumOverlap', CASE
                             WHEN base.partial_clone_peers > 0
                             THEN base.partial_clone_minimum_overlap_ppm / 1000000.0
                             ELSE NULL
                           END,
                           'maximumSemanticScore', CASE
                             WHEN base.semantic_clone_peers > 0
                             THEN base.semantic_clone_maximum_score
                             ELSE NULL
                           END,
                           'semanticThreshold', CASE
                             WHEN base.semantic_clone_peers > 0 THEN 0.95
                             ELSE NULL
                           END,
                           'members', CASE
                             WHEN base.duplicate_copies > 1 THEN (
                               SELECT COALESCE(jsonb_agg(member.payload ORDER BY member.path, member.start_line, member.symbol_id), '[]'::jsonb)
                               FROM (
                                 SELECT peer.normalized_path AS path,
                                        peer.start_line,
                                        peer.symbol_id,
                                        jsonb_build_object(
                                          'symbolId', peer.symbol_id::text,
                                          'qualifiedName', peer.qualified_name,
                                          'location', peer.normalized_path || ':' || peer.start_line::text
                                        ) AS payload
                                 FROM production_clone_symbols AS peer
                                 WHERE peer.symbol_id <> base.symbol_id
                                   AND peer.structural_digest = base.structural_digest
                                   AND peer.end_line - peer.start_line + 1 >= 6
                                 ORDER BY peer.normalized_path, peer.start_line, peer.symbol_id
                                 LIMIT 10
                               ) AS member
                             )
                             WHEN base.clone_shape_copies > 1 THEN (
                               SELECT COALESCE(jsonb_agg(member.payload ORDER BY member.path, member.start_line, member.symbol_id), '[]'::jsonb)
                               FROM (
                                 SELECT peer.normalized_path AS path,
                                        peer.start_line,
                                        peer.symbol_id,
                                        jsonb_build_object(
                                          'symbolId', peer.symbol_id::text,
                                          'qualifiedName', peer.qualified_name,
                                          'location', peer.normalized_path || ':' || peer.start_line::text
                                        ) AS payload
                                 FROM production_clone_symbols AS peer
                                 LEFT JOIN duplicates AS exact_peer
                                   ON exact_peer.structural_digest = peer.structural_digest
                                 WHERE peer.symbol_id <> base.symbol_id
                                   AND exact_peer.structural_digest IS NULL
                                   AND peer.search_metadata ->> 'clone_shape_digest' = base.clone_shape_digest
                                   AND peer.end_line - peer.start_line + 1 >= 12
                                   AND COALESCE(
                                         (peer.search_metadata #>> ARRAY['health','literal_bytes'])::double precision,
                                         0.0
                                       ) / GREATEST(peer.end_byte - peer.start_byte, 1)::double precision <= 0.6
                                 ORDER BY peer.normalized_path, peer.start_line, peer.symbol_id
                                 LIMIT 10
                               ) AS member
                             )
                             WHEN base.partial_clone_peers > 0 THEN (
                               SELECT COALESCE(jsonb_agg(member.payload ORDER BY member.path, member.start_line, member.symbol_id), '[]'::jsonb)
                               FROM (
                                 SELECT peer.normalized_path AS path,
                                        peer.start_line,
                                        peer.symbol_id,
                                        jsonb_build_object(
                                          'symbolId', peer.symbol_id::text,
                                          'qualifiedName', peer.qualified_name,
                                          'location', peer.normalized_path || ':' || peer.start_line::text
                                        ) AS payload
                                 FROM jsonb_array_elements_text(
                                        COALESCE(base.partial_clone_listed_peer_ids, '[]'::jsonb)
                                      ) AS listed(symbol_id)
                                 JOIN production_clone_symbols AS peer
                                   ON peer.symbol_id::text = listed.symbol_id
                                 ORDER BY peer.normalized_path, peer.start_line, peer.symbol_id
                                 LIMIT 10
                               ) AS member
                             )
                             ELSE (
                               SELECT COALESCE(jsonb_agg(member.payload ORDER BY member.path, member.start_line, member.symbol_id), '[]'::jsonb)
                               FROM (
                                 SELECT DISTINCT peer.normalized_path AS path,
                                        peer.start_line,
                                        peer.symbol_id,
                                        jsonb_build_object(
                                          'symbolId', peer.symbol_id::text,
                                          'qualifiedName', peer.qualified_name,
                                          'location', peer.normalized_path || ':' || peer.start_line::text
                                        ) AS payload
                                 FROM undirected_semantic_clone_pairs AS relation
                                 JOIN production_clone_symbols AS peer
                                   ON peer.symbol_id = relation.peer_symbol_id
                                 WHERE relation.symbol_id = base.symbol_id
                                 ORDER BY peer.normalized_path, peer.start_line, peer.symbol_id
                                 LIMIT 10
                               ) AS member
                             )
                           END
                         ))
                       ELSE NULL END AS detail
                FROM base
                CROSS JOIN LATERAL (
                    VALUES
                      ('large_method'::text, 'lines'::text, base.code_lines, 100.0, 100.0, 200.0, base.symbol_kind IN ('function','method','component')),
                      ('complex_method', 'cyclomatic', base.cyclomatic, 15.0, 15.0, 25.0, base.symbol_kind IN ('function','method','component')),
                      ('nested_complexity', 'max_nesting', base.max_nesting, 5.0, 5.0, 7.0, base.symbol_kind IN ('function','method','component')),
                      ('complex_conditional', 'conditional_operands', base.max_conditional_operands, 6.0, 6.0, 8.0, base.symbol_kind IN ('function','method','component')),
                      ('long_parameter_list', 'parameters', base.parameter_count, 4.0, 5.0, 7.0, base.symbol_kind IN ('function','method','component')),
                      ('brain_method', 'composite_risk', (base.code_lines / 100.0) * (base.cyclomatic / 10.0) * GREATEST(1.0, base.max_nesting / 3.0) * GREATEST(1.0, base.max_conditional_operands / 4.0), 5.0, 10.0, 20.0, base.symbol_kind IN ('function','method','component') AND base.code_lines >= 50 AND base.cyclomatic >= 8),
                      ('magic_number', 'occurrences', base.magic_numbers, 3.0, 5.0, 8.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('hardcoded_url', 'occurrences', base.hardcoded_urls, 1.0, 2.0, 3.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('recently_grew', 'growth_percent', base.lines::double precision * 100.0 / GREATEST(base.prior_lines, 1), 150.0, 200.0, 300.0, base.symbol_kind IN ('function','method','component') AND base.prior_lines >= 20 AND base.lines > base.prior_lines * 1.5 AND base.prior_published_at >= clock_timestamp() - interval '30 days'),
                      ('stale_doc', 'disjoint_documented_numbers', base.stale_doc_numbers, 1.0, 999.0, 999.0, base.symbol_kind = 'constant'),
                      ('secrets_handling', 'confidence_percent', base.secrets_score, 50.0, 50.0, 70.0, base.symbol_kind IN ('function','method','component')),
                      ('god_class', 'behavioral_methods', base.behavioral_methods::double precision, 15.0, 40.0, 60.0, base.symbol_kind IN ('class','struct','module') AND base.complex_methods >= 5),
                      ('feature_envy', 'foreign_field_accesses', base.feature_envy_atfd::double precision, 6.0, 12.0, 999.0, base.symbol_kind = 'method' AND base.feature_envy_fdp <= 2 AND base.local_attribute_access < (1.0 / 3.0)),
                      ('unused_export', 'external_incoming_edges', CASE WHEN base.exported AND base.external_incoming = 0 THEN 1.0 ELSE 0.0 END, 1.0, 1.0, 2.0, base.symbol_kind IN ('function','method','class','component','constant') AND base.path <> 'src/index.ts' AND base.path NOT LIKE '%.d.ts' AND NOT base.framework_convention_export AND NOT base.declared_external_api AND NOT base.test_source),
                      ('low_coverage', 'uncovered_percent', (1.0 - COALESCE(base.coverage_fraction, 1.0)) * 100.0, 50.0, 50.0, 80.0, base.symbol_kind IN ('function','method','component') AND base.coverage_fraction <= 0.5 AND base.centrality_percentile >= 0.9),
                      ('duplicate_code', CASE WHEN base.duplicate_copies > 1 THEN 'exact_copies' WHEN base.clone_shape_copies > 1 THEN 'normalized_shape_copies' WHEN base.partial_clone_peers > 0 THEN 'partial_clone_peers' ELSE 'semantic_clone_peers' END, CASE WHEN base.duplicate_copies > 1 THEN base.duplicate_copies WHEN base.clone_shape_copies > 1 THEN base.clone_shape_copies WHEN base.partial_clone_peers > 0 THEN base.partial_clone_peers ELSE base.semantic_clone_peers END::double precision, CASE WHEN base.duplicate_copies > 1 OR base.clone_shape_copies > 1 THEN 2.0 ELSE 1.0 END, CASE WHEN base.duplicate_copies > 1 THEN 2.0 ELSE 999.0 END, 999.0, base.symbol_kind IN ('function','method','component') AND ((base.duplicate_copies > 1 AND base.lines >= 6) OR (base.clone_shape_copies > 1 AND base.lines >= 12) OR (base.partial_clone_peers > 0 AND base.lines >= 12) OR (base.semantic_clone_peers > 0 AND base.lines >= 6))),
                      ('high_fan_out', 'outgoing_dependencies', base.outgoing::double precision, 25.0, 50.0, 100.0, base.symbol_kind IN ('function','method','component','class','struct','module')),
                      ('unresolved_reference_pressure', 'unresolved_sites', base.unresolved::double precision, 15.0, 40.0, 100.0, true),
                      ('accidental_quadratic', 'occurrences', base.accidental_quadratic, 1.0, 1.0, 5.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('empty_catch', 'occurrences', base.empty_catches, 1.0, 1.0, 3.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('sync_io_in_async', 'occurrences', base.sync_io_in_async, 1.0, 1.0, 3.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('forof_await', 'occurrences', base.sequential_await_loops, 1.0, 2.0, 5.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('ts_any_cast', 'occurrences', base.ts_any_casts, 2.0, 3.0, 5.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('ts_ignore_suppression', 'occurrences', base.ts_suppressions, 1.0, 1.0, 3.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('agent_debug_log', 'occurrences', base.debug_logs, 1.0, 1.0, 5.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('incomplete_marker', 'occurrences', base.incomplete_markers, 1.0, 5.0, 50.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('dynamic_eval', 'occurrences', base.dynamic_eval, 1.0, 1.0, 1.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('insecure_hash', 'occurrences', base.insecure_hash, 1.0, 1.0, 3.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('random_for_security', 'occurrences', base.insecure_random, 1.0, 1.0, 1.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('http_no_timeout', 'occurrences', base.http_without_timeout, 1.0, 1.0, 3.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('sql_string_concat', 'occurrences', base.sql_string_concatenation, 1.0, 1.0, 2.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('unsafe_json_parse', 'occurrences', base.unsafe_json_parse, 1.0, 1.0, 3.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('env_no_validation', 'occurrences', base.unvalidated_env, 1.0, 1.0, 3.0, base.symbol_kind IN ('function','method','component') AND base.lines >= 5),
                      ('empty_function_body', 'occurrences', base.empty_body, 1.0, 999.0, 999.0, base.symbol_kind IN ('function','method','component'))
                ) AS candidate(
                    finding, metric_name, metric, info_threshold,
                    warning_threshold, error_threshold, enabled
                )
                WHERE candidate.enabled AND candidate.metric >= candidate.info_threshold
            )
