#!/usr/bin/env bash
# Idempotent boot helper. Silent when supervisors and children already match pidfiles.
# Logs only when it has to start something. A missing flock or /proc is an error.
set -euo pipefail
OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${OPS_DIR}/common.sh"

all_up() {
  pid_is_ours "${RUN_DIR}/bridge.supervisor.pid" || return 1
  pid_is_ours "${RUN_DIR}/bridge.pid" || return 1
  if [[ "${SKIP_TUNNEL:-}" == "1" ]]; then
    return 0
  fi
  pid_is_ours "${RUN_DIR}/tunnel.supervisor.pid" || return 1
  pid_is_ours "${RUN_DIR}/tunnel.pid" || return 1
  return 0
}

if all_up; then
  exit 0
fi

require_flock
LOCK="${RUN_DIR}/boot.lock"
exec 9>"${LOCK}"
if ! flock -n 9; then
  exit 0
fi

if all_up; then
  exit 0
fi

log "boot.sh: services not fully up — starting"
"${OPS_DIR}/start.sh"
