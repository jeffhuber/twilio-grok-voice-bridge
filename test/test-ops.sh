#!/usr/bin/env bash
# Ops script checks: symlink resolution, pid identity, tunnel health gate.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="$(mktemp -d)"
sleep_pid=""
health_pid=""
sup_pid=""
tail_parent=""
tail_child=""
tunnel_sleeper=""
tunnel_sup_sleeper=""
lock_sup=""
tunnel_restart_sup=""
created_env=0

cleanup() {
  if [[ -n "${sup_pid}" ]]; then
    kill -TERM "${sup_pid}" 2>/dev/null || true
    wait "${sup_pid}" 2>/dev/null || true
  fi
  if [[ -n "${health_pid}" ]]; then
    kill "${health_pid}" 2>/dev/null || true
    wait "${health_pid}" 2>/dev/null || true
  fi
  if [[ -n "${sleep_pid}" ]]; then
    kill "${sleep_pid}" 2>/dev/null || true
    wait "${sleep_pid}" 2>/dev/null || true
  fi
  if [[ -n "${tail_child}" ]]; then
    kill "${tail_child}" 2>/dev/null || true
  fi
  if [[ -n "${tail_parent}" ]]; then
    kill "${tail_parent}" 2>/dev/null || true
    wait "${tail_parent}" 2>/dev/null || true
  fi
  if [[ -n "${tunnel_sleeper}" ]]; then
    kill "${tunnel_sleeper}" 2>/dev/null || true
    wait "${tunnel_sleeper}" 2>/dev/null || true
  fi
  if [[ -n "${tunnel_sup_sleeper}" ]]; then
    kill "${tunnel_sup_sleeper}" 2>/dev/null || true
    wait "${tunnel_sup_sleeper}" 2>/dev/null || true
  fi
  if [[ -n "${lock_sup}" ]]; then
    kill -TERM "${lock_sup}" 2>/dev/null || true
    wait "${lock_sup}" 2>/dev/null || true
  fi
  if [[ -n "${tunnel_restart_sup}" ]]; then
    kill -TERM "${tunnel_restart_sup}" 2>/dev/null || true
    wait "${tunnel_restart_sup}" 2>/dev/null || true
  fi
  if [[ -n "${RUN_DIR:-}" && -f "${RUN_DIR}/tunnel.supervisor.pid" ]]; then
    extra_pid="$(tr -d '[:space:]' < "${RUN_DIR}/tunnel.supervisor.pid" || true)"
    if [[ -n "${extra_pid}" ]]; then
      kill -TERM "${extra_pid}" 2>/dev/null || true
      wait "${extra_pid}" 2>/dev/null || true
    fi
  fi
  if [[ -n "${RUN_DIR:-}" && -f "${RUN_DIR}/bridge.supervisor.pid" ]]; then
    extra_pid="$(tr -d '[:space:]' < "${RUN_DIR}/bridge.supervisor.pid" || true)"
    if [[ -n "${extra_pid}" ]]; then
      kill -TERM "${extra_pid}" 2>/dev/null || true
      wait "${extra_pid}" 2>/dev/null || true
    fi
  fi
  if [[ "${created_env}" == "1" ]]; then
    rm -f "${ROOT}/.env"
  fi
  rm -rf "${TMP}"
}
trap cleanup EXIT

export TWILIO_BRIDGE_RUN_DIR="${TMP}/run"
export TWILIO_BRIDGE_LOG_DIR="${TMP}/log"
export BRIDGE_HOME="${TMP}/home"
unset BRIDGE_ENV_FILE
mkdir -p "${BRIDGE_HOME}" "${TMP}/linkdir" "${TMP}/log"
if [[ ! -f "${ROOT}/.env" ]]; then
  printf 'PORT=9\n' > "${ROOT}/.env"
  created_env=1
fi

fail() {
  echo "FAIL $*"
  exit 1
}

ln -s "${ROOT}/ops/common.sh" "${TMP}/linkdir/common.sh"

bridge_dir="$(
  TWILIO_BRIDGE_RUN_DIR="${TMP}/run" \
  TWILIO_BRIDGE_LOG_DIR="${TMP}/log" \
  BRIDGE_HOME="${TMP}/home" \
  bash -c 'source "$1"; printf "%s" "${BRIDGE_DIR}"' bash "${TMP}/linkdir/common.sh"
)"
if [[ "${bridge_dir}" != "${ROOT}" ]]; then
  fail "symlink resolution: BRIDGE_DIR=${bridge_dir} expected ${ROOT}"
fi
echo "ok symlink resolution"

xdg_ignored_dir="$(
  TWILIO_BRIDGE_RUN_DIR="" \
  XDG_RUNTIME_DIR="${TMP}/xdg-not-used" \
  BRIDGE_HOME="${TMP}/home" \
  TWILIO_BRIDGE_LOG_DIR="${TMP}/log" \
  bash -c 'source "$1"; printf "%s" "${RUN_DIR}"' bash "${ROOT}/ops/common.sh"
)"
if [[ "${xdg_ignored_dir}" != "/tmp/twilio-bridge-$(id -u)" ]]; then
  fail "RUN_DIR followed XDG_RUNTIME_DIR or TWILIO_BRIDGE_RUN_DIR: ${xdg_ignored_dir}"
fi
echo "ok run dir ignores XDG_RUNTIME_DIR"

BRIDGE_DIR=""
# shellcheck disable=SC1091
source "${TMP}/linkdir/common.sh"
if [[ "${BRIDGE_DIR}" != "${ROOT}" ]]; then
  fail "sourced symlink BRIDGE_DIR=${BRIDGE_DIR}"
fi

if declare -F refuse_tunnel_if_unsafe >/dev/null 2>&1; then
  fail "refuse_tunnel_if_unsafe is still defined"
fi
if grep -R -n 'pkill' --include='*.sh' "${ROOT}/ops" >/dev/null; then
  fail "ops scripts still call pkill"
fi

sleep 120 &
sleep_pid=$!
write_pidfile "${RUN_DIR}/sample.pid" "${sleep_pid}"
if ! pid_is_ours "${RUN_DIR}/sample.pid"; then
  fail "expected matching start time and boot id to count as our process"
fi
start_line="$(tr -d '\r' < "${RUN_DIR}/sample.pid.start")"
if [[ "${start_line}" != *" "* ]]; then
  fail "start record did not include a boot id: ${start_line}"
fi
recorded_start="${start_line%% *}"
printf '%s %s\n' "${recorded_start}" "not-this-boot" > "${RUN_DIR}/sample.pid.start"
if pid_is_ours "${RUN_DIR}/sample.pid"; then
  fail "mismatched boot id was trusted"
fi
if ! kill -0 "${sleep_pid}" 2>/dev/null; then
  fail "boot id check signaled the process"
fi
printf '%s\n' "${start_line}" > "${RUN_DIR}/sample.pid.start"
if ! pid_is_ours "${RUN_DIR}/sample.pid"; then
  fail "restored start record was rejected"
fi
echo 1 > "${RUN_DIR}/sample.pid.start"
if pid_is_ours "${RUN_DIR}/sample.pid"; then
  fail "single-token start record was trusted"
fi
stop_recorded_pid "${RUN_DIR}/sample.pid" "sample" 1
if ! kill -0 "${sleep_pid}" 2>/dev/null; then
  fail "stale pidfile signaled an unrelated process"
fi
kill "${sleep_pid}" 2>/dev/null || true
wait "${sleep_pid}" 2>/dev/null || true
sleep_pid=""
echo "ok pid identity and boot id"

set +e
# shellcheck disable=SC2016
env \
  TWILIO_BRIDGE_RUN_DIR="${TMP}/mismatch-run" \
  TWILIO_BRIDGE_LOG_DIR="${TMP}/mismatch-log" \
  BRIDGE_HOME="${TMP}/home" \
  BRIDGE_ENV_FILE="${TMP}/other.env" \
  bash -c 'source "$1"' bash "${ROOT}/ops/common.sh" >"${TMP}/mismatch.log" 2>&1
mismatch_rc=$?
set -e
if [[ "${mismatch_rc}" -eq 0 ]]; then
  fail "foreign BRIDGE_ENV_FILE was accepted at startup"
fi
set +e
(
  # shellcheck disable=SC2034
  BRIDGE_ENV_FILE="${TMP}/other.env"
  bridge_port
) >"${TMP}/port-mismatch.log" 2>&1
port_mismatch_rc=$?
set -e
if [[ "${port_mismatch_rc}" -eq 0 ]]; then
  fail "bridge_port accepted a foreign BRIDGE_ENV_FILE"
fi

fixture="${TMP}/checkout"
mkdir -p "${fixture}/node_modules"
ln -sfn "${ROOT}/node_modules/dotenv" "${fixture}/node_modules/dotenv"
printf '%s\n' \
  'BRIDGE_API_KEY=   # set later' \
  'ALLOW_UNAUTHENTICATED_OPERATOR=1 # demo' \
  'export KEY=' \
  'PORT=3000 # listen port' \
  > "${fixture}/.env"
node -e '
const fs = require("fs");
const dotenv = require(process.argv[1]);
const parsed = dotenv.parse(fs.readFileSync(process.argv[2]));
const assert = (cond, msg) => { if (!cond) { console.error(msg); process.exit(1); } };
assert(parsed.BRIDGE_API_KEY === "", "BRIDGE_API_KEY parsed as " + JSON.stringify(parsed.BRIDGE_API_KEY));
assert(parsed.ALLOW_UNAUTHENTICATED_OPERATOR === "1", "ALLOW parsed as " + JSON.stringify(parsed.ALLOW_UNAUTHENTICATED_OPERATOR));
assert(parsed.KEY === "", "export KEY parsed as " + JSON.stringify(parsed.KEY));
assert(parsed.PORT === "3000", "PORT parsed as " + JSON.stringify(parsed.PORT));
' "${ROOT}/node_modules/dotenv" "${fixture}/.env"
fixture_port="$(
  BRIDGE_DIR="${fixture}" BRIDGE_ENV_FILE="${fixture}/.env" bridge_port
)"
if [[ "${fixture_port}" != "3000" ]]; then
  fail "bridge_port did not apply dotenv inline comments"
fi
printf 'export PORT=3999\n' > "${fixture}/.env"
fixture_port="$(
  BRIDGE_DIR="${fixture}" BRIDGE_ENV_FILE="${fixture}/.env" bridge_port
)"
if [[ "${fixture_port}" != "3999" ]]; then
  fail "bridge_port did not apply export PORT"
fi
printf 'PORT=\n' > "${fixture}/.env"
fixture_port="$(
  BRIDGE_DIR="${fixture}" BRIDGE_ENV_FILE="${fixture}/.env" bridge_port
)"
if [[ "${fixture_port}" != "3000" ]]; then
  fail "empty PORT should fall back to 3000"
fi
printf 'PORT=0\n' > "${fixture}/.env"
set +e
(
  BRIDGE_DIR="${fixture}" BRIDGE_ENV_FILE="${fixture}/.env" bridge_port
) >"${TMP}/port0.log" 2>&1
port0_rc=$?
set -e
if [[ "${port0_rc}" -eq 0 ]]; then
  fail "PORT=0 should not be used as a tunnel target"
fi
echo "ok dotenv port probe"

cat > "${TMP}/health.js" << 'EOF'
const http = require('http');
const fs = require('fs');
const modeFile = process.argv[2];
const server = http.createServer((req, res) => {
  if (req.url !== '/health') {
    res.statusCode = 404;
    res.end('no');
    return;
  }
  const mode = fs.readFileSync(modeFile, 'utf8').trim();
  res.setHeader('content-type', 'application/json');
  if (mode === 'spaced') {
    res.end('{ "authRequired" : true }');
    return;
  }
  if (mode === 'string') {
    res.end('{"authRequired":"true"}');
    return;
  }
  res.end(JSON.stringify({ ok: true, authRequired: mode === 'open', hmacAuth: true }));
});
const port = Number(process.argv[3] || 0);
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(String(server.address().port));
});
EOF
printf 'closed\n' > "${TMP}/health-mode"
if [[ "${created_env}" == "1" ]]; then
  node "${TMP}/health.js" "${TMP}/health-mode" 0 > "${TMP}/health.port" &
else
  node "${TMP}/health.js" "${TMP}/health-mode" "$(bridge_port)" > "${TMP}/health.port" &
fi
health_pid=$!
for _ in $(seq 1 50); do
  if [[ -s "${TMP}/health.port" ]]; then
    break
  fi
  sleep 0.05
done
hport="$(tr -d '[:space:]' < "${TMP}/health.port")"
if [[ -z "${hport}" || ! "${hport}" =~ ^[0-9]+$ ]]; then
  fail "health fixture did not bind a port"
fi
if [[ "${created_env}" == "1" ]]; then
  printf 'PORT=%s\n' "${hport}" > "${ROOT}/.env"
fi
real_port="$(bridge_port)"
if [[ "${hport}" != "${real_port}" ]]; then
  fail "health fixture port ${hport} is not the checkout port ${real_port}"
fi
printf '%s\n' \
  'ALLOW_UNAUTHENTICATED_OPERATOR: 1' \
  'KEY=#none' \
  'BRIDGE_API_KEY=#none' \
  'PORT=3000 # c' \
  > "${TMP}/bypass.env"
node -e '
const fs = require("fs");
const dotenv = require(process.argv[1]);
const parsed = dotenv.parse(fs.readFileSync(process.argv[2]));
const assert = (cond, msg) => { if (!cond) { console.error(msg); process.exit(1); } };
assert(parsed.ALLOW_UNAUTHENTICATED_OPERATOR === "1", "colon ALLOW parsed as " + JSON.stringify(parsed.ALLOW_UNAUTHENTICATED_OPERATOR));
assert(parsed.KEY === "", "KEY=#none parsed as " + JSON.stringify(parsed.KEY));
assert(parsed.BRIDGE_API_KEY === "", "BRIDGE_API_KEY=#none parsed as " + JSON.stringify(parsed.BRIDGE_API_KEY));
assert(parsed.PORT === "3000", "PORT parsed as " + JSON.stringify(parsed.PORT));
' "${ROOT}/node_modules/dotenv" "${TMP}/bypass.env"
if bridge_accepts_tunnel "${hport}"; then
  fail "authRequired false was accepted"
fi
if (
  ALLOW_UNAUTHENTICATED_OPERATOR=1
  BRIDGE_API_KEY=
  : "${ALLOW_UNAUTHENTICATED_OPERATOR}" "${BRIDGE_API_KEY}"
  bridge_accepts_tunnel "${hport}"
); then
  fail "shell ALLOW=1 and an empty BRIDGE_API_KEY opened the tunnel while health authRequired was false"
fi
if grep -q 'set later' "${TMP}/log/ops.log" 2>/dev/null; then
  fail "health gate logged .env comment text"
fi
printf 'open\n' > "${TMP}/health-mode"
if ! (
  ALLOW_UNAUTHENTICATED_OPERATOR=1
  BRIDGE_API_KEY=
  : "${ALLOW_UNAUTHENTICATED_OPERATOR}" "${BRIDGE_API_KEY}"
  bridge_accepts_tunnel "${hport}"
); then
  fail "authRequired true was rejected while the shell looked open"
fi
printf 'string\n' > "${TMP}/health-mode"
if bridge_accepts_tunnel "${hport}"; then
  fail "string authRequired true was accepted"
fi
printf 'spaced\n' > "${TMP}/health-mode"
if ! bridge_accepts_tunnel "${hport}"; then
  fail "spaced authRequired true was rejected"
fi
printf 'closed\n' > "${TMP}/health-mode"
echo "ok health gate ignores inline comments"

if ! grep -q 'wait_for_tunnel_auth' "${ROOT}/ops/start.sh"; then
  fail "start.sh must wait for authRequired before cloudflared"
fi
if ! grep -q 'bridge_accepts_tunnel' "${ROOT}/ops/supervise.sh"; then
  fail "supervise.sh must recheck authRequired before a tunnel restart"
fi
if grep -E 'wait_for_port.*\|\|' "${ROOT}/ops/start.sh" >/dev/null; then
  fail "start.sh ignores wait_for_port failure"
fi
if ! grep -q 'flock -w 30 8' "${ROOT}/ops/start.sh"; then
  fail "start.sh does not take the start lock"
fi
if ! grep -q 'start.lock' "${ROOT}/ops/start.sh"; then
  fail "start.sh lock file missing"
fi
# shellcheck disable=SC2016
if ! grep -q 'ss -tlnH "sport = :${port}"' "${ROOT}/ops/common.sh" "${ROOT}/ops/start.sh"; then
  fail "ss listener filter missing"
fi

if ! port_listening "${hport}"; then
  fail "ss sport filter missed the health fixture"
fi
if port_listening 1; then
  fail "ss sport filter matched port 1"
fi
echo "ok ss sport filter"

(
  # shellcheck disable=SC2317
  port_listening() { return 1; }
  set +e
  wait_for_port 9 2
  echo $? > "${TMP}/wait-port.rc"
)
if [[ "$(cat "${TMP}/wait-port.rc")" -eq 0 ]]; then
  fail "wait_for_port returned 0 when the port stayed closed"
fi
echo "ok wait_for_port fails closed"

FAKE="${TMP}/proc"
mkdir -p "${FAKE}"
export PROC_ROOT="${FAKE}"

write_cmd() {
  local pid="$1"
  shift
  mkdir -p "${FAKE}/${pid}"
  if [[ "$#" -eq 0 ]]; then
    : > "${FAKE}/${pid}/cmdline"
    return 0
  fi
  printf '%s\0' "$@" > "${FAKE}/${pid}/cmdline"
}

node_bin="$(command -v node)"
write_cmd 41001 vim src/server.js
ln -sfn /bin/true "${FAKE}/41001/exe"
ln -sfn "${ROOT}" "${FAKE}/41001/cwd"
if bridge_process_matches 41001; then
  fail "vim src/server.js matched the bridge"
fi
printf 'vim src/server.js' > "${FAKE}/41001/cmdline"
if bridge_process_matches 41001; then
  fail "space-joined vim src/server.js matched the bridge"
fi

write_cmd 41002 "${node_bin}" src/server.js
ln -sfn "${node_bin}" "${FAKE}/41002/exe"
ln -sfn "${ROOT}" "${FAKE}/41002/cwd"
if ! bridge_process_matches 41002; then
  fail "node with exact BRIDGE_ENTRY did not match"
fi

write_cmd 41003 node src/server.js.extra
ln -sfn "${node_bin}" "${FAKE}/41003/exe"
ln -sfn "${ROOT}" "${FAKE}/41003/cwd"
if bridge_process_matches 41003; then
  fail "src/server.js.extra matched BRIDGE_ENTRY"
fi

write_cmd 41004 node src/server.js
ln -sfn "${node_bin}" "${FAKE}/41004/exe"
ln -sfn "${TMP}" "${FAKE}/41004/cwd"
if bridge_process_matches 41004; then
  fail "node src/server.js in another cwd matched"
fi

write_cmd 41005 node -e 'process.exit(0)' src/server.js
ln -sfn /bin/true "${FAKE}/41005/exe"
ln -sfn "${ROOT}" "${FAKE}/41005/cwd"
if ! bridge_process_matches 41005; then
  fail "argv0 node with an exact BRIDGE_ENTRY argument did not match"
fi

cfg="${TMP}/cf.yml"
printf 'tunnel: example\n' > "${cfg}"
export CLOUDFLARED_CONFIG="${cfg}"
export CLOUDFLARED_BIN="${TMP}/cloudflared"
export TUNNEL_NAME="twilio-bridge"
printf '#!/bin/sh\nexit 0\n' > "${CLOUDFLARED_BIN}"
chmod +x "${CLOUDFLARED_BIN}"
write_cmd 41006 "${CLOUDFLARED_BIN}" tunnel --config "${cfg}" run "${TUNNEL_NAME}"
ln -sfn "${CLOUDFLARED_BIN}" "${FAKE}/41006/exe"
if ! cloudflared_process_matches 41006; then
  fail "exact cloudflared argv did not match"
fi
write_cmd 41007 vim "${CLOUDFLARED_BIN}" tunnel --config "${cfg}" run "${TUNNEL_NAME}"
ln -sfn /bin/true "${FAKE}/41007/exe"
if cloudflared_process_matches 41007; then
  fail "vim argv matched cloudflared"
fi
write_cmd 41008 cloudflared tunnel --config "${TMP}/other.yml" run other-tunnel
ln -sfn "${CLOUDFLARED_BIN}" "${FAKE}/41008/exe"
if cloudflared_process_matches 41008; then
  fail "a different tunnel config matched"
fi

: > "${TMP}/signaled"
(
  # shellcheck disable=SC2317
  stop_pid() { printf '%s\n' "$1" >> "${TMP}/signaled"; }
  stop_matching_processes bridge_process_matches "bridge"
  stop_matching_processes cloudflared_process_matches "cloudflared"
)
if grep -qx '41001' "${TMP}/signaled"; then
  fail "sweep selected vim src/server.js"
fi
if ! grep -qx '41002' "${TMP}/signaled"; then
  fail "sweep missed the node bridge"
fi
if ! grep -qx '41006' "${TMP}/signaled"; then
  fail "sweep missed cloudflared"
fi
if grep -qx '41007' "${TMP}/signaled"; then
  fail "sweep selected vim as cloudflared"
fi
echo "ok process identity"

export PROC_ROOT="/proc"

# Keep the shell alive. A trailing wait stops bash from exec'ing tail,
# which is the parent-shell case the old substring kill hit.
# shellcheck disable=SC2016
bash -c 'cd "$1"; tail -f src/server.js & wait' bash "${ROOT}" >/dev/null 2>&1 &
tail_parent=$!
for _ in $(seq 1 50); do
  tail_child="$(ps -o pid= --ppid "${tail_parent}" 2>/dev/null | awk 'NR==1 { print $1 }' || true)"
  if [[ -n "${tail_child}" ]]; then
    break
  fi
  sleep 0.05
done
if [[ -z "${tail_child}" ]]; then
  fail "tail child did not start"
fi
if bridge_process_matches "${tail_parent}"; then
  fail "parent shell of tail -f src/server.js matched the bridge"
fi
if bridge_process_matches "${tail_child}"; then
  fail "tail -f src/server.js matched the bridge"
fi
if ! tr '\0' ' ' < "/proc/${tail_child}/cmdline" | grep -q 'src/server.js'; then
  fail "tail cmdline did not include src/server.js"
fi
kill "${tail_child}" "${tail_parent}" 2>/dev/null || true
wait "${tail_parent}" 2>/dev/null || true
tail_parent=""
tail_child=""
echo "ok live tail is not the bridge"

if [[ "$(disabled_marker)" != "${BRIDGE_HOME}/var/lib/twilio-bridge/disabled" ]]; then
  fail "disabled marker is not under BRIDGE_HOME: $(disabled_marker)"
fi
if [[ "$(disabled_marker)" == "${RUN_DIR}/"* ]]; then
  fail "disabled marker is inside the run directory"
fi
mark_disabled
rm -rf "${RUN_DIR}"
mkdir -p "${RUN_DIR}"
chmod 700 "${RUN_DIR}"
if ! is_disabled; then
  fail "disabled marker disappeared when the run directory was removed"
fi
clear_disabled
if is_disabled; then
  fail "clear_disabled left the persistent marker"
fi
echo "ok disabled marker survives run dir removal"

mark_disabled
: > "${LOG_DIR}/ops.log"
set +e
env -u SKIP_TUNNEL "${ROOT}/ops/boot.sh" >"${TMP}/boot-disabled.log" 2>&1
boot_disabled_rc=$?
set -e
if [[ "${boot_disabled_rc}" -ne 0 ]]; then
  fail "boot.sh should exit 0 while the disabled marker exists (rc=${boot_disabled_rc})"
fi
if grep -q 'services not fully up' "${LOG_DIR}/ops.log" "${TMP}/boot-disabled.log"; then
  fail "boot.sh started services despite the disabled marker"
fi
if ! is_disabled; then
  fail "boot.sh cleared the disabled marker"
fi
echo "ok boot honors stop marker"

set +e
env -u SKIP_TUNNEL NODE_BIN="${TMP}/missing-node" "${ROOT}/ops/start.sh" >"${TMP}/start-clears.log" 2>&1
start_clear_rc=$?
set -e
if [[ "${start_clear_rc}" -eq 0 ]]; then
  fail "start.sh should exit non-zero when node is missing"
fi
if is_disabled; then
  fail "start.sh left the disabled marker in place"
fi
echo "ok start clears stop marker"

SKIP_TUNNEL=1 save_skip_tunnel
unset SKIP_TUNNEL
load_skip_tunnel
if [[ "${SKIP_TUNNEL:-}" != "1" ]]; then
  fail "load_skip_tunnel did not restore the saved choice"
fi
unset SKIP_TUNNEL
set +e
env -u SKIP_TUNNEL "${ROOT}/ops/status.sh" >"${TMP}/status-skip.out" 2>&1
set -e
if ! grep -q 'skipped (SKIP_TUNNEL=1)' "${TMP}/status-skip.out"; then
  fail "status.sh ignored the saved SKIP_TUNNEL choice"
fi
set +e
env -u SKIP_TUNNEL NODE_BIN="${TMP}/missing-node" "${ROOT}/ops/boot.sh" >"${TMP}/boot-skip.log" 2>&1
boot_skip_rc=$?
set -e
if [[ ! -f "$(skip_tunnel_marker)" ]]; then
  fail "boot.sh dropped the saved SKIP_TUNNEL choice (rc=${boot_skip_rc})"
fi
if ! grep -q 'node binary not found' "${TMP}/boot-skip.log"; then
  fail "boot.sh did not reach start.sh with the saved SKIP_TUNNEL choice (rc=${boot_skip_rc})"
fi
echo "ok boot keeps SKIP_TUNNEL"

set +e
env -u SKIP_TUNNEL NODE_BIN="${TMP}/missing-node" "${ROOT}/ops/start.sh" >"${TMP}/start-clears-skip.log" 2>&1
set -e
if [[ -f "$(skip_tunnel_marker)" ]]; then
  fail "start.sh without SKIP_TUNNEL left the saved skip in place"
fi
echo "ok start clears SKIP_TUNNEL"

printf 'closed\n' > "${TMP}/health-mode"
cat > "${TMP}/tunnel-bin" << EOF
#!/bin/sh
echo ran >> "${TMP}/tunnel-ran"
sleep 30
EOF
chmod +x "${TMP}/tunnel-bin"
rm -f "${TMP}/tunnel-ran"
"${ROOT}/ops/supervise.sh" tunnel -- "${TMP}/tunnel-bin" >"${TMP}/sup-closed.out" 2>&1 &
sup_pid=$!
withheld=0
for _ in $(seq 1 40); do
  if grep -q 'authRequired is not true' "${LOG_DIR}/tunnel.supervisor.log" "${LOG_DIR}/ops.log" 2>/dev/null; then
    withheld=1
    break
  fi
  sleep 0.2
done
if [[ "${withheld}" -ne 1 ]]; then
  fail "supervise.sh did not withhold cloudflared when authRequired was false"
fi
if [[ -f "${TMP}/tunnel-ran" ]]; then
  fail "supervise.sh launched cloudflared when authRequired was false"
fi
kill -TERM "${sup_pid}" 2>/dev/null || true
wait "${sup_pid}" 2>/dev/null || true
sup_pid=""

printf 'open\n' > "${TMP}/health-mode"
rm -f "${TMP}/tunnel-ran"
"${ROOT}/ops/supervise.sh" tunnel -- "${TMP}/tunnel-bin" >"${TMP}/sup-open.out" 2>&1 &
sup_pid=$!
launched=0
for _ in $(seq 1 40); do
  if [[ -f "${TMP}/tunnel-ran" ]]; then
    launched=1
    break
  fi
  sleep 0.2
done
if [[ "${launched}" -ne 1 ]]; then
  fail "supervise.sh did not launch cloudflared when authRequired was true"
fi
kill -TERM "${sup_pid}" 2>/dev/null || true
wait "${sup_pid}" 2>/dev/null || true
sup_pid=""
echo "ok supervise rechecks health"

export PROC_ROOT="${TMP}/no-proc"
set +e
( require_proc ) >"${TMP}/noproc.log" 2>&1
proc_rc=$?
set -e
export PROC_ROOT="/proc"
if [[ "${proc_rc}" -ne 1 ]]; then
  fail "missing proc should exit 1 (rc=${proc_rc})"
fi
echo "ok missing proc fails loudly"

set +e
bash -c 'source "$1"; command() { if [[ "${1:-}" == "-v" && "${2:-}" == "flock" ]]; then return 1; fi; builtin command "$@"; }; require_flock' bash "${ROOT}/ops/common.sh" >"${TMP}/noflock.log" 2>&1
flock_rc=$?
set -e
if [[ "${flock_rc}" -ne 1 ]]; then
  fail "missing flock should exit 1 (rc=${flock_rc})"
fi
echo "ok missing flock fails loudly"

set +e
bash -c 'source "$1"; command() { if [[ "${1:-}" == "-v" && "${2:-}" == "ss" ]]; then return 1; fi; builtin command "$@"; }; require_ss' bash "${ROOT}/ops/common.sh" >"${TMP}/noss.log" 2>&1
ss_rc=$?
set -e
if [[ "${ss_rc}" -ne 1 ]]; then
  fail "missing ss should exit 1 (rc=${ss_rc})"
fi
echo "ok missing ss fails loudly"

set +e
bash -c 'source "$1"; command() { if [[ "${1:-}" == "-v" && "${2:-}" == "curl" ]]; then return 1; fi; builtin command "$@"; }; require_curl' bash "${ROOT}/ops/common.sh" >"${TMP}/nocurl.log" 2>&1
curl_rc=$?
set -e
if [[ "${curl_rc}" -ne 1 ]]; then
  fail "missing curl should exit 1 (rc=${curl_rc})"
fi
echo "ok missing curl fails loudly"

export CLOUDFLARED_BIN="${TMP}/tunnel-bin"
export CLOUDFLARED_CONFIG="${TMP}/cloudflared-not-real.yml"
export TUNNEL_NAME="ops-test-tunnel-not-real"
printf 'tunnel: example\n' > "${CLOUDFLARED_CONFIG}"
rm -f "${TMP}/tunnel-ran"

printf 'closed\n' > "${TMP}/health-mode"
sleep 60 &
tunnel_sleeper=$!
write_pidfile "${RUN_DIR}/tunnel.pid" "${tunnel_sleeper}"
sleep 60 &
tunnel_sup_sleeper=$!
write_pidfile "${RUN_DIR}/tunnel.supervisor.pid" "${tunnel_sup_sleeper}"
unset SKIP_TUNNEL
"${ROOT}/ops/supervise.sh" bridge -- sleep 60 >"${TMP}/bridge-closed.out" 2>&1 &
sup_pid=$!
stopped=0
for _ in $(seq 1 80); do
  if ! kill -0 "${tunnel_sleeper}" 2>/dev/null && ! kill -0 "${tunnel_sup_sleeper}" 2>/dev/null \
    && grep -q 'leaving cloudflared stopped' "${LOG_DIR}/ops.log"; then
    stopped=1
    break
  fi
  sleep 0.25
done
if [[ "${stopped}" -ne 1 ]]; then
  fail "bridge restart left the tunnel running when authRequired was false"
fi
if ! grep -q 'stopping cloudflared before bridge relaunch' "${LOG_DIR}/ops.log"; then
  fail "bridge restart did not stop cloudflared before the relaunch"
fi
if ! grep -q 'leaving cloudflared stopped' "${LOG_DIR}/ops.log"; then
  fail "failed health check restarted cloudflared"
fi
if [[ -f "${TMP}/tunnel-ran" ]]; then
  fail "failed health check launched cloudflared"
fi
if ! awk '
  /stopping cloudflared before bridge relaunch/ { stopped_at = NR }
  /launching bridge child/ && stopped_at && NR > stopped_at { launched_after = 1 }
  END { exit !launched_after }
' "${LOG_DIR}/ops.log"; then
  fail "bridge child was launched before cloudflared was stopped"
fi
bridge_child="$(read_pidfile "${RUN_DIR}/bridge.pid")"
if ! kill -0 "${bridge_child}" 2>/dev/null; then
  fail "bridge restart stopped the bridge child"
fi
kill -TERM "${sup_pid}" 2>/dev/null || true
wait "${sup_pid}" 2>/dev/null || true
sup_pid=""
tunnel_sleeper=""
tunnel_sup_sleeper=""

printf 'open\n' > "${TMP}/health-mode"
rm -f "${TMP}/tunnel-ran"
sleep 60 &
tunnel_sleeper=$!
write_pidfile "${RUN_DIR}/tunnel.pid" "${tunnel_sleeper}"
sleep 60 &
tunnel_sup_sleeper=$!
write_pidfile "${RUN_DIR}/tunnel.supervisor.pid" "${tunnel_sup_sleeper}"
"${ROOT}/ops/supervise.sh" bridge -- sleep 60 >"${TMP}/bridge-open.out" 2>&1 &
sup_pid=$!
restarted=0
for _ in $(seq 1 80); do
  if [[ -f "${TMP}/tunnel-ran" ]] && grep -q 'restarting cloudflared after authRequired true' "${LOG_DIR}/ops.log"; then
    restarted=1
    break
  fi
  sleep 0.25
done
if [[ "${restarted}" -ne 1 ]]; then
  fail "authRequired true did not restart cloudflared after the bridge relaunch"
fi
if kill -0 "${tunnel_sleeper}" 2>/dev/null || kill -0 "${tunnel_sup_sleeper}" 2>/dev/null; then
  fail "bridge relaunch left the previous tunnel up during the health check"
fi
tunnel_restart_sup="$(read_pidfile "${RUN_DIR}/tunnel.supervisor.pid")"
kill -TERM "${sup_pid}" 2>/dev/null || true
if [[ -n "${tunnel_restart_sup}" ]]; then
  kill -TERM "${tunnel_restart_sup}" 2>/dev/null || true
  wait "${tunnel_restart_sup}" 2>/dev/null || true
fi
wait "${sup_pid}" 2>/dev/null || true
sup_pid=""
tunnel_sleeper=""
tunnel_sup_sleeper=""

printf 'closed\n' > "${TMP}/health-mode"
rm -f "${TMP}/tunnel-ran"
sleep 60 &
tunnel_sleeper=$!
write_pidfile "${RUN_DIR}/tunnel.pid" "${tunnel_sleeper}"
SKIP_TUNNEL=1 "${ROOT}/ops/supervise.sh" bridge -- sleep 30 >"${TMP}/bridge-skip.out" 2>&1 &
sup_pid=$!
stopped=0
for _ in $(seq 1 80); do
  if ! kill -0 "${tunnel_sleeper}" 2>/dev/null; then
    stopped=1
    break
  fi
  sleep 0.25
done
if [[ "${stopped}" -ne 1 ]]; then
  fail "SKIP_TUNNEL=1 left a live tunnel pidfile up across a bridge relaunch"
fi
if [[ -f "${TMP}/tunnel-ran" ]]; then
  fail "SKIP_TUNNEL=1 restarted cloudflared when authRequired was false"
fi
kill -TERM "${sup_pid}" 2>/dev/null || true
wait "${sup_pid}" 2>/dev/null || true
sup_pid=""
tunnel_sleeper=""
unset SKIP_TUNNEL

clear_pidfile "${RUN_DIR}/tunnel.pid"
clear_pidfile "${RUN_DIR}/tunnel.supervisor.pid"
stops_before="$(grep -c 'stopping cloudflared before bridge relaunch' "${LOG_DIR}/ops.log" || true)"
SKIP_TUNNEL=1 "${ROOT}/ops/supervise.sh" bridge -- sleep 20 >"${TMP}/bridge-skip-quiet.out" 2>&1 &
sup_pid=$!
sleep 1
stops_after="$(grep -c 'stopping cloudflared before bridge relaunch' "${LOG_DIR}/ops.log" || true)"
if [[ "${stops_before}" != "${stops_after}" ]]; then
  fail "bridge relaunch stopped a tunnel when no tunnel pidfile was live"
fi
kill -TERM "${sup_pid}" 2>/dev/null || true
wait "${sup_pid}" 2>/dev/null || true
sup_pid=""
unset SKIP_TUNNEL
echo "ok bridge restart health gate"

install_home="${TMP}/install-home"
# common.sh puts ${BRIDGE_HOME}/.local/bin ahead of /usr/bin, so the stub has to live there.
mkdir -p "${install_home}/.local/bin" "${TMP}/frozen-run"
cat > "${install_home}/.local/bin/crontab" << 'EOF'
#!/bin/bash
set -euo pipefail
file="${CRON_CAPTURE:?}"
if [[ "${1:-}" == "-l" ]]; then
  if [[ -f "${file}" ]]; then
    cat "${file}"
  fi
  exit 0
fi
if [[ "${1:-}" == "-" ]]; then
  cat > "${file}"
  exit 0
fi
echo "unexpected crontab args" >&2
exit 1
EOF
chmod +x "${install_home}/.local/bin/crontab"
: > "${TMP}/cron-capture"
env \
  HOME="${install_home}" \
  BRIDGE_HOME="${install_home}" \
  TWILIO_BRIDGE_RUN_DIR="${TMP}/frozen-run" \
  TWILIO_BRIDGE_LOG_DIR="${TMP}/install-log" \
    PATH="${install_home}/.local/bin:${PATH}" \
  CRON_CAPTURE="${TMP}/cron-capture" \
  "${ROOT}/ops/install-boot.sh" >"${TMP}/install1.log" 2>&1
if ! grep -Fq "TWILIO_BRIDGE_RUN_DIR=${TMP}/frozen-run" "${install_home}/.profile"; then
  fail "profile hook did not pin TWILIO_BRIDGE_RUN_DIR"
fi
if ! grep -Fq "TWILIO_BRIDGE_RUN_DIR=${TMP}/frozen-run" "${TMP}/cron-capture"; then
  fail "crontab did not pin TWILIO_BRIDGE_RUN_DIR"
fi
profile_markers="$(grep -c 'twilio-bridge-boot' "${install_home}/.profile")"
cron_markers="$(grep -c 'twilio-bridge-boot' "${TMP}/cron-capture")"
if [[ "${profile_markers}" -ne 1 || "${cron_markers}" -ne 1 ]]; then
  fail "install duplicated a boot hook"
fi
env \
  HOME="${install_home}" \
  BRIDGE_HOME="${install_home}" \
  TWILIO_BRIDGE_RUN_DIR="${TMP}/frozen-run" \
  TWILIO_BRIDGE_LOG_DIR="${TMP}/install-log" \
    PATH="${install_home}/.local/bin:${PATH}" \
  CRON_CAPTURE="${TMP}/cron-capture" \
  "${ROOT}/ops/install-boot.sh" >"${TMP}/install2.log" 2>&1
profile_markers="$(grep -c 'twilio-bridge-boot' "${install_home}/.profile")"
cron_markers="$(grep -c 'twilio-bridge-boot' "${TMP}/cron-capture")"
if [[ "${profile_markers}" -ne 1 || "${cron_markers}" -ne 1 ]]; then
  fail "second install duplicated a boot hook"
fi
cat > "${install_home}/.profile" << EOF
echo keep-profile
# twilio-bridge-boot
# Auto-start the bridge and cloudflared tunnel if they are not already running.
[ -x /old/boot.sh ] && ( /old/boot.sh >/dev/null 2>&1 & )
EOF
printf '%s\n' \
  '# user-line' \
  '0 0 * * * echo keep' \
  '# twilio-bridge-boot' \
  '@reboot /old/boot.sh >> /tmp/old.log 2>&1' \
  > "${TMP}/cron-capture"
env \
  HOME="${install_home}" \
  BRIDGE_HOME="${install_home}" \
  TWILIO_BRIDGE_RUN_DIR="${TMP}/frozen-run" \
  TWILIO_BRIDGE_LOG_DIR="${TMP}/install-log" \
    PATH="${install_home}/.local/bin:${PATH}" \
  CRON_CAPTURE="${TMP}/cron-capture" \
  "${ROOT}/ops/install-boot.sh" >"${TMP}/install3.log" 2>&1
if ! grep -q 'keep-profile' "${install_home}/.profile"; then
  fail "profile rewrite dropped unrelated lines"
fi
if grep -q '/old/boot.sh' "${install_home}/.profile" "${TMP}/cron-capture"; then
  fail "stale boot hook remained"
fi
if ! grep -q 'echo keep' "${TMP}/cron-capture"; then
  fail "crontab rewrite dropped a user line"
fi
if ! grep -Fq "TWILIO_BRIDGE_RUN_DIR=${TMP}/frozen-run" "${install_home}/.profile"; then
  fail "rewritten profile hook did not pin TWILIO_BRIDGE_RUN_DIR"
fi
if ! grep -Fq "TWILIO_BRIDGE_RUN_DIR=${TMP}/frozen-run" "${TMP}/cron-capture"; then
  fail "rewritten crontab did not pin TWILIO_BRIDGE_RUN_DIR"
fi
echo "ok install pins RUN_DIR"

(
  sleep 30 &
  victim=$!
  printf '1\n' > "${TMP}/starttime-phase"
  # shellcheck disable=SC2317
  proc_starttime() {
    local phase
    phase="$(tr -d '[:space:]' < "${TMP}/starttime-phase")"
    if [[ "$1" == "${victim}" ]]; then
      if [[ "${phase}" == "1" ]]; then
        printf '2\n' > "${TMP}/starttime-phase"
        printf '100\n'
        return 0
      fi
      printf '200\n'
      return 0
    fi
    return 1
  }
  # shellcheck disable=SC2317
  proc_boot_id() { printf 'boot-a\n'; }
  # shellcheck disable=SC2317
  kill() {
    if [[ "${1:-}" == "-0" ]]; then
      builtin kill -0 "${2}"
      return
    fi
    printf '%s\n' "$*" >> "${TMP}/kills-changed"
    return 0
  }
  stop_pid "${victim}" "recycle" 0
  builtin kill -TERM "${victim}" 2>/dev/null || true
  wait "${victim}" 2>/dev/null || true
)
if ! grep -q -- '-TERM' "${TMP}/kills-changed"; then
  fail "SIGTERM was not sent before the identity recheck"
fi
if grep -q -- '-KILL' "${TMP}/kills-changed"; then
  fail "SIGKILL ran after pid start time changed"
fi
if ! grep -q 'pid identity changed' "${LOG_DIR}/ops.log"; then
  fail "changed identity was not logged"
fi
(
  sleep 30 &
  victim=$!
  # shellcheck disable=SC2317
  proc_starttime() {
    if [[ "$1" == "${victim}" ]]; then
      printf '100\n'
      return 0
    fi
    return 1
  }
  # shellcheck disable=SC2317
  proc_boot_id() { printf 'boot-a\n'; }
  # shellcheck disable=SC2317
  kill() {
    if [[ "${1:-}" == "-0" ]]; then
      builtin kill -0 "${2}"
      return
    fi
    printf '%s\n' "$*" >> "${TMP}/kills-stable"
    return 0
  }
  stop_pid "${victim}" "stable" 0
  builtin kill -TERM "${victim}" 2>/dev/null || true
  wait "${victim}" 2>/dev/null || true
)
if ! grep -q -- '-KILL' "${TMP}/kills-stable"; then
  fail "SIGKILL was skipped when pid identity was unchanged"
fi
echo "ok SIGKILL rechecks pid identity"

(
  # shellcheck disable=SC2317
  ss() {
    if [[ "$*" == *-tlnpH* ]]; then
      printf '%s\n' 'LISTEN 0 128 127.0.0.1:9 0.0.0.0:* users:(("node",pid=9999,fd=3))'
      return 0
    fi
    printf '%s\n' 'LISTEN 0 128 127.0.0.1:9 0.0.0.0:*'
  }
  # shellcheck disable=SC2317
  bridge_process_matches() { [[ "$1" == "8888" || "$1" == "9999" ]]; }
  # shellcheck disable=SC2317
  stop_pid() { printf '%s\n' "$1" >> "${TMP}/reclaim-stopped"; }
  : > "${TMP}/reclaim-stopped"
  reclaim_bridge_port 9
)
if [[ "$(tr -d '[:space:]' < "${TMP}/reclaim-stopped")" != "9999" ]]; then
  fail "reclaim signaled a process that was not the listener: $(cat "${TMP}/reclaim-stopped")"
fi
(
  # shellcheck disable=SC2317
  ss() {
    if [[ "$*" == *-tlnpH* ]]; then
      printf '%s\n' 'users:(("other",pid=7777,fd=3))'
      return 0
    fi
    printf '%s\n' 'LISTEN 0 128 127.0.0.1:9 0.0.0.0:*'
  }
  # shellcheck disable=SC2317
  bridge_process_matches() { [[ "$1" == "8888" ]]; }
  # shellcheck disable=SC2317
  stop_pid() { printf '%s\n' "$1" >> "${TMP}/reclaim-foreign"; }
  reclaim_bridge_port 9
)
if [[ -s "${TMP}/reclaim-foreign" ]]; then
  fail "reclaim signaled a checkout process that does not hold the port"
fi
echo "ok reclaim requires the listener pid"

if ! grep -q '8>&-' "${ROOT}/ops/common.sh" || ! grep -q '9>&-' "${ROOT}/ops/common.sh"; then
  fail "start_supervisor does not close lock fds"
fi
if ! grep -q '8>&-' "${ROOT}/ops/supervise.sh" || ! grep -q '9>&-' "${ROOT}/ops/supervise.sh"; then
  fail "child exec does not close lock fds"
fi
bash -c '
  exec 8>"$1/start.lock"
  exec 9>"$1/boot.lock"
  flock -n 8 || exit 2
  flock -n 9 || exit 3
  nohup "$2/ops/supervise.sh" bridge -- sleep 30 8>&- 9>&- </dev/null >/dev/null 2>>"$1/locksup.log" &
  echo $! > "$1/locksup.pid"
' bash "${TMP}" "${ROOT}"
lock_sup="$(tr -d '[:space:]' < "${TMP}/locksup.pid")"
ready=0
for _ in $(seq 1 40); do
  if [[ -f "${RUN_DIR}/bridge.pid" ]] && kill -0 "${lock_sup}" 2>/dev/null; then
    ready=1
    break
  fi
  sleep 0.1
done
if [[ "${ready}" -ne 1 ]]; then
  fail "lock-fd supervisor did not start"
fi
if ! bash -c 'exec 8>"$1"; flock -w 2 8' bash "${TMP}/start.lock"; then
  fail "spawned supervisor kept the start lock open"
fi
if ! bash -c 'exec 9>"$1"; flock -n 9' bash "${TMP}/boot.lock"; then
  fail "spawned supervisor kept the boot lock open"
fi
lock_child="$(read_pidfile "${RUN_DIR}/bridge.pid")"
for pid in "${lock_sup}" "${lock_child}"; do
  for fd in /proc/"${pid}"/fd/*; do
    target="$(readlink "${fd}" 2>/dev/null || true)"
    case "${target}" in
      *start.lock|*boot.lock)
        fail "pid ${pid} inherited lock fd ${target}"
        ;;
    esac
  done
done
kill -TERM "${lock_sup}" 2>/dev/null || true
wait "${lock_sup}" 2>/dev/null || true
lock_sup=""
echo "ok lock fds are not inherited"

echo "All ops tests passed"
