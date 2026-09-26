#!/usr/bin/env bash
# Ops script checks: symlink resolution, pid identity, tunnel health gate.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="$(mktemp -d)"
sleep_pid=""
health_pid=""
sup_pid=""

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
  rm -rf "${TMP}"
}
trap cleanup EXIT

export TWILIO_BRIDGE_RUN_DIR="${TMP}/run"
export TWILIO_BRIDGE_LOG_DIR="${TMP}/log"
export BRIDGE_HOME="${TMP}/home"
export BRIDGE_ENV_FILE="${TMP}/bridge.env"
mkdir -p "${BRIDGE_HOME}" "${TMP}/linkdir" "${TMP}/log"
printf 'PORT=3000\n' > "${BRIDGE_ENV_FILE}"

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
if grep -R -n 'pkill' "${ROOT}/ops" >/dev/null; then
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

printf '%s\n' \
  'BRIDGE_API_KEY=   # set later' \
  'ALLOW_UNAUTHENTICATED_OPERATOR=1 # demo' \
  'export KEY=' \
  'PORT=3000 # listen port' \
  > "${BRIDGE_ENV_FILE}"
node -e '
const fs = require("fs");
const dotenv = require(process.argv[1]);
const parsed = dotenv.parse(fs.readFileSync(process.argv[2]));
const assert = (cond, msg) => { if (!cond) { console.error(msg); process.exit(1); } };
assert(parsed.BRIDGE_API_KEY === "", "BRIDGE_API_KEY parsed as " + JSON.stringify(parsed.BRIDGE_API_KEY));
assert(parsed.ALLOW_UNAUTHENTICATED_OPERATOR === "1", "ALLOW parsed as " + JSON.stringify(parsed.ALLOW_UNAUTHENTICATED_OPERATOR));
assert(parsed.KEY === "", "export KEY parsed as " + JSON.stringify(parsed.KEY));
assert(parsed.PORT === "3000", "PORT parsed as " + JSON.stringify(parsed.PORT));
' "${ROOT}/node_modules/dotenv" "${BRIDGE_ENV_FILE}"
if [[ "$(bridge_port)" != "3000" ]]; then
  fail "bridge_port did not apply dotenv inline comments"
fi
printf 'export PORT=3999\n' > "${BRIDGE_ENV_FILE}"
if [[ "$(bridge_port)" != "3999" ]]; then
  fail "bridge_port did not apply export PORT"
fi
printf 'PORT=\n' > "${BRIDGE_ENV_FILE}"
if [[ "$(bridge_port)" != "3000" ]]; then
  fail "empty PORT should fall back to 3000"
fi
printf 'PORT=0\n' > "${BRIDGE_ENV_FILE}"
set +e
( bridge_port ) >"${TMP}/port0.log" 2>&1
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
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(String(server.address().port));
});
EOF
printf 'closed\n' > "${TMP}/health-mode"
node "${TMP}/health.js" "${TMP}/health-mode" > "${TMP}/health.port" &
health_pid=$!
for _ in $(seq 1 50); do
  if [[ -s "${TMP}/health.port" ]]; then
    break
  fi
  sleep 0.05
done
hport="$(tr -d '[:space:]' < "${TMP}/health.port")"
if [[ -z "${hport}" ]]; then
  fail "health fixture did not listen"
fi
printf 'PORT=%s\nBRIDGE_API_KEY=   # set later\nALLOW_UNAUTHENTICATED_OPERATOR=1 # demo\nexport KEY=\n' "${hport}" > "${BRIDGE_ENV_FILE}"
if [[ "$(bridge_port)" != "${hport}" ]]; then
  fail "bridge_port did not track the health fixture port"
fi
if bridge_accepts_tunnel "${hport}"; then
  fail "authRequired false was accepted (inline-comment .env must not open the tunnel)"
fi
if grep -q 'set later' "${TMP}/log/ops.log" 2>/dev/null; then
  fail "health gate logged .env comment text"
fi
printf 'open\n' > "${TMP}/health-mode"
if ! bridge_accepts_tunnel "${hport}"; then
  fail "authRequired true was rejected"
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
printf 'PORT=3000\n' > "${BRIDGE_ENV_FILE}"

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
printf 'PORT=%s\n' "${hport}" > "${BRIDGE_ENV_FILE}"
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

echo "All ops tests passed"
