# Bridge and Cloudflare tunnel ops

Supervisor scripts for `node src/server.js` and a named Cloudflare tunnel (`TUNNEL_NAME`). They target Linux hosts where systemd is not available. A crash restarts the child with exponential backoff (1s, then doubling, capped at 60s). Auto-start uses:

1. A guarded `${HOME}/.profile` hook that runs `ops/boot.sh` for login shells.
2. `crontab` `@reboot` when cron is installed. Without cron, that path does nothing.

`boot.sh` stays quiet when the required supervisors and children already match their pidfiles. It logs only when it starts something. It does nothing while a stop marker is present (see below).

## Process identity

Pidfiles live in one directory for both cron and login: `/tmp/twilio-bridge-<uid>`, or `TWILIO_BRIDGE_RUN_DIR` when that is set. `XDG_RUNTIME_DIR` is not used, because it is often set in a login session and unset in cron.

Each pidfile is paired with a record of the process start time from `/proc/<pid>/stat` and a boot id (`/proc/sys/kernel/random/boot_id`, or `btime` from `/proc/stat` when the boot id file is missing). `stop.sh` and `boot.sh` signal a pid only when both still match, so a recycled pid is not killed.

`/proc`, `flock`, `ss`, and `curl` are required. If any of them is missing, the scripts exit with an error instead of treating the host as healthy. `ss` checks listeners with `ss -tlnH "sport = :<port>"`.

Stopping the bridge or cloudflared never uses a name match across the whole process table, and it does not use `pkill`. A bridge process counts only when argv0 or `/proc/<pid>/exe` is `NODE_BIN` or a program named `node`, one argument is exactly `BRIDGE_ENTRY`, and `/proc/<pid>/cwd` is `BRIDGE_DIR`. `tail -f src/server.js` and `vim src/server.js` do not match: the argument may be exactly `src/server.js`, but argv0 and exe are not node. A parent shell whose `-c` argument contains that path does not match either, because that argument is the whole command, not `src/server.js`. Command lines are split on NUL. cloudflared counts only when the binary is cloudflared (or `CLOUDFLARED_BIN`) and the arguments include `tunnel`, `--config` with `CLOUDFLARED_CONFIG`, `run`, and `TUNNEL_NAME`.

## Paths

`BRIDGE_DIR` is the checkout root (the parent of `ops/`), after symlink resolution. `BASH_SOURCE` is followed with `readlink` so convenience symlinks do not point `BRIDGE_DIR` at the symlink directory.

| What | Path |
|------|------|
| Bridge app | `${BRIDGE_DIR}` |
| Ops scripts | `${BRIDGE_DIR}/ops/` |
| Convenience symlinks | `${BRIDGE_HOME}/services/twilio-bridge/` |
| cloudflared config | `${CLOUDFLARED_CONFIG}` |
| Run/pid files | `${TWILIO_BRIDGE_RUN_DIR}` or `/tmp/twilio-bridge-<uid>` |
| Logs | `${TWILIO_BRIDGE_LOG_DIR}` (default `${BRIDGE_HOME}/var/log/twilio-bridge`) |

Node loads `${BRIDGE_DIR}/.env` from the checkout (dotenv, with `override: true`). These scripts refuse to start unless `BRIDGE_ENV_FILE` resolves to that same path. The port probe reads only that file, with the same dotenv parser and `Number(value || 3000)` expression as the app. Log and run directories are created mode `0700` (`umask 077`). `install-boot.sh` writes the resolved `TWILIO_BRIDGE_RUN_DIR` into the profile hook and the `@reboot` line, and rewrites an older hook that does not pin that path.

When `log()` writes, or when a supervisor is about to start a child, a log file larger than `TWILIO_BRIDGE_LOG_MAX_BYTES` (default 5242880) is renamed to the same path with a `.1` suffix and gzipped when `gzip` is on `PATH`. The next rotation replaces that `.1` file. One previous generation is kept.

## Environment variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `BRIDGE_HOME` | Base directory for logs and symlinks | `$HOME` |
| `TWILIO_BRIDGE_RUN_DIR` | PID files directory | `/tmp/twilio-bridge-<uid>` |
| `TWILIO_BRIDGE_LOG_DIR` | Log files directory | `${BRIDGE_HOME}/var/log/twilio-bridge` |
| `TWILIO_BRIDGE_LOG_MAX_BYTES` | Rotate a log above this size | `5242880` |
| `CLOUDFLARED_BIN` | cloudflared binary | `${BRIDGE_HOME}/.local/bin/cloudflared` |
| `CLOUDFLARED_CONFIG` | cloudflared config YAML | `${BRIDGE_HOME}/.cloudflared/config.yml` |
| `TUNNEL_NAME` | Cloudflare tunnel name | `twilio-bridge` |
| `NODE_BIN` | node binary | `command -v node` |
| `BRIDGE_ENTRY` | Bridge entry point | `src/server.js` |
| `BRIDGE_ENV_FILE` | Must resolve to `${BRIDGE_DIR}/.env`. Any other path is refused. | `${BRIDGE_DIR}/.env` |
| `PROC_ROOT` | Proc filesystem used for identity checks | `/proc` |
| `SKIP_TUNNEL` | Set to `1` to supervise the bridge only | unset |
| `PORT` | Listen port (same value the app reads) | `3000` |

`PROC_ROOT` defaults to `/proc`. Tests point it at a fixture directory. Node always loads `${BRIDGE_DIR}/.env`. `BRIDGE_ENV_FILE` is accepted only when `readlink -f` of that path equals `readlink -f` of `${BRIDGE_DIR}/.env`.

`start.sh` records `SKIP_TUNNEL=1` under the run directory. `boot.sh` and `status.sh` reuse that choice when `SKIP_TUNNEL` is unset in the environment. A later `./ops/start.sh` with `SKIP_TUNNEL` unset clears the saved choice and starts the tunnel after the health check. An explicit `SKIP_TUNNEL` in the environment wins over the saved file.

## Tunnel authentication

`start.sh` starts the bridge, waits until `PORT` is listening, then requests `http://127.0.0.1:$PORT/health`. cloudflared is started only when the JSON reports `authRequired` true. `supervise.sh` performs that request again before every tunnel launch, including each restart. After every bridge child launch, including each bridge restart, it requests `/health` again unless `SKIP_TUNNEL=1`. If `authRequired` is not true, it stops the tunnel supervisor, the tunnel child, and any identity-matched cloudflared. It does not stop the bridge. The scripts do not read `BRIDGE_API_KEY` or `ALLOW_UNAUTHENTICATED_OPERATOR` out of `.env` to make this decision. A line such as `ALLOW_UNAUTHENTICATED_OPERATOR: 1` is still parsed as `1` by dotenv, and `KEY=#none` becomes empty because `#` starts a comment. Those file lines, and a shell `ALLOW_UNAUTHENTICATED_OPERATOR=1` with an empty `BRIDGE_API_KEY`, do not open the tunnel. Only the running process's `/health` `authRequired` value does.

If the port never opens, or `/health` does not report `authRequired` true, `start.sh` exits non-zero and does not launch cloudflared. `start.sh` holds an exclusive lock on `${TWILIO_BRIDGE_RUN_DIR}/start.lock` for the length of the start.

Run with `SKIP_TUNNEL=1` for a local-only process. Do not point a public tunnel at this process unless operator authentication is on. `/health` reports `authRequired` true only when the running process has `BRIDGE_API_KEY` set.

Prefer a single ingress hostname to `http://127.0.0.1:$PORT` rather than a broad publish of the machine.

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
| Child crash (node or cloudflared) | Yes — supervisor restarts with backoff. The tunnel supervisor checks `/health` again before each restart. Each bridge restart checks `/health` again and stops cloudflared when `authRequired` is not true. |
| Accidental kill of the child only | Yes — supervisor relaunches |
| `stop.sh` | Stays down. `stop.sh` writes a disabled marker in the run directory. `boot.sh` (login shell and `@reboot`) exits without starting while that marker exists. `start.sh` removes the marker and starts. |
| Logout | Yes — processes were started under `nohup` |
| Machine restart | `@reboot` cron runs `boot.sh` if cron starts; otherwise the next login shell runs the profile hook. A disabled marker still wins. |

## Restart check

```bash
./ops/status.sh
./ops/stop.sh
./ops/boot.sh
./ops/status.sh
```

After `stop.sh`, `boot.sh` leaves the processes down. `start.sh` is what starts them again.

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
    service: http://127.0.0.1:$PORT
  - service: http_status:404
```

`$PORT` is the bridge listen port (default 3000).

5. Route DNS for that hostname to the tunnel.
6. Set `PUBLIC_HOST=<YOUR_HOSTNAME>.example.com` in `.env`, with `BRIDGE_API_KEY` set and `ALLOW_UNAUTHENTICATED_OPERATOR` not set to `1`.
7. `./ops/start.sh`
