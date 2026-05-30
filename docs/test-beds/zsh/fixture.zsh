#!/usr/bin/env zsh
# Zsh test bed — functions, a variable, and a call between them.

LABEL="cartograph"

log_info() {
  print -P "%F{green}[${LABEL}]%f $1"
}

run() {
  log_info "starting"
}

run
