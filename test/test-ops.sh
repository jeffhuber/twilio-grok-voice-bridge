#!/usr/bin/env bash
# Ops script checks: symlink resolution, pid identity, tunnel auth refusal.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

export TWILIO_BRIDGE_RUN_DIR="${TMP}/run"
export TWILIO_BRIDGE_LOG_DIR="${TMP}/log"
export BRIDGE_HOME="${TMP}/home"
mkdir -p "${BRIDGE_HOME}" "${TMP}/linkdir"

ln -s "${ROOT}/ops/common.sh" "${TMP}/linkdir/common.sh"

bridge_dir="$(
  TWILIO_BRIDGE_RUN_DIR="${TMP}/run" \
  TWILIO_BRIDGE_LOG_DIR="${TMP}/log" \
  BRIDGE_HOME="${TMP}/home" \
  bash -c 'source "$1"; printf "%s" "${BRIDGE_DIR}"' bash "${TMP}/linkdir/common.sh"
)"
if [[ "${bridge_dir}" != "${ROOT}" ]]; then
  echo "FAIL symlink resolution: BRIDGE_DIR=${bridge_dir} expected ${ROOT}"
  exit 1
fi
echo "ok symlink resolution"

BRIDGE_DIR=""
# shellcheck disable=SC1091
source "${TMP}/linkdir/common.sh"
if [[ "${BRIDGE_DIR}" != "${ROOT}" ]]; then
  echo "FAIL sourced symlink BRIDGE_DIR=${BRIDGE_DIR}"
  exit 1
fi

sleep 120 &
sleep_pid=$!
write_pidfile "${RUN_DIR}/sample.pid" "${sleep_pid}"
if ! pid_is_ours "${RUN_DIR}/sample.pid"; then
  echo "FAIL expected matching start time to count as our process"
  kill "${sleep_pid}" 2>/dev/null || true
  exit 1
fi
echo 1 > "${RUN_DIR}/sample.pid.start"
if pid_is_ours "${RUN_DIR}/sample.pid"; then
  echo "FAIL mismatched start time was trusted"
  kill "${sleep_pid}" 2>/dev/null || true
  exit 1
fi
stop_recorded_pid "${RUN_DIR}/sample.pid" "sample" 1
if ! kill -0 "${sleep_pid}" 2>/dev/null; then
  echo "FAIL stale pidfile signaled an unrelated process"
  exit 1
fi
kill "${sleep_pid}" 2>/dev/null || true
wait "${sleep_pid}" 2>/dev/null || true
echo "ok pid identity"

export BRIDGE_ENV_FILE="${TMP}/bridge.env"
printf 'BRIDGE_API_KEY=\nALLOW_UNAUTHENTICATED_OPERATOR=\n' > "${BRIDGE_ENV_FILE}"
set +e
( refuse_tunnel_if_unsafe ) >"${TMP}/refuse-empty.log" 2>&1
empty_rc=$?
set -e
if [[ "${empty_rc}" -ne 1 ]]; then
  echo "FAIL empty BRIDGE_API_KEY should refuse tunnel (rc=${empty_rc})"
  exit 1
fi
if grep -q "BRIDGE_API_KEY is empty" "${TMP}/refuse-empty.log"; then
  echo "ok refuse empty operator key"
else
  echo "FAIL missing refusal message for empty key"
  exit 1
fi

printf 'BRIDGE_API_KEY=operator-test-secret\nALLOW_UNAUTHENTICATED_OPERATOR=1\n' > "${BRIDGE_ENV_FILE}"
set +e
( refuse_tunnel_if_unsafe ) >"${TMP}/refuse-open.log" 2>&1
open_rc=$?
set -e
if [[ "${open_rc}" -ne 1 ]]; then
  echo "FAIL ALLOW_UNAUTHENTICATED_OPERATOR=1 should refuse tunnel"
  exit 1
fi
if grep -q "operator-test-secret" "${TMP}/refuse-open.log"; then
  echo "FAIL tunnel refusal printed the operator key"
  exit 1
fi
echo "ok refuse unauthenticated operator"

printf 'BRIDGE_API_KEY=operator-test-secret\nALLOW_UNAUTHENTICATED_OPERATOR=\nPORT=3000\n' > "${BRIDGE_ENV_FILE}"
refuse_tunnel_if_unsafe
if [[ "$(bridge_port)" != "3000" ]]; then
  echo "FAIL bridge_port"
  exit 1
fi
echo "ok tunnel allowed when operator key is set"

PROC_ROOT="${TMP}/no-proc" 
export PROC_ROOT
set +e
( require_proc ) >"${TMP}/noproc.log" 2>&1
proc_rc=$?
set -e
unset PROC_ROOT
export PROC_ROOT="/proc"
if [[ "${proc_rc}" -ne 1 ]]; then
  echo "FAIL missing proc should exit 1 (rc=${proc_rc})"
  exit 1
fi
echo "ok missing proc fails loudly"

set +e
bash -c 'source "$1"; command() { if [[ "${1:-}" == "-v" && "${2:-}" == "flock" ]]; then return 1; fi; builtin command "$@"; }; require_flock' bash "${ROOT}/ops/common.sh" >"${TMP}/noflock.log" 2>&1
flock_rc=$?
set -e
if [[ "${flock_rc}" -ne 1 ]]; then
  echo "FAIL missing flock should exit 1 (rc=${flock_rc})"
  exit 1
fi
echo "ok missing flock fails loudly"

set +e
bash -c 'source "$1"; command() { if [[ "${1:-}" == "-v" && "${2:-}" == "ss" ]]; then return 1; fi; builtin command "$@"; }; require_ss' bash "${ROOT}/ops/common.sh" >"${TMP}/noss.log" 2>&1
ss_rc=$?
set -e
if [[ "${ss_rc}" -ne 1 ]]; then
  echo "FAIL missing ss should exit 1 (rc=${ss_rc})"
  exit 1
fi
echo "ok missing ss fails loudly"

echo "All ops tests passed"
