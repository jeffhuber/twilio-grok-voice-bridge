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

if [[ "${SKIP_TUNNEL:-}" != "1" ]]; then
  pattern="$(regex_escape "cloudflared tunnel --config ${CLOUDFLARED_CONFIG} run ${TUNNEL_NAME}")"
  pkill -f -- "${pattern}" 2>/dev/null || true
fi

while read -r pid; do
  [[ -z "${pid}" ]] && continue
  if bridge_process_matches "${pid}"; then
    stop_pid "${pid}" "orphan-bridge" 5
  fi
done < <(pgrep -f -- "$(regex_escape "${BRIDGE_ENTRY}")" 2>/dev/null || true)

"${OPS_DIR}/status.sh" || true
