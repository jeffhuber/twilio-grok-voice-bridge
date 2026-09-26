# twilio-grok-voice-bridge

**Repo:** https://github.com/jeffhuber/twilio-grok-voice-bridge

⚠️ **Experimental**: This bridge is a proof-of-concept for wiring Twilio voice to xAI Grok Voice realtime. It is not production-hardened out of the box. Always configure authentication (`BRIDGE_API_KEY`), review AI disclosure requirements for your jurisdiction, and test recording/consent policies before deploying.

Wire **Twilio outbound voice** to **xAI Grok Voice** (realtime) over Media Streams.

```
Operator / Grok Bot
  -> POST /call (this bridge)
    -> Twilio dials callee
      -> Twilio Media Streams (WSS mu-law 8 kHz)
        <-> this bridge
          <-> xAI Grok Voice realtime (WSS)
```

The bridge places the call, bridges audio both ways, supports mid-call **steer**, **voice switch**,
**transcript**, and a **hangup gate** (model emits [[HANGUP_REQUESTED]], then operator POST /hangup).

## Prerequisites

- Node.js **18+**
- A **Twilio** account + voice-capable From number
- An **xAI** API key with Grok Voice / realtime access
- A **public WSS host** Twilio can reach for Media Streams
  - Local: cloudflared tunnel via scripts/tunnel.sh, then set PUBLIC_HOST
  - Or deploy this server behind HTTPS/WSS


## Quickstart

1. Copy env example to a local dotenv file and fill keys.
2. Install Node deps and start the server.
3. Set PUBLIC_HOST to a hostname Twilio can reach; restart.
4. Check GET /health.

Request bodies: docs/http-examples.md. Agent wiring: SKILL.md.



## HTTP API

### POST /call

Body JSON:

- `to` (required) — destination E.164
- `goal` (required) — what the voice agent should accomplish
- `context` (optional)
- `style` (optional) — `support` | `restaurant-book` | `custom`
- `voice` (optional) — xAI voice id or alias
- `softContinue` (optional bool)

Returns `callSid`, `style`, `voice`, etc.

### POST /steer

Body: `{ "callSid": "...", "text": "operator coaching" }` — updates instructions mid-call without announcing coaching.

### POST /hangup

Body: `{ "callSid": "..." }` — operator hangup gate. Model may set `hangupRequested` by emitting `[[HANGUP_REQUESTED]]`; bridge never auto-completes the Twilio leg.

### GET /transcript?callSid=...

Returns transcript lines plus hangup/hold flags.

### POST /voice

Body: `{ "callSid": "...", "voice": "ara" }` — mid-call TTS voice switch.

### GET /health

Liveness + config summary (no secrets).

## Security

**WARNING:** Without authentication, anyone who can reach this bridge can place Twilio calls and spend your account.

### Media Stream Authentication (WebSocket)

The `/media-stream` WebSocket endpoint uses **HMAC-SHA256 signature-based authentication** for strong, non-replayable security:

**How it works:**
1. When `/call` is invoked, Twilio fetches TwiML from the `/twiml-connect` endpoint
2. The bridge generates an HMAC-SHA256 signature: `HMAC(media secret, callSid:timestamp)`. The media secret is `MEDIA_STREAM_SECRET` when that value is non-empty after trimming, otherwise `BRIDGE_API_KEY`
3. The signature, CallSid, and timestamp are embedded in the Media Stream URL: `wss://HOST/media-stream?callSid=...&timestamp=...&signature=...`
4. These parameters are also passed as TwiML custom parameters for defense-in-depth verification
5. On WebSocket upgrade, the bridge:
   - Verifies the HMAC signature using constant-time comparison
   - Checks timestamp is within `MEDIA_AUTH_WINDOW_MS` (default 2 minutes)
   - Checks signature hasn't been claimed before within this process instance (mitigates replay)
   - Validates CallSid matches the pending session
6. **Signature claim:** On upgrade, the signature is atomically moved from pending to claimed state. Second upgrade attempts with the same signature are rejected with 409 Conflict.
7. On Twilio's `start` event, the bridge verifies:
   - CallSid from Twilio matches the URL CallSid
   - Custom parameters match URL parameters (prevents parameter injection)
8. Only after HMAC verification + CallSid binding succeeds does the bridge open the xAI Realtime WebSocket

**This mitigates:**
- **Replay attacks:** Signatures are single-use within a process instance and time-limited (default 2 minutes)
- **Token leakage:** Signatures are bound to a specific CallSid and timestamp
- **Bearer token weakness:** HMAC signatures cannot be forged without the media secret (`MEDIA_STREAM_SECRET` when non-empty after trim, otherwise `BRIDGE_API_KEY`)
- **CallSid forgery:** Signature verification fails if CallSid is tampered with
- **Parameter injection:** Custom parameters are cross-checked against URL parameters
- **Signature burn DoS:** Claimed signatures that close before CallSid bind are restored to pending with preserved TTL

**Signature verification:**
- HMAC-SHA256 signature over `callSid:timestamp` using `MEDIA_STREAM_SECRET` when non-empty after trim, otherwise `BRIDGE_API_KEY`
- Constant-time comparison prevents timing attacks
- Timestamp must be within `MEDIA_AUTH_WINDOW_MS` (default 2 minutes)
- Signatures are single-use (claimed atomically on upgrade)
- Old signatures invalidated on `/twiml-connect` retry (prevents multi-sig accumulation)

**Security properties:**
- **Strong binding:** Signature is cryptographically bound to CallSid and timestamp
- **Single-use per process:** Each call gets a unique signature; replays are rejected within the same process instance
- **Time-limited:** Timestamps expire after `MEDIA_AUTH_WINDOW_MS`
- **No bearer tokens:** Cannot be used without knowing the secret key

**Note:** This HMAC-based approach provides cryptographic signature verification and time-limited, single-use tokens. Replay protection is process-local (in-memory state), so horizontal scaling requires sticky sessions. The signature cannot be forged without the secret key, and leaked credentials only work for the specific CallSid + timestamp they were generated for, within the expiration window.

### Session Lifecycle & Error Handling

**Crash containment:** All WebSocket message handlers validate and parse JSON defensively. Malformed or null frames are logged and ignored per-socket; parsing errors never crash the Node process.

**Session garbage collection:** Orphan sessions (both WebSockets closed) and sessions exceeding `SESSION_MAX_AGE_MS` (default 2 hours) are automatically cleaned up every 2 minutes. This prevents memory leaks from interrupted or abandoned calls.

**One stream per CallSid:** The bridge enforces one active Twilio Media Stream per CallSid. Duplicate stream attempts for the same call are rejected with WebSocket close code 1008.

**Duplicate start protection:** After CallSid bind, subsequent `start` events on the same WebSocket are ignored to prevent re-applying custom parameters from potentially forged data.

### BRIDGE_API_KEY (CRITICAL)

Set `BRIDGE_API_KEY` to a strong random secret to protect operator control-plane routes:
- POST /call
- POST /steer
- POST /hangup
- POST /voice
- GET /transcript

The bridge accepts either header:
- `Authorization: Bearer <BRIDGE_API_KEY>`
- `X-Bridge-Key: <BRIDGE_API_KEY>`

### Auth policy

- **BRIDGE_API_KEY set:** operator routes require the key (401 JSON `{ error: "unauthorized" }` on miss/mismatch).
- **No BRIDGE_API_KEY:** operator routes return 401 unless `ALLOW_UNAUTHENTICATED_OPERATOR=1` is set (server exits on startup without this escape hatch).
- **ALLOW_UNAUTHENTICATED_OPERATOR=1:** server starts with a loud warning; operator routes are OPEN (localhost demos only — never use for shared/public deployments).

### Recording and Disclosure

- **Recording** is off unless `ENABLE_RECORDING` is exactly `1`. Other values, including `true`, do not enable it.
- **AI disclosure** is on unless `SKIP_AI_DISCLOSURE` is exactly `1`. Review legal requirements before turning it off.

### Public deployment

For public hosts, **always** use one of:
1. Set `BRIDGE_API_KEY` to a strong secret
2. Put the server behind Cloudflare Access or equivalent
3. Bind to localhost only and access via tunnel

**Do NOT** deploy this bridge publicly without authentication.

## Environment table

Values are read from the process environment (dotenv with `override: true`). `ALLOW_UNAUTHENTICATED_OPERATOR`, `ENABLE_RECORDING`, `SKIP_AI_DISCLOSURE`, and `LOG_TRANSCRIPTS` are on only when the value is exactly `1`. `true`, `yes`, and `0` do not turn them on.

Numeric settings use `Number(process.env.NAME || default)`. The environment value is a string, so `"0"` is kept and becomes numeric 0; it is not replaced by the default. An empty or unset value uses the default. `Number(value) || default` would drop numeric 0; these settings do not use that form.

The process calls `process.exit(1)` at startup when `BRIDGE_API_KEY` is unset or empty and `ALLOW_UNAUTHENTICATED_OPERATOR` is not exactly `1`.

`TWILIO_AUTH_TOKEN` enables `X-Twilio-Signature` checks on `/twiml-connect` only when it is non-empty. The signed URL is `https://${PUBLIC_HOST}` plus the request path and query. If `PUBLIC_HOST` is not the host Twilio used, validation fails with **403**. An empty `PUBLIC_HOST` makes `POST /call` return 500 and makes `/twiml-connect` return 500 when it builds TwiML.

Media-stream HMAC uses `MEDIA_STREAM_SECRET` when that value is non-empty after trim, otherwise `BRIDGE_API_KEY`. If both are empty, signature minting throws and `/twiml-connect` returns 500. `ALLOW_UNAUTHENTICATED_OPERATOR=1` leaves operator routes open and still allows calls to complete when `MEDIA_STREAM_SECRET` is set.

| Variable | Purpose | Default |
|----------|---------|---------|
| `TWILIO_ACCOUNT_SID` | Twilio account SID | unset |
| `TWILIO_AUTH_TOKEN` | Twilio auth token. Non-empty enables `/twiml-connect` signature checks | unset |
| `TWILIO_FROM_NUMBER` | E.164 Twilio voice number | unset |
| `XAI_API_KEY` | xAI API key | unset |
| `XAI_VOICE` | Default TTS voice id or alias | `ara` |
| `GROK_VOICE` | Fallback when `XAI_VOICE` is unset | unset |
| `XAI_VOICE_MODEL` | Realtime model query parameter | `grok-voice-latest` |
| `VOICE_ALIASES` | JSON object merged over built-in aliases (`ara`, `eve`, `rex`, `sal`) | unset |
| `PORT` | HTTP listen port | `3000` |
| `PUBLIC_HOST` | Public hostname only (no scheme). Wrong value causes 403s when a Twilio token is set | unset |
| `BRIDGE_API_KEY` | Operator secret (Bearer or `X-Bridge-Key`). Also the media HMAC key when `MEDIA_STREAM_SECRET` is empty | unset; process exits unless the override below is exactly `1` |
| `MEDIA_STREAM_SECRET` | Media HMAC key when non-empty after trim. When empty, HMAC uses `BRIDGE_API_KEY` | unset |
| `ALLOW_UNAUTHENTICATED_OPERATOR` | Exactly `1` starts without `BRIDGE_API_KEY` and leaves operator routes open | off |
| `MEDIA_AUTH_WINDOW_MS` | HMAC timestamp window in milliseconds | `120000` |
| `SESSION_MAX_AGE_MS` | Maximum session age before cleanup, milliseconds | `7200000` |
| `ENABLE_RECORDING` | Exactly `1` passes `record: true` and dual-channel recording to Twilio | off |
| `SKIP_AI_DISCLOSURE` | Exactly `1` omits the AI disclosure block from instructions | off (disclosure on) |
| `LOG_TRANSCRIPTS` | Exactly `1` writes transcript lines to stdout. Destination numbers in the call log are masked either way | off |
| `CONTACT_FULL_NAME` | Optional name for restaurant-book instructions | unset |
| `CONTACT_MOBILE` | Optional callback number for restaurant-book instructions | unset |
| `VAD_THRESHOLD` | Server VAD threshold | `0.7` |
| `VAD_SILENCE_MS` | Server VAD silence duration | `800` |
| `VAD_PREFIX_MS` | Server VAD prefix padding | `300` |
| `VAD_SOFT_THRESHOLD` | VAD threshold when soft-continue is on | `0.72` |
| `VAD_SOFT_SILENCE_MS` | VAD silence when soft-continue is on | `350` |
| `BARGE_IN_CONFIRM_MS` | How long user speech must last before barge-in | `280` |
| `BARGE_IN_COOLDOWN_MS` | Minimum gap between barge-ins | `450` |
| `BARGE_IN_MIN_AGENT_MS` | Ignore barge-in during the start of an agent utterance | `300` |
| `SOFT_CONTINUE_MS` | Delay after playback before a soft-continue nudge | `400` |
| `SOFT_CONTINUE_MAX` | Cap on soft-continue nudges per call | `8` |
| `HOLD_GRACE_MS` | No hold heuristics until this many milliseconds after start | `8000` |
| `HOLD_FRAMES` | Consecutive hold-like frames required to enter hold mode | `120` |

### Ops script variables

These are not read by `src/server.js`. They are read by `ops/*.sh` (see `ops/README.md` when that directory is present): `BRIDGE_HOME`, `TWILIO_BRIDGE_RUN_DIR`, `TWILIO_BRIDGE_LOG_DIR`, `TWILIO_BRIDGE_LOG_MAX_BYTES`, `CLOUDFLARED_BIN`, `CLOUDFLARED_CONFIG`, `TUNNEL_NAME`, `NODE_BIN`, `BRIDGE_ENTRY`, `SKIP_TUNNEL`, `BRIDGE_ENV_FILE`, `PROC_ROOT`, and `XDG_RUNTIME_DIR` (not used for pid files; the default run directory is `/tmp/twilio-bridge-<uid>` unless `TWILIO_BRIDGE_RUN_DIR` is set).

Do not commit a real dotenv file. Use `.env.example` as the template only.

## Styles

See templates/styles.md: support (default), restaurant-book (sample), custom (goal+context).

Optional softContinue true on POST /call enables post-playback soft-continue.

## Docs

- docs/architecture.md
- docs/http-examples.md — request bodies for call/steer/hangup
- templates/caller-bot-persona.md
- SKILL.md

## Security notes

- **BRIDGE_API_KEY**: The process exits unless this is set or `ALLOW_UNAUTHENTICATED_OPERATOR` is exactly `1`. It is the operator secret, and it is the media HMAC key only when `MEDIA_STREAM_SECRET` is empty. With neither secret, `/twiml-connect` returns 500 because signature minting throws.
- **Media Stream WebSocket** uses HMAC-SHA256 signature authentication (not bearer tokens). A signature covers a CallSid and timestamp, is single-use in this process, and expires after `MEDIA_AUTH_WINDOW_MS`.
- **X-Twilio-Signature validation**: Runs on `/twiml-connect` only when `TWILIO_AUTH_TOKEN` is non-empty. The checked URL uses `PUBLIC_HOST`; a different host than the one Twilio signed returns 403.
- **Recording** is on only when `ENABLE_RECORDING` is exactly `1`.
- **AI disclosure** stays on unless `SKIP_AI_DISCLOSURE` is exactly `1`.
- **Privacy defaults:** Destination numbers in the call log are masked. Transcript lines are written to stdout only when `LOG_TRANSCRIPTS` is exactly `1`.
- Keep Twilio tokens, xAI keys, BRIDGE_API_KEY, and real phone numbers out of git.
- Twilio needs a public WSS URL for Media Streams.

## Deployment requirements

- **An HMAC secret must be available**: `MEDIA_STREAM_SECRET` when non-empty after trim, otherwise `BRIDGE_API_KEY`. `ALLOW_UNAUTHENTICATED_OPERATOR=1` opens operator routes and still mints signatures when `MEDIA_STREAM_SECRET` is set
- **Sticky/single-node required**: In-memory pending session state means replay protection and session tracking are process-local; load balancers must route all requests from the same call to the same server instance
- **HTTPS/WSS required**: Twilio Media Streams require secure WebSocket connections
- **TWILIO_AUTH_TOKEN recommended**: Enables X-Twilio-Signature validation on `/twiml-connect` to prevent sessionId theft

## License

MIT — see LICENSE.
