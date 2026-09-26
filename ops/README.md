# Bridge and Cloudflare tunnel ops

Supervisor scripts for `node src/server.js` and a named Cloudflare tunnel (`TUNNEL_NAME`). They target Linux hosts where systemd is not available. A crash restarts the child with exponential backoff (1s, then doubling, capped at 60s). Auto-start uses:

1. A guarded `${HOME}/.profile` hook that runs `ops/boot.sh` for login shells.
2. `crontab` `@reboot` when cron is installed. Without cron, that path does nothing.

`boot.sh` stays quiet when the required supervisors and children already match their pidfiles. It logs only when it starts something.

## Process identity

Pidfiles live under `XDG_RUNTIME_DIR` when that directory is set, otherwise under `/tmp/twilio-bridge-<uid>`. Both locations are cleared across a machine restart more reliably than a directory under the home directory. Each pidfile is paired with a start-time record from `/proc/<pid>/stat`. `stop.sh` and `boot.sh` signal a pid only when that start time still matches, so a recycled pid is not killed.

`/proc`, `flock`, and `ss` are required. If any of them is missing, the scripts exit with an error instead of treating the host as healthy.

## Paths

`BRIDGE_DIR` is the checkout root (the parent of `ops/`), after symlink resolution. `BASH_SOURCE` is followed with `readlink` so convenience symlinks do not point `BRIDGE_DIR` at the symlink directory.

| What | Path |
|------|------|
| Bridge app | `${BRIDGE_DIR}` |
| Ops scripts | `${BRIDGE_DIR}/ops/` |
| Convenience symlinks | `${BRIDGE_HOME}/services/twilio-bridge/` |
| cloudflared config | `${CLOUDFLARED_CONFIG}` |
| Run/pid files | `${TWILIO_BRIDGE_RUN_DIR}` or `${XDG_RUNTIME_DIR}/twilio-bridge` or `/tmp/twilio-bridge-<uid>` |
| Logs | `${TWILIO_BRIDGE_LOG_DIR}` (default `${BRIDGE_HOME}/var/log/twilio-bridge`) |

The app loads `.env` from the checkout. These scripts read `PORT`, `BRIDGE_API_KEY`, and `ALLOW_UNAUTHENTICATED_OPERATOR` from that file and do not print secret values. Log and run directories are created mode `0700` (`umask 077`). Logs rotate after `TWILIO_BRIDGE_LOG_MAX_BYTES` (default 5 MiB) because bridge logs may contain transcripts.

## Environment variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `BRIDGE_HOME` | Base directory for logs and symlinks | `$HOME` |
| `TWILIO_BRIDGE_RUN_DIR` | PID files directory | `${XDG_RUNTIME_DIR}/twilio-bridge` or `/tmp/twilio-bridge-<uid>` |
| `TWILIO_BRIDGE_LOG_DIR` | Log files directory | `${BRIDGE_HOME}/var/log/twilio-bridge` |
| `TWILIO_BRIDGE_LOG_MAX_BYTES` | Rotate a log above this size | `5242880` |
| `CLOUDFLARED_BIN` | cloudflared binary | `${BRIDGE_HOME}/.local/bin/cloudflared` |
| `CLOUDFLARED_CONFIG` | cloudflared config YAML | `${BRIDGE_HOME}/.cloudflared/config.yml` |
| `TUNNEL_NAME` | Cloudflare tunnel name | `twilio-bridge` |
| `NODE_BIN` | node binary | `command -v node` |
| `BRIDGE_ENTRY` | Bridge entry point | `src/server.js` |
| `SKIP_TUNNEL` | Set to `1` to supervise the bridge only | unset |
| `PORT` | Listen port checked by status (same value the app reads from `.env`) | `3000` |

## Tunnel authentication

`start.sh` refuses to launch cloudflared when `BRIDGE_API_KEY` is empty or `ALLOW_UNAUTHENTICATED_OPERATOR=1`. Either setting leaves operator routes (`/call`, `/steer`, `/hangup`, `/voice`, `/transcript`) open, and a tunnel would publish them. Run with `SKIP_TUNNEL=1` for a local-only process. Do not point a public tunnel at this process unless operator authentication is on.

Prefer a single ingress hostname to `http://127.0.0.1:<PORT>` rather than a broad publish of the machine.

## Commands

```bash
./ops/start.sh
./ops/status.sh
./ops/stop.sh
./ops/boot.sh
./ops/install-boot.sh
SKIP_TUNNEL=1 ./ops/start.sh
```

## What survives what

| Event | Survives? |
|-------|-----------|
| Child crash (node or cloudflared) | Yes — supervisor restarts with backoff |
| Accidental kill of the child only | Yes — supervisor relaunches |
| `stop.sh` | Stays down until `start.sh` or `boot.sh` |
| Logout | Yes — processes were started under `nohup` |
| Machine restart | `@reboot` cron runs `boot.sh` if cron starts; otherwise the next login shell runs the profile hook |

## Restart check

```bash
./ops/status.sh
./ops/stop.sh
./ops/boot.sh
./ops/status.sh
```

## systemd

If the host later has a systemd user session, user units under `${HOME}/.config/systemd/user/` are a better fit. Until then, use these scripts.

## Cloudflare tunnel setup

1. Install cloudflared from the vendor's current Linux packages.
2. Authenticate: `cloudflared tunnel login`
3. Create a tunnel: `cloudflared tunnel create twilio-bridge` (or your `TUNNEL_NAME`)
4. Configure `${CLOUDFLARED_CONFIG}`:

```yaml
tunnel: <TUNNEL_UUID>
credentials-file: <HOME_DIR>/.cloudflared/<TUNNEL_UUID>.json

ingress:
  - hostname: <YOUR_HOSTNAME>.example.com
    service: http://127.0.0.1:3000
  - service: http_status:404
```

5. Route DNS for that hostname to the tunnel.
6. Set `PUBLIC_HOST=<YOUR_HOSTNAME>.example.com` in `.env`, with `BRIDGE_API_KEY` set and `ALLOW_UNAUTHENTICATED_OPERATOR` not set to `1`.
7. `./ops/start.sh`
