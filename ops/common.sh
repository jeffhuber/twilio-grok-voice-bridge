#!/usr/bin/env bash
# Shared paths and helpers. Never prints dotenv secret values.
set -euo pipefail

# Directory containing this file, after following symlinks.
# Runs in a subshell so the caller's working directory stays put.
resolve_script_dir() {
  (
    src="$1"
    while [[ -L "${src}" ]]; do
      dir="$(cd "$(dirname "${src}")" && pwd)" || exit 1
      target="$(readlink "${src}")" || exit 1
      if [[ "${target}" != /* ]]; then
        src="${dir}/${target}"
      else
        src="${target}"
      fi
    done
    cd "$(dirname "${src}")" && pwd -P
  )
}

if ! command -v readlink >/dev/null 2>&1; then
  echo "ERROR: readlink is required to resolve ops script paths." >&2
  exit 1
fi

OPS_DIR="$(resolve_script_dir "${BASH_SOURCE[0]}")"
BRIDGE_DIR="$(cd "${OPS_DIR}/.." && pwd -P)"
# Printed by status.sh. Exported so shellcheck sees the cross-file use.
export SERVICE_NAME="twilio-bridge"

BRIDGE_HOME="${BRIDGE_HOME:-${HOME}}"
# Prefer a runtime directory that does not survive reboot, so a recycled PID
# cannot be trusted from a stale pidfile after restart.
if [[ -n "${TWILIO_BRIDGE_RUN_DIR:-}" ]]; then
  RUN_DIR="${TWILIO_BRIDGE_RUN_DIR}"
elif [[ -n "${XDG_RUNTIME_DIR:-}" ]]; then
  RUN_DIR="${XDG_RUNTIME_DIR}/twilio-bridge"
else
  RUN_DIR="/tmp/twilio-bridge-$(id -u)"
fi
LOG_DIR="${TWILIO_BRIDGE_LOG_DIR:-${BRIDGE_HOME}/var/log/twilio-bridge}"
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-${BRIDGE_HOME}/.local/bin/cloudflared}"
CLOUDFLARED_CONFIG="${CLOUDFLARED_CONFIG:-${BRIDGE_HOME}/.cloudflared/config.yml}"
TUNNEL_NAME="${TUNNEL_NAME:-twilio-bridge}"
BRIDGE_ENTRY="${BRIDGE_ENTRY:-src/server.js}"
BRIDGE_ENV_FILE="${BRIDGE_ENV_FILE:-${BRIDGE_DIR}/.env}"
LOG_MAX_BYTES="${TWILIO_BRIDGE_LOG_MAX_BYTES:-5242880}"
PROC_ROOT="${PROC_ROOT:-/proc}"

if [[ -z "${NODE_BIN:-}" ]]; then
  NODE_BIN="$(command -v node || true)"
fi

export PATH="${BRIDGE_HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

umask 077
mkdir -p "${RUN_DIR}" "${LOG_DIR}"
chmod 700 "${RUN_DIR}" "${LOG_DIR}"

ts() { date -u +'%Y-%m-%dT%H:%M:%SZ'; }

rotate_log() {
  local f="$1"
  local size
  [[ -f "${f}" ]] || return 0
  size="$(stat -c%s "${f}" 2>/dev/null || echo 0)"
  if [[ "${size}" =~ ^[0-9]+$ ]] && (( size > LOG_MAX_BYTES )); then
    mv "${f}" "${f}.1"
    if command -v gzip >/dev/null 2>&1; then
      gzip -f "${f}.1" || true
    fi
  fi
}

log() {
  local msg="$*"
  rotate_log "${LOG_DIR}/ops.log"
  printf '[%s] %s\n' "$(ts)" "${msg}" | tee -a "${LOG_DIR}/ops.log" >&2
}

require_proc() {
  if [[ ! -d "${PROC_ROOT}" ]]; then
    log "ERROR: ${PROC_ROOT} is required to verify process identity before signaling. Refusing to continue."
    exit 1
  fi
}

require_cmd() {
  local cmd="$1"
  local hint="$2"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    log "ERROR: ${cmd} is required (${hint}). Refusing to continue."
    exit 1
  fi
}

require_flock() { require_cmd flock "util-linux; without it boot cannot lock"; }
require_ss() { require_cmd ss "iproute2; without it port checks are unreliable"; }

pid_alive() {
  local pid="${1:-}"
  [[ -n "${pid}" && "${pid}" =~ ^[0-9]+$ ]] && kill -0 "${pid}" 2>/dev/null
}

# starttime is field 22 of /proc/PID/stat. Field 2 (comm) is wrapped in parentheses.
proc_starttime() {
  local pid="$1"
  local stat rest
  [[ -r "${PROC_ROOT}/${pid}/stat" ]] || return 1
  stat="$(cat "${PROC_ROOT}/${pid}/stat")"
  rest="${stat##*)}"
  awk '{ print $20 }' <<< "${rest}"
}

read_pidfile() {
  local f="$1"
  if [[ -f "${f}" ]]; then
    tr -d '[:space:]' < "${f}" || true
  fi
}

write_pidfile() {
  local f="$1"
  local pid="$2"
  local start
  require_proc
  start="$(proc_starttime "${pid}")" || {
    log "ERROR: cannot read start time for pid=${pid}"
    exit 1
  }
  printf '%s\n' "${pid}" > "${f}"
  printf '%s\n' "${start}" > "${f}.start"
  chmod 600 "${f}" "${f}.start"
}

clear_pidfile() {
  local f="$1"
  rm -f "${f}" "${f}.start"
}

# Alive AND recorded start time still matches. A recycled PID fails this check.
pid_is_ours() {
  local f="$1"
  local pid start recorded
  require_proc
  pid="$(read_pidfile "${f}")"
  if ! pid_alive "${pid}"; then
    return 1
  fi
  recorded="$(read_pidfile "${f}.start")"
  if [[ -z "${recorded}" ]]; then
    return 1
  fi
  start="$(proc_starttime "${pid}")" || return 1
  [[ "${start}" == "${recorded}" ]]
}

stop_pid() {
  local pid="$1"
  local label="${2:-proc}"
  local grace="${3:-5}"
  local i
  if ! pid_alive "${pid}"; then
    return 0
  fi
  log "stopping ${label} pid=${pid}"
  kill -TERM "${pid}" 2>/dev/null || true
  i=0
  while pid_alive "${pid}" && (( i < grace )); do
    sleep 1
    i=$((i + 1))
  done
  if pid_alive "${pid}"; then
    log "killing ${label} pid=${pid}"
    kill -KILL "${pid}" 2>/dev/null || true
  fi
}

# Signal a recorded pid only when pid and start time still match.
stop_recorded_pid() {
  local pidfile="$1"
  local label="${2:-proc}"
  local grace="${3:-5}"
  local pid
  require_proc
  pid="$(read_pidfile "${pidfile}")"
  if [[ -z "${pid}" ]]; then
    clear_pidfile "${pidfile}"
    return 0
  fi
  if pid_is_ours "${pidfile}"; then
    stop_pid "${pid}" "${label}" "${grace}"
  elif pid_alive "${pid}"; then
    log "stale pidfile ${pidfile} pid=${pid} identity mismatch; not signaling"
  fi
  clear_pidfile "${pidfile}"
}

cmdline_of() {
  local pid="$1"
  tr '\0' ' ' < "${PROC_ROOT}/${pid}/cmdline" 2>/dev/null || true
}

regex_escape() {
  printf '%s' "$1" | sed -e 's/[][(){}.^$*+?|\\]/\\&/g'
}

# Last non-comment KEY=value in a dotenv file. Strips one layer of quotes.
# Does not print the value to the log.
env_file_value() {
  local key="$1"
  local file="$2"
  local line val
  val=""
  [[ -f "${file}" ]] || return 0
  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ "${line}" =~ ^[[:space:]]*# ]] && continue
    if [[ "${line}" =~ ^[[:space:]]*${key}[[:space:]]*=(.*)$ ]]; then
      val="${BASH_REMATCH[1]}"
      val="${val#"${val%%[![:space:]]*}"}"
      val="${val%"${val##*[![:space:]]}"}"
      if [[ "${val}" == \"*\" ]]; then
        val="${val#\"}"
        val="${val%\"}"
      elif [[ "${val}" == \'*\' ]]; then
        val="${val#\'}"
        val="${val%\'}"
      fi
    fi
  done < "${file}"
  printf '%s' "${val}"
}

bridge_port() {
  local from_env
  from_env="$(env_file_value PORT "${BRIDGE_ENV_FILE}")"
  if [[ -n "${from_env}" ]]; then
    printf '%s' "${from_env}"
  else
    printf '%s' "${PORT:-3000}"
  fi
}

port_listening() {
  local port="$1"
  require_ss
  if [[ ! "${port}" =~ ^[0-9]+$ ]]; then
    log "ERROR: PORT must be numeric (got a non-numeric value)"
    exit 1
  fi
  ss -tln 2>/dev/null | grep -E -q ":${port}([^0-9]|$)"
}

# Exit 1 when a public tunnel would expose operator routes.
refuse_tunnel_if_unsafe() {
  local key allow
  key="$(env_file_value BRIDGE_API_KEY "${BRIDGE_ENV_FILE}")"
  allow="$(env_file_value ALLOW_UNAUTHENTICATED_OPERATOR "${BRIDGE_ENV_FILE}")"
  if [[ -z "${key}" ]]; then
    log "ERROR: refusing to start cloudflared because BRIDGE_API_KEY is empty. A tunnel would expose operator routes."
    exit 1
  fi
  if [[ "${allow}" == "1" ]]; then
    log "ERROR: refusing to start cloudflared because ALLOW_UNAUTHENTICATED_OPERATOR=1. A tunnel would expose operator routes."
    exit 1
  fi
}

bridge_process_matches() {
  local pid="$1"
  local cwd cmd
  require_proc
  [[ -r "${PROC_ROOT}/${pid}/cmdline" ]] || return 1
  cmd="$(cmdline_of "${pid}")"
  [[ "${cmd}" == *"${BRIDGE_ENTRY}"* ]] || return 1
  cwd="$(readlink -f "${PROC_ROOT}/${pid}/cwd" 2>/dev/null || true)"
  [[ "${cwd}" == "${BRIDGE_DIR}" ]]
}
