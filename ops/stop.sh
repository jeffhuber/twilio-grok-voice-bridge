#!/usr/bin/env bash
# Stop supervisors first, then children. Never signal a recycled PID.
set -euo pipefail
OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${OPS_DIR}/common.sh"

stop_one() {
  local name="$1"
  stop_recorded_pid "${RUN_DIR}/${name}.supervisor.pid" "${name}-supervisor" 5
  stop_recorded_pid "${RUN_DIR}/${name}.pid" "${name}-child" 8
  log "stopped ${name}"
}

require_proc
stop_one tunnel
stop_one bridge
mark_disabled

stop_matching_processes cloudflared_process_matches "cloudflared"
stop_matching_processes bridge_process_matches "orphan-bridge"

"${OPS_DIR}/status.sh" || true
