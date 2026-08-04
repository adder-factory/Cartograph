#!/usr/bin/env bash

set -euo pipefail

docs_only=true
saw_path=false

while IFS= read -r -d '' path; do
  saw_path=true
  case "$path" in
    docs/releases/*.md)
      docs_only=false
      ;;
    README.md | AGENTS.md | ACKNOWLEDGEMENTS.md | \
      .claude/agents/reviewer.md | docs/*.md | \
      crates/*/tests/fixtures/*/README.md)
      ;;
    *)
      docs_only=false
      ;;
  esac
done

if [[ "$saw_path" != true || "$docs_only" != true ]]; then
  printf '%s\n' 'full=true' 'docs_only=false'
else
  printf '%s\n' 'full=false' 'docs_only=true'
fi
