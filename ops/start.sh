#!/usr/bin/env bash
# Start bridge and, unless SKIP_TUNNEL=1, the cloudflared supervisor.
set -euo pipefail
OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${OPS_DIR}/common.sh"

start_one() {
  local name="$1"
  shift
  local sup_pidfile="${RUN_DIR}/${name}.supervisor.pid"
  if pid_is_ours "${sup_pidfile}"; then
    log "${name} supervisor already running pid=$(read_pidfile "${sup_pidfile}")"
    return 0
  fi
  clear_pidfile "${sup_pidfile}"
  if [[ ! -x "${OPS_DIR}/supervise.sh" ]]; then
    chmod +x "${OPS_DIR}/supervise.sh"
  fi
  nohup "${OPS_DIR}/supervise.sh" "${name}" -- "$@" </dev/null >/dev/null 2>>"${LOG_DIR}/${name}.supervisor.log" &
  local attempt=0
  while (( attempt < 10 )); do
    if [[ -f "${sup_pidfile}.start" ]] && pid_is_ours "${sup_pidfile}"; then
      log "started ${name} supervisor pid=$(read_pidfile "${sup_pidfile}")"
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 0.5
  done
  log "ERROR: failed to start ${name} supervisor"
  return 1
}

reclaim_bridge_port() {
  local port="$1"
  local our_child holders pid
  our_child="$(read_pidfile "${RUN_DIR}/bridge.pid")"
  if pid_is_ours "${RUN_DIR}/bridge.pid"; then
    return 0
  fi
  require_ss
  holders="$(ss -tlnH "sport = :${port}" 2>/dev/null || true)"
  if [[ -z "${holders}" ]]; then
    return 0
  fi
  log "port ${port} busy without a supervised child — reclaiming this checkout only"
  if [[ -n "${our_child}" ]] && pid_alive "${our_child}" && ! pid_is_ours "${RUN_DIR}/bridge.pid"; then
    log "bridge pidfile pid=${our_child} failed identity check; not signaling it"
  fi
  stop_matching_processes bridge_process_matches "foreign-bridge"
  sleep 0.5
}

clear_disabled
save_skip_tunnel

if [[ ! -f "${BRIDGE_DIR}/.env" && ! -f "${BRIDGE_ENV_FILE}" ]]; then
  log "ERROR: missing ${BRIDGE_DIR}/.env (node loads this file; BRIDGE_ENV_FILE is only the port probe)"
  exit 1
fi
if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
  log "ERROR: node binary not found; set NODE_BIN"
  exit 1
fi

require_flock
exec 8>"${RUN_DIR}/start.lock"
if ! flock -w 30 8; then
  log "ERROR: timed out waiting for the start lock"
  exit 1
fi

port="$(bridge_port)"

if [[ "${SKIP_TUNNEL:-}" == "1" ]]; then
  log "SKIP_TUNNEL=1; not starting cloudflared"
elif [[ ! -e "${CLOUDFLARED_BIN}" ]]; then
  log "ERROR: cloudflared not found at ${CLOUDFLARED_BIN}"
  exit 1
elif [[ ! -f "${CLOUDFLARED_CONFIG}" ]]; then
  log "ERROR: missing cloudflared config ${CLOUDFLARED_CONFIG}"
  exit 1
fi

reclaim_bridge_port "${port}"
start_one bridge "${NODE_BIN}" "${BRIDGE_ENTRY}"
wait_for_port "${port}"

if [[ "${SKIP_TUNNEL:-}" != "1" ]]; then
  wait_for_tunnel_auth "${port}"
  start_one tunnel "${CLOUDFLARED_BIN}" tunnel --config "${CLOUDFLARED_CONFIG}" run "${TUNNEL_NAME}"
fi

"${OPS_DIR}/status.sh" || true
