#!/usr/bin/env bash
# Forever-loop supervisor for one named child. Restarts on crash with backoff.
# Usage: supervise.sh <name> -- <command...>
set -euo pipefail
OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${OPS_DIR}/common.sh"

if [[ $# -lt 3 || "$2" != "--" ]]; then
  echo "usage: $0 <name> -- <command...>" >&2
  exit 64
fi

NAME="$1"
shift 2
CMD=("$@")

SUP_PIDFILE="${RUN_DIR}/${NAME}.supervisor.pid"
CHILD_PIDFILE="${RUN_DIR}/${NAME}.pid"
SUP_LOG="${LOG_DIR}/${NAME}.supervisor.log"
CHILD_LOG="${LOG_DIR}/${NAME}.log"

write_pidfile "${SUP_PIDFILE}" "$$"
log "supervisor start name=${NAME} pid=$$"
printf '[%s] supervisor start name=%s pid=%s\n' "$(ts)" "${NAME}" "$$" >> "${SUP_LOG}"

backoff=1
max_backoff=60
healthy_s=30

cleanup() {
  stop_recorded_pid "${CHILD_PIDFILE}" "${NAME}-child" 8
  clear_pidfile "${SUP_PIDFILE}"
  printf '[%s] supervisor exit name=%s\n' "$(ts)" "${NAME}" >> "${SUP_LOG}"
  exit 0
}
trap cleanup TERM INT HUP

# External sleep ignores traps until it exits. Sleep in the background and wait
# so TERM runs the trap during backoff.
interruptible_sleep() {
  local seconds="$1"
  local sleeper
  sleep "${seconds}" &
  sleeper=$!
  set +e
  wait "${sleeper}"
  set -e
}

while true; do
  rotate_log "${CHILD_LOG}"
  rotate_log "${SUP_LOG}"
  if [[ "${NAME}" == "tunnel" ]]; then
    port="$(bridge_port)"
    if ! bridge_accepts_tunnel "${port}"; then
      log "not restarting cloudflared; http://127.0.0.1:${port}/health authRequired is not true"
      printf '[%s] tunnel restart withheld; authRequired is not true\n' "$(ts)" >> "${SUP_LOG}"
      interruptible_sleep "${backoff}"
      if (( backoff < max_backoff )); then
        backoff=$(( backoff * 2 ))
        if (( backoff > max_backoff )); then
          backoff=${max_backoff}
        fi
      fi
      continue
    fi
  fi

  # A live tunnel pidfile, not the SKIP_TUNNEL value from process start, decides
  # this. Stop cloudflared before the bridge child is exec'd, and bring it back
  # only after /health reports authRequired true.
  tunnel_held=0
  if [[ "${NAME}" == "bridge" ]] && tunnel_stack_live; then
    log "stopping cloudflared before bridge relaunch"
    stop_tunnel_stack
    tunnel_held=1
  fi

  printf '[%s] launching child\n' "$(ts)" >> "${SUP_LOG}"
  log "launching ${NAME} child"
  started_at=$(date +%s)
  set +e
  (
    if [[ "${NAME}" == "bridge" ]]; then
      cd "${BRIDGE_DIR}"
    fi
    exec 8>&- 9>&- "${CMD[@]}"
  ) >> "${CHILD_LOG}" 2>&1 &
  child_pid=$!
  set -e
  write_pidfile "${CHILD_PIDFILE}" "${child_pid}"
  printf '[%s] child pid=%s\n' "$(ts)" "${child_pid}" >> "${SUP_LOG}"

  if [[ "${NAME}" == "bridge" && "${tunnel_held}" == "1" ]]; then
    port="$(bridge_port)"
    if wait_for_tunnel_auth "${port}" 10; then
      log "restarting cloudflared after authRequired true"
      if ! start_supervisor tunnel "${CLOUDFLARED_BIN}" tunnel --config "${CLOUDFLARED_CONFIG}" run "${TUNNEL_NAME}"; then
        log "ERROR: cloudflared did not restart after the health check"
      fi
    else
      log "leaving cloudflared stopped because http://127.0.0.1:${port}/health authRequired is not true; it stays down until start.sh or boot.sh"
    fi
  fi

  set +e
  wait "${child_pid}"
  rc=$?
  set -e
  clear_pidfile "${CHILD_PIDFILE}"
  lived=$(( $(date +%s) - started_at ))
  if (( lived >= healthy_s )); then
    backoff=1
  fi
  printf '[%s] child exited rc=%s lived=%ss; restart in %ss\n' "$(ts)" "${rc}" "${lived}" "${backoff}" >> "${SUP_LOG}"
  log "child ${NAME} exited rc=${rc} lived=${lived}s; restart in ${backoff}s"
  interruptible_sleep "${backoff}"
  if (( backoff < max_backoff )); then
    backoff=$(( backoff * 2 ))
    if (( backoff > max_backoff )); then
      backoff=${max_backoff}
    fi
  fi
done
