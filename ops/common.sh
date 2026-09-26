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
# One path for cron and login. XDG_RUNTIME_DIR is often set in a login session
# and unset in cron, which would split pidfiles across two directories.
if [[ -n "${TWILIO_BRIDGE_RUN_DIR:-}" ]]; then
  RUN_DIR="${TWILIO_BRIDGE_RUN_DIR}"
else
  RUN_DIR="/tmp/twilio-bridge-$(id -u)"
fi
LOG_DIR="${TWILIO_BRIDGE_LOG_DIR:-${BRIDGE_HOME}/var/log/twilio-bridge}"
# Survives reboot. The run directory is often /tmp and is wiped on restart.
STATE_DIR="${BRIDGE_HOME}/var/lib/twilio-bridge"
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-${BRIDGE_HOME}/.local/bin/cloudflared}"
CLOUDFLARED_CONFIG="${CLOUDFLARED_CONFIG:-${BRIDGE_HOME}/.cloudflared/config.yml}"
TUNNEL_NAME="${TUNNEL_NAME:-twilio-bridge}"
BRIDGE_ENTRY="${BRIDGE_ENTRY:-src/server.js}"
BRIDGE_ENV_FILE="${BRIDGE_ENV_FILE:-${BRIDGE_DIR}/.env}"
LOG_MAX_BYTES="${TWILIO_BRIDGE_LOG_MAX_BYTES:-5242880}"
PROC_ROOT="${PROC_ROOT:-/proc}"

# Node always loads ${BRIDGE_DIR}/.env (dotenv, cwd is the checkout). A different
# BRIDGE_ENV_FILE would make the port probe disagree with the process.
require_bridge_env_file() {
  local expected actual
  expected="$(readlink -f "${BRIDGE_DIR}/.env" 2>/dev/null || true)"
  actual="$(readlink -f "${BRIDGE_ENV_FILE}" 2>/dev/null || true)"
  if [[ -z "${expected}" || -z "${actual}" || "${actual}" != "${expected}" ]]; then
    log "ERROR: BRIDGE_ENV_FILE must be ${BRIDGE_DIR}/.env because node loads that file. Refusing."
    exit 1
  fi
}

require_bridge_env_file

if [[ -z "${NODE_BIN:-}" ]]; then
  NODE_BIN="$(command -v node || true)"
fi

export PATH="${BRIDGE_HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

umask 077
mkdir -p "${RUN_DIR}" "${LOG_DIR}" "${STATE_DIR}"
chmod 700 "${RUN_DIR}" "${LOG_DIR}" "${STATE_DIR}"

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
require_curl() { require_cmd curl "needed to read /health before opening a tunnel"; }

# Boot id plus starttime. A recycled pid after reboot fails even if starttime collides.
proc_boot_id() {
  local boot_file="${PROC_ROOT}/sys/kernel/random/boot_id"
  local stat_file="${PROC_ROOT}/stat"
  if [[ -r "${boot_file}" ]]; then
    tr -d '[:space:]' < "${boot_file}"
    return 0
  fi
  if [[ -r "${stat_file}" ]]; then
    awk '/^btime / { print $2; found=1 } END { exit !found }' "${stat_file}"
    return
  fi
  return 1
}

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
  local start boot
  require_proc
  start="$(proc_starttime "${pid}")" || {
    log "ERROR: cannot read start time for pid=${pid}"
    exit 1
  }
  boot="$(proc_boot_id)" || {
    log "ERROR: cannot read boot id under ${PROC_ROOT}"
    exit 1
  }
  printf '%s\n' "${pid}" > "${f}"
  printf '%s %s\n' "${start}" "${boot}" > "${f}.start"
  chmod 600 "${f}" "${f}.start"
}

clear_pidfile() {
  local f="$1"
  rm -f "${f}" "${f}.start"
}

# Alive, and both start time and boot id still match the pidfile record.
pid_is_ours() {
  local f="$1"
  local pid start boot recorded recorded_start recorded_boot
  require_proc
  pid="$(read_pidfile "${f}")"
  if ! pid_alive "${pid}"; then
    return 1
  fi
  [[ -f "${f}.start" ]] || return 1
  recorded="$(tr -d '\r' < "${f}.start")"
  recorded="${recorded#"${recorded%%[![:space:]]*}"}"
  recorded="${recorded%"${recorded##*[![:space:]]}"}"
  # A single token is not a starttime-plus-boot-id record.
  if [[ "${recorded}" != *" "* ]]; then
    return 1
  fi
  recorded_start="${recorded%% *}"
  recorded_boot="${recorded#* }"
  if [[ -z "${recorded_start}" || -z "${recorded_boot}" ]]; then
    return 1
  fi
  start="$(proc_starttime "${pid}")" || return 1
  boot="$(proc_boot_id)" || return 1
  [[ "${start}" == "${recorded_start}" && "${boot}" == "${recorded_boot}" ]]
}

stop_pid() {
  local pid="$1"
  local label="${2:-proc}"
  local grace="${3:-5}"
  local i start="" boot="" now_start="" now_boot=""
  if ! pid_alive "${pid}"; then
    return 0
  fi
  require_proc
  start="$(proc_starttime "${pid}" || true)"
  boot="$(proc_boot_id || true)"
  if [[ -z "${start}" || -z "${boot}" ]]; then
    log "not signaling ${label} pid=${pid}; identity unreadable"
    return 0
  fi
  log "stopping ${label} pid=${pid}"
  kill -TERM "${pid}" 2>/dev/null || true
  i=0
  while pid_alive "${pid}" && (( i < grace )); do
    sleep 1
    i=$((i + 1))
  done
  if ! pid_alive "${pid}"; then
    return 0
  fi
  now_start="$(proc_starttime "${pid}" || true)"
  now_boot="$(proc_boot_id || true)"
  if [[ -z "${now_start}" || -z "${now_boot}" || "${now_start}" != "${start}" || "${now_boot}" != "${boot}" ]]; then
    log "not killing ${label} pid=${pid}; pid identity changed"
    return 0
  fi
  log "killing ${label} pid=${pid}"
  kill -KILL "${pid}" 2>/dev/null || true
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

# argv array in CMDLINE_ARGS, split on NUL. Does not join arguments with spaces.
read_cmdline() {
  local pid="$1"
  local part file="${PROC_ROOT}/${pid}/cmdline"
  CMDLINE_ARGS=()
  [[ -r "${file}" ]] || return 1
  while IFS= read -r -d '' part || [[ -n "${part}" ]]; do
    CMDLINE_ARGS+=("${part}")
  done < "${file}"
  [[ ${#CMDLINE_ARGS[@]} -gt 0 ]]
}

# PORT the way src/server.js computes it: ${BRIDGE_DIR}/.env overrides the environment,
# then Number(value || 3000). Environment values are strings, so "0" stays 0 and is
# rejected below (empty PORT still falls back to 3000). Inline comments are dotenv's.
# BRIDGE_ENV_FILE must resolve to that same path; node does not load a different file.
bridge_port() {
  local file="${BRIDGE_DIR}/.env"
  local port
  require_bridge_env_file
  if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
    log "ERROR: node binary not found; set NODE_BIN"
    exit 1
  fi
  if [[ ! -f "${BRIDGE_DIR}/node_modules/dotenv/package.json" ]]; then
    log "ERROR: dotenv is not installed under ${BRIDGE_DIR}/node_modules"
    exit 1
  fi
  port="$("${NODE_BIN}" -e '
    const fs = require("fs");
    const dotenv = require(process.argv[1]);
    const file = process.argv[2];
    let value = process.env.PORT;
    if (fs.existsSync(file)) {
      const parsed = dotenv.parse(fs.readFileSync(file));
      if (Object.prototype.hasOwnProperty.call(parsed, "PORT")) value = parsed.PORT;
    }
    const port = Number(value || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) process.exit(2);
    process.stdout.write(String(port));
  ' "${BRIDGE_DIR}/node_modules/dotenv" "${file}")" || {
    log "ERROR: PORT is missing or not a usable TCP port"
    exit 1
  }
  printf '%s' "${port}"
}

port_listening() {
  local port="$1"
  local listeners
  require_ss
  if [[ ! "${port}" =~ ^[0-9]+$ ]]; then
    log "ERROR: PORT must be numeric (got a non-numeric value)"
    exit 1
  fi
  listeners="$(ss -tlnH "sport = :${port}" 2>/dev/null || true)"
  [[ -n "${listeners}" ]]
}

# True only when the running bridge says operator routes require a key.
# .env text is not consulted: inline comments and export lines do not match a hand parser,
# and BRIDGE_ENV_FILE may not be the file node loaded.
bridge_accepts_tunnel() {
  local port="$1"
  local body
  require_curl
  body="$(curl -sf --max-time 2 "http://127.0.0.1:${port}/health" || true)"
  [[ -n "${body}" ]] || return 1
  if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
    log "ERROR: node binary not found; set NODE_BIN"
    return 1
  fi
  printf '%s' "${body}" | "${NODE_BIN}" -e '
    let raw = "";
    process.stdin.on("data", (chunk) => { raw += chunk; });
    process.stdin.on("end", () => {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.authRequired === true) process.exit(0);
      } catch (err) {
        process.exit(1);
      }
      process.exit(1);
    });
  '
}

wait_for_port() {
  local port="$1"
  local tries="${2:-20}"
  local attempt=0
  while (( attempt < tries )); do
    if port_listening "${port}"; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 0.5
  done
  log "ERROR: port ${port} did not open"
  return 1
}

wait_for_tunnel_auth() {
  local port="$1"
  local tries="${2:-20}"
  local attempt=0
  while (( attempt < tries )); do
    if bridge_accepts_tunnel "${port}"; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 0.5
  done
  log "ERROR: refusing cloudflared because http://127.0.0.1:${port}/health did not report authRequired true"
  return 1
}

disabled_marker() { printf '%s/disabled' "${STATE_DIR}"; }
skip_tunnel_marker() { printf '%s/skip-tunnel' "${RUN_DIR}"; }

mark_disabled() {
  mkdir -p "${STATE_DIR}"
  chmod 700 "${STATE_DIR}"
  printf '1\n' > "$(disabled_marker)"
  chmod 600 "$(disabled_marker)"
}

clear_disabled() { rm -f "$(disabled_marker)"; }

is_disabled() { [[ -f "$(disabled_marker)" ]]; }

save_skip_tunnel() {
  if [[ "${SKIP_TUNNEL:-}" == "1" ]]; then
    printf '1\n' > "$(skip_tunnel_marker)"
    chmod 600 "$(skip_tunnel_marker)"
  else
    rm -f "$(skip_tunnel_marker)"
  fi
}

# Honor the choice saved by start.sh when this process was not given SKIP_TUNNEL.
load_skip_tunnel() {
  if [[ -n "${SKIP_TUNNEL+x}" ]]; then
    return 0
  fi
  if [[ -f "$(skip_tunnel_marker)" ]]; then
    SKIP_TUNNEL=1
  fi
}

path_base() {
  local path="$1"
  if [[ -z "${path}" ]]; then
    printf ''
    return 0
  fi
  basename -- "${path}"
}

# argv0 or /proc/PID/exe must be NODE_BIN or a program named node.
is_node_argv() {
  local argv0="$1"
  local exe="$2"
  local node_real="" argv_base exe_base
  argv_base="$(path_base "${argv0}")"
  exe_base="$(path_base "${exe}")"
  if [[ -n "${NODE_BIN}" ]]; then
    node_real="$(readlink -f "${NODE_BIN}" 2>/dev/null || printf '%s' "${NODE_BIN}")"
    if [[ "${argv0}" == "${NODE_BIN}" || "${argv0}" == "${node_real}" || "${exe}" == "${NODE_BIN}" || "${exe}" == "${node_real}" ]]; then
      return 0
    fi
  fi
  [[ "${argv_base}" == "node" || "${exe_base}" == "node" ]]
}

bridge_process_matches() {
  local pid="$1"
  local exe cwd arg
  require_proc
  read_cmdline "${pid}" || return 1
  exe="$(readlink -f "${PROC_ROOT}/${pid}/exe" 2>/dev/null || true)"
  is_node_argv "${CMDLINE_ARGS[0]}" "${exe}" || return 1
  local found=0
  for arg in "${CMDLINE_ARGS[@]:1}"; do
    if [[ "${arg}" == "${BRIDGE_ENTRY}" ]]; then
      found=1
      break
    fi
  done
  [[ "${found}" -eq 1 ]] || return 1
  cwd="$(readlink -f "${PROC_ROOT}/${pid}/cwd" 2>/dev/null || true)"
  [[ "${cwd}" == "${BRIDGE_DIR}" ]]
}

cloudflared_process_matches() {
  local pid="$1"
  local exe i
  require_proc
  read_cmdline "${pid}" || return 1
  exe="$(readlink -f "${PROC_ROOT}/${pid}/exe" 2>/dev/null || true)"
  local argv0="${CMDLINE_ARGS[0]}"
  local argv_base exe_base
  argv_base="$(path_base "${argv0}")"
  exe_base="$(path_base "${exe}")"
  if [[ "${argv0}" != "${CLOUDFLARED_BIN}" && "${exe}" != "${CLOUDFLARED_BIN}" && "${argv_base}" != "cloudflared" && "${exe_base}" != "cloudflared" ]]; then
    return 1
  fi
  local has_tunnel=0 has_config=0 has_run=0 has_name=0
  for ((i = 1; i < ${#CMDLINE_ARGS[@]}; i++)); do
    if [[ "${CMDLINE_ARGS[$i]}" == "tunnel" ]]; then
      has_tunnel=1
    fi
    if [[ "${CMDLINE_ARGS[$i]}" == "--config" && "${CMDLINE_ARGS[$((i + 1))]:-}" == "${CLOUDFLARED_CONFIG}" ]]; then
      has_config=1
    fi
    if [[ "${CMDLINE_ARGS[$i]}" == "run" ]]; then
      has_run=1
    fi
    if [[ "${CMDLINE_ARGS[$i]}" == "${TUNNEL_NAME}" ]]; then
      has_name=1
    fi
  done
  [[ "${has_tunnel}" -eq 1 && "${has_config}" -eq 1 && "${has_run}" -eq 1 && "${has_name}" -eq 1 ]]
}

stop_matching_processes() {
  local predicate="$1"
  local label="$2"
  local pid
  require_proc
  for pid in "${PROC_ROOT}"/[0-9]*; do
    [[ -d "${pid}" ]] || continue
    pid="$(basename -- "${pid}")"
    if "${predicate}" "${pid}"; then
      stop_pid "${pid}" "${label}" 5
    fi
  done
}

# Listener pids for a TCP port, from ss. Empty when ss cannot see a pid.
port_listener_pids() {
  local port="$1"
  require_ss
  ss -tlnpH "sport = :${port}" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true
}

# Stop a matching bridge only when that process is the listener. A checkout
# match that does not hold the port is left alone.
reclaim_bridge_port() {
  local port="$1"
  local our_child holders pid signaled=0
  our_child="$(read_pidfile "${RUN_DIR}/bridge.pid")"
  if pid_is_ours "${RUN_DIR}/bridge.pid"; then
    return 0
  fi
  require_ss
  if [[ ! "${port}" =~ ^[0-9]+$ ]]; then
    log "ERROR: PORT must be numeric (got a non-numeric value)"
    exit 1
  fi
  holders="$(ss -tlnH "sport = :${port}" 2>/dev/null || true)"
  if [[ -z "${holders}" ]]; then
    return 0
  fi
  log "port ${port} busy without a supervised child — reclaiming the listener from this checkout only"
  if [[ -n "${our_child}" ]] && pid_alive "${our_child}" && ! pid_is_ours "${RUN_DIR}/bridge.pid"; then
    log "bridge pidfile pid=${our_child} failed identity check; not signaling it"
  fi
  while IFS= read -r pid; do
    [[ -n "${pid}" ]] || continue
    if bridge_process_matches "${pid}"; then
      stop_pid "${pid}" "foreign-bridge" 5
      signaled=1
    else
      log "port ${port} listener pid=${pid} is not this checkout; not signaling"
    fi
  done < <(port_listener_pids "${port}")
  if [[ "${signaled}" -eq 0 ]]; then
    log "port ${port} is busy; no listener pid matched this checkout, so nothing was signaled"
  fi
}

tunnel_stack_live() {
  if pid_is_ours "${RUN_DIR}/tunnel.supervisor.pid"; then
    return 0
  fi
  pid_is_ours "${RUN_DIR}/tunnel.pid"
}

stop_tunnel_stack() {
  stop_recorded_pid "${RUN_DIR}/tunnel.supervisor.pid" "tunnel-supervisor" 2
  stop_recorded_pid "${RUN_DIR}/tunnel.pid" "tunnel-child" 2
  stop_matching_processes cloudflared_process_matches "cloudflared"
}

# Spawn a supervisor without inheriting the start.sh (fd 8) or boot.sh (fd 9) locks.
start_supervisor() {
  local name="$1"
  shift
  local sup_pidfile="${RUN_DIR}/${name}.supervisor.pid"
  local attempt=0
  if pid_is_ours "${sup_pidfile}"; then
    log "${name} supervisor already running pid=$(read_pidfile "${sup_pidfile}")"
    return 0
  fi
  clear_pidfile "${sup_pidfile}"
  if [[ ! -x "${OPS_DIR}/supervise.sh" ]]; then
    chmod +x "${OPS_DIR}/supervise.sh"
  fi
  nohup "${OPS_DIR}/supervise.sh" "${name}" -- "$@" 8>&- 9>&- </dev/null >/dev/null 2>>"${LOG_DIR}/${name}.supervisor.log" &
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
