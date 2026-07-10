#!/usr/bin/env bash
# Full local quality gate for Cartograph.
#
# This is intentionally heavier than CI's default check workflow: it combines
# the static gates, smoke tests, full test suite, coverage refresh, biomarker
# 0/0/0 floor, viewer smoke, and the local SonarQube quality gate.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SONAR_ENV_FILE="${SONAR_ENV_FILE:-$HOME/.sonarqube-env}"
SONAR_CE_ATTEMPTS="${SONAR_CE_ATTEMPTS:-60}"
SONAR_CE_SLEEP_SECONDS="${SONAR_CE_SLEEP_SECONDS:-2}"

cd "$ROOT"

run_step() {
  local label="$1"
  shift
  printf '\n== %s ==\n' "$label"
  "$@"
}

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'quality-full: required command not found: %s\n' "$command_name" >&2
    exit 1
  fi
}

load_sonar_env() {
  if [[ -n "${SONAR_TOKEN:-}" && -n "${SONAR_HOST_URL:-}" ]]; then
    return
  fi

  if [[ -f "$SONAR_ENV_FILE" ]]; then
    set -a
    # shellcheck source=/dev/null
    . "$SONAR_ENV_FILE"
    set +a
  fi

  if [[ -z "${SONAR_TOKEN:-}" || -z "${SONAR_HOST_URL:-}" ]]; then
    printf 'quality-full: SONAR_TOKEN and SONAR_HOST_URL are required for the Sonar gate.\n' >&2
    printf 'quality-full: export them or set SONAR_ENV_FILE to an env file. Default: %s\n' "$SONAR_ENV_FILE" >&2
    exit 1
  fi
}

poll_sonar_ce_task() {
  local task_id="$1"
  local task_json=""
  local task_status=""

  for _ in $(seq 1 "$SONAR_CE_ATTEMPTS"); do
    task_json="$(curl -sf -H "Authorization: Bearer $SONAR_TOKEN" "$SONAR_HOST_URL/api/ce/task?id=$task_id")"
    task_status="$(printf '%s' "$task_json" | jq -r '.task.status')"
    case "$task_status" in
      SUCCESS)
        printf '%s' "$task_json"
        return
        ;;
      FAILED | CANCELED)
        printf '%s\n' "$task_json" >&2
        return 1
        ;;
    esac
    sleep "$SONAR_CE_SLEEP_SECONDS"
  done

  printf 'quality-full: Sonar CE task did not finish after %s attempts. Last status: %s\n' \
    "$SONAR_CE_ATTEMPTS" "${task_status:-unknown}" >&2
  return 1
}

print_sonar_failure_context() {
  printf '\n== Sonar open issues ==\n'
  curl -sf -H "Authorization: Bearer $SONAR_TOKEN" \
    "$SONAR_HOST_URL/api/issues/search?components=cartograph&issueStatuses=OPEN&ps=100&additionalFields=_all" |
    jq -r '"open issues: \(.total)", (.issues[]? | "  - \(.rule) \(.component):\(.line // 0) \(.message)")'

  printf '\n== Sonar TO_REVIEW hotspots ==\n'
  curl -sf -H "Authorization: Bearer $SONAR_TOKEN" \
    "$SONAR_HOST_URL/api/hotspots/search?project=cartograph&status=TO_REVIEW&ps=100" |
    jq -r '"TO_REVIEW hotspots: \(.paging.total)", (.hotspots[]? | "  - \(.component):\(.line // 0) \(.message)")'
}

run_sonar_quality_gate() {
  require_command sonar
  require_command curl
  require_command jq
  load_sonar_env

  sonar scan

  local task_file=".scannerwork/report-task.txt"
  if [[ ! -f "$task_file" ]]; then
    printf 'quality-full: Sonar report task file not found: %s\n' "$task_file" >&2
    exit 1
  fi

  local task_id
  task_id="$(sed -n 's/^ceTaskId=//p' "$task_file")"
  if [[ -z "$task_id" ]]; then
    printf 'quality-full: Sonar CE task id missing from %s\n' "$task_file" >&2
    exit 1
  fi

  local task_json
  task_json="$(poll_sonar_ce_task "$task_id")"

  local analysis_id
  analysis_id="$(printf '%s' "$task_json" | jq -r '.task.analysisId')"
  if [[ -z "$analysis_id" || "$analysis_id" == "null" ]]; then
    printf 'quality-full: Sonar CE task did not produce an analysisId.\n' >&2
    exit 1
  fi

  local gate_json
  gate_json="$(curl -sf -H "Authorization: Bearer $SONAR_TOKEN" \
    "$SONAR_HOST_URL/api/qualitygates/project_status?analysisId=$analysis_id")"

  local gate_status
  gate_status="$(printf '%s' "$gate_json" | jq -r '.projectStatus.status')"
  printf 'Sonar quality gate: %s\n' "$gate_status"
  printf '%s\n' "$gate_json" |
    jq -r '.projectStatus.conditions[]? | "  - \(.metricKey): \(.status) actual=\(.actualValue // "n/a") threshold=\(.errorThreshold // "n/a")"'

  if [[ "$gate_status" != "OK" ]]; then
    print_sonar_failure_context
    exit 1
  fi
}

run_unskipped_test_suite() {
  STRESS=1 node scripts/with-postgres-test-env.mjs -- npm test
}

run_unskipped_coverage() {
  STRESS=1 node scripts/with-postgres-test-env.mjs -- npm run test:coverage
}

run_step "CI portability" npm run check:ci-portability
run_step "typecheck" npm run typecheck
run_step "architecture + biome" npm run check
run_step "test mock hygiene" npm run test:mock-hygiene
run_step "module leak canaries" npm run test:leaks
run_step "MCP load budget" npm run check:mcp-load
run_step "biomarker gate smoke" bun test __tests__/biomarker-gate.test.ts
run_step "full test suite" run_unskipped_test_suite
run_step "coverage" run_unskipped_coverage
run_step "biomarkers 0/0/0" npm run check:biomarkers
run_step "viewer smoke" npm run test:viewer-smoke:required
run_step "Sonar scanner + quality gate" run_sonar_quality_gate

printf '\nquality-full OK.\n'
