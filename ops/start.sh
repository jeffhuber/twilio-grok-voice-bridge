#!/usr/bin/env bash
# Start bridge and, unless SKIP_TUNNEL=1, the cloudflared supervisor.
set -euo pipefail
OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${OPS_DIR}/common.sh"

clear_disabled
save_skip_tunnel

if [[ ! -f "${BRIDGE_DIR}/.env" ]]; then
  log "ERROR: missing ${BRIDGE_DIR}/.env (node loads this file)"
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
start_supervisor bridge "${NODE_BIN}" "${BRIDGE_ENTRY}"
wait_for_port "${port}"

if [[ "${SKIP_TUNNEL:-}" != "1" ]]; then
  wait_for_tunnel_auth "${port}"
  start_supervisor tunnel "${CLOUDFLARED_BIN}" tunnel --config "${CLOUDFLARED_CONFIG}" run "${TUNNEL_NAME}"
fi

"${OPS_DIR}/status.sh" || true
