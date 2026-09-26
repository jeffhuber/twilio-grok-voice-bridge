#!/usr/bin/env bash
# Show supervisor and child status. Exit 0 only when required processes match pidfiles.
set -euo pipefail
OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${OPS_DIR}/common.sh"

status_one() {
  local name="$1"
  local sup child s c
  sup="$(read_pidfile "${RUN_DIR}/${name}.supervisor.pid")"
  child="$(read_pidfile "${RUN_DIR}/${name}.pid")"
  s="down"
  c="down"
  if pid_is_ours "${RUN_DIR}/${name}.supervisor.pid"; then
    s="up pid=${sup}"
  elif [[ -n "${sup}" ]]; then
    s="stale pid=${sup}"
  fi
  if pid_is_ours "${RUN_DIR}/${name}.pid"; then
    c="up pid=${child}"
  elif [[ -n "${child}" ]]; then
    c="stale pid=${child}"
  fi
  printf '%-8s supervisor=%-24s child=%s\n' "${name}" "${s}" "${c}"
}

port="$(bridge_port)"
echo "=== ${SERVICE_NAME} status ==="
echo "BRIDGE_DIR=${BRIDGE_DIR}"
echo "RUN_DIR=${RUN_DIR}"
echo "LOG_DIR=${LOG_DIR}"
echo "PORT=${port}"
status_one bridge
if [[ "${SKIP_TUNNEL:-}" == "1" ]]; then
  echo "tunnel   skipped (SKIP_TUNNEL=1)"
else
  status_one tunnel
fi

if port_listening "${port}"; then
  echo "local :${port} = LISTEN"
else
  echo "local :${port} = not listening"
fi

bridge_ok=0
tunnel_ok=0
if pid_is_ours "${RUN_DIR}/bridge.supervisor.pid" && pid_is_ours "${RUN_DIR}/bridge.pid"; then
  bridge_ok=1
fi
if [[ "${SKIP_TUNNEL:-}" == "1" ]]; then
  tunnel_ok=1
elif pid_is_ours "${RUN_DIR}/tunnel.supervisor.pid" && pid_is_ours "${RUN_DIR}/tunnel.pid"; then
  tunnel_ok=1
fi
if [[ "${bridge_ok}" -eq 1 && "${tunnel_ok}" -eq 1 ]]; then
  echo "overall = UP"
  exit 0
fi
echo "overall = DEGRADED"
exit 1
