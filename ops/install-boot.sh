#!/usr/bin/env bash
# Wire login and reboot auto-start. Safe to re-run.
set -euo pipefail
OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${OPS_DIR}/common.sh"

boot_path="$(printf '%q' "${OPS_DIR}/boot.sh")"
log_path="$(printf '%q' "${LOG_DIR}/boot.cron.log")"
run_q="$(printf '%q' "${RUN_DIR}")"
# Pin the run directory that install resolved. A later login or cron environment
# must not pick a different TWILIO_BRIDGE_RUN_DIR than the one used here.
BOOT_LINE="[ -x ${boot_path} ] && ( TWILIO_BRIDGE_RUN_DIR=${run_q} ${boot_path} >/dev/null 2>&1 & )"
CRON_LINE="@reboot TWILIO_BRIDGE_RUN_DIR=${run_q} ${boot_path} >> ${log_path} 2>&1"
MARKER="# twilio-bridge-boot"
HOOK_COMMENT="# Auto-start the bridge and cloudflared tunnel if they are not already running."

strip_profile_hook() {
  local tmp
  tmp="$(mktemp)"
  awk -v marker="${MARKER}" '
    $0 == marker { armed = 1; next }
    armed && ($0 ~ /^# Auto-start the bridge/ || index($0, "boot.sh") > 0) {
      if (index($0, "boot.sh") > 0) armed = 0
      next
    }
    armed { armed = 0 }
    { print }
  ' "${PROFILE}" > "${tmp}"
  cat "${tmp}" > "${PROFILE}"
  rm -f "${tmp}"
}

PROFILE="${HOME}/.profile"
touch "${PROFILE}"
if grep -Fxq "${MARKER}" "${PROFILE}" && grep -Fxq "${BOOT_LINE}" "${PROFILE}"; then
  log "profile boot hook already present"
else
  if grep -Fxq "${MARKER}" "${PROFILE}"; then
    strip_profile_hook
    log "rewrote profile boot hook to pin TWILIO_BRIDGE_RUN_DIR"
  else
    log "installed profile boot hook"
  fi
  {
    echo ""
    echo "${MARKER}"
    echo "${HOOK_COMMENT}"
    echo "${BOOT_LINE}"
  } >> "${PROFILE}"
fi

if command -v crontab >/dev/null 2>&1; then
  existing="$(crontab -l 2>/dev/null || true)"
  if printf '%s\n' "${existing}" | grep -Fxq "${MARKER}" && printf '%s\n' "${existing}" | grep -Fxq "${CRON_LINE}"; then
    log "crontab @reboot already present"
  else
    filtered="$(printf '%s\n' "${existing}" | awk -v marker="${MARKER}" '
      $0 == marker { next }
      $0 ~ /^@reboot / && index($0, "boot.sh") > 0 { next }
      { print }
    ')"
    {
      printf '%s\n' "${filtered}"
      echo "${MARKER}"
      printf '%s\n' "${CRON_LINE}"
    } | crontab -
    if printf '%s\n' "${existing}" | grep -q "twilio-bridge-boot"; then
      log "rewrote crontab @reboot to pin TWILIO_BRIDGE_RUN_DIR"
    else
      log "installed crontab @reboot"
    fi
  fi
else
  log "crontab not available — profile hook is installed; run start.sh after a machine restart if login does not run it"
fi

SVC="${BRIDGE_HOME}/services/twilio-bridge"
mkdir -p "${SVC}"
for s in start.sh stop.sh status.sh boot.sh supervise.sh common.sh README.md; do
  ln -sfn "${OPS_DIR}/${s}" "${SVC}/${s}"
done
log "symlinked ops scripts into ${SVC}"
echo "Boot install done."
