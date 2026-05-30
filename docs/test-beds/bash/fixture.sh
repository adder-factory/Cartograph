#!/usr/bin/env bash
# Bash test bed — functions, a variable, and a call between them.
set -euo pipefail

GREETING="hello"

greet() {
  echo "${GREETING} $1"
}

main() {
  greet "world"
}

main "$@"
