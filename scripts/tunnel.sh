#!/usr/bin/env bash
set -euo pipefail
PORT="${PORT:-3000}"
if command -v cloudflared >/dev/null 2>&1; then
  exec cloudflared tunnel --url "http://127.0.0.1:${PORT}"
elif [ -x "${HOME}/.local/bin/cloudflared" ]; then
  exec "${HOME}/.local/bin/cloudflared" tunnel --url "http://127.0.0.1:${PORT}"
else
  echo "cloudflared not found. Install from Cloudflare docs." >&2
  exit 1
fi
