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
  holders="$(ss -tlnp 2>/dev/null | grep -E ":${port}([^0-9]|$)" || true)"
  if [[ -z "${holders}" ]]; then
    return 0
  fi
  log "port ${port} busy without a supervised child — reclaiming this checkout only"
  if [[ -n "${our_child}" ]] && pid_alive "${our_child}" && ! pid_is_ours "${RUN_DIR}/bridge.pid"; then
    log "bridge pidfile pid=${our_child} failed identity check; not signaling it"
  fi
  while read -r pid; do
    [[ -z "${pid}" ]] && continue
    if bridge_process_matches "${pid}"; then
      stop_pid "${pid}" "foreign-bridge" 5
    fi
  done < <(pgrep -f -- "$(regex_escape "${BRIDGE_ENTRY}")" 2>/dev/null || true)
  sleep 0.5
}

if [[ ! -f "${BRIDGE_ENV_FILE}" ]]; then
  log "ERROR: missing ${BRIDGE_ENV_FILE}"
  exit 1
fi
if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
  log "ERROR: node binary not found; set NODE_BIN"
  exit 1
fi

port="$(bridge_port)"

if [[ "${SKIP_TUNNEL:-}" == "1" ]]; then
  log "SKIP_TUNNEL=1; not starting cloudflared"
else
  refuse_tunnel_if_unsafe
  if [[ ! -e "${CLOUDFLARED_BIN}" ]]; then
    log "ERROR: cloudflared not found at ${CLOUDFLARED_BIN}"
    exit 1
  fi
  if [[ ! -f "${CLOUDFLARED_CONFIG}" ]]; then
    log "ERROR: missing cloudflared config ${CLOUDFLARED_CONFIG}"
    exit 1
  fi
fi

reclaim_bridge_port "${port}"
start_one bridge "${NODE_BIN}" "${BRIDGE_ENTRY}"

if [[ "${SKIP_TUNNEL:-}" != "1" ]]; then
  start_one tunnel "${CLOUDFLARED_BIN}" tunnel --config "${CLOUDFLARED_CONFIG}" run "${TUNNEL_NAME}"
fi

attempt=0
while (( attempt < 10 )); do
  if port_listening "${port}"; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 0.5
done

"${OPS_DIR}/status.sh" || true
