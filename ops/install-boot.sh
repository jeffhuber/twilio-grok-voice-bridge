#!/usr/bin/env bash
# Wire login and reboot auto-start. Safe to re-run.
set -euo pipefail
OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "${OPS_DIR}/common.sh"

boot_path="$(printf '%q' "${OPS_DIR}/boot.sh")"
log_path="$(printf '%q' "${LOG_DIR}/boot.cron.log")"
BOOT_LINE="[ -x ${boot_path} ] && ( ${boot_path} >/dev/null 2>&1 & )"
MARKER="# twilio-bridge-boot"

PROFILE="${HOME}/.profile"
touch "${PROFILE}"
if ! grep -q "twilio-bridge-boot" "${PROFILE}" 2>/dev/null; then
  {
    echo ""
    echo "${MARKER}"
    echo "# Auto-start the bridge and cloudflared tunnel if they are not already running."
    echo "${BOOT_LINE}"
  } >> "${PROFILE}"
  log "installed profile boot hook"
else
  log "profile boot hook already present"
fi

if command -v crontab >/dev/null 2>&1; then
  existing="$(crontab -l 2>/dev/null || true)"
  if ! printf '%s\n' "${existing}" | grep -q "twilio-bridge-boot"; then
    {
      printf '%s\n' "${existing}"
      echo "${MARKER}"
      printf '@reboot %s >> %s 2>&1\n' "${boot_path}" "${log_path}"
    } | crontab -
    log "installed crontab @reboot"
  else
    log "crontab @reboot already present"
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
