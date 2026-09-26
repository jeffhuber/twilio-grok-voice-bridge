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

- `to` (required) — destination E.164 (`+` and 2 to 15 digits). Any other value is 400 and the response does not include it.
- `goal` (required) — what the voice agent should accomplish
- `context` (optional)
- `style` (optional) — `support` | `restaurant-book` | `custom`
- `voice` (optional) — xAI voice id or alias
- `softContinue` (optional bool)
- `openerOnConnect` (optional boolean) — omit to follow `DISABLE_OPENER_ON_CONNECT` (default: greet once). `false` skips that greeting. `true` forces it even when `DISABLE_OPENER_ON_CONNECT` is exactly `1`. Any other JSON type, including `"false"`, `0`, and `null`, is 400.

Outbound calls greet once the model has accepted `audio/pcmu` output. The first `session.updated` clears the wait whether or not it reports `audio/pcmu`. The greeting is one `response.create`, and only when that same ack reports output format `audio/pcmu`. An `error` event, or a thrown send of the first `session.update`, clears the wait. The greeting is skipped when the callee is already speaking or already has a transcript line. `DISABLE_OPENER_ON_CONNECT` set to exactly `1` disables the default. Other values, including unset, `0`, and `false`, leave it on.

Returns `callSid`, `style`, `voice`, etc.

### POST /steer

Body: `{ "callSid": "...", "text": "operator coaching", "respond": false }`

Updates instructions mid-call without announcing coaching. Each request replaces the previous operator coaching: instructions are rebuilt from the call goal, context, and style, then the new text is appended. Earlier `/steer` text is not kept.

`respond` is optional. Omit it or set JSON `true` to force a model response (the default). Set JSON `false` to update instructions only, with no `response.create`. Any other JSON value, including the string `"false"`, `0`, or `null`, is rejected with 400.

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

The `/media-stream` WebSocket endpoint checks an HMAC-SHA256 signature on the Twilio `start` event. The socket is unauthenticated until that event binds.

**How it works:**
1. When `/call` is invoked, Twilio fetches TwiML from the `/twiml-connect` endpoint
2. The bridge generates an HMAC-SHA256 signature over `callSid:timestamp` when BRIDGE_API_KEY is set. The media secret is `MEDIA_STREAM_SECRET` when that value is non-empty after trimming; otherwise `BRIDGE_API_KEY`. If `BRIDGE_API_KEY` is unset, the signature is not minted, even when `MEDIA_STREAM_SECRET` is set.
3. The `<Stream url>` is the bare path `wss://HOST/media-stream` with no query string. Twilio error [31920](https://www.twilio.com/docs/api/errors/31920) rejects Stream URLs that include a query string.
4. `callSid`, `timestamp`, and `signature` are `<Parameter>` values. Twilio delivers them on the start message as `start.customParameters` ([WebSocket messages](https://www.twilio.com/docs/voice/media-streams/websocket-messages)).
5. The WebSocket upgrade accepts `/media-stream` without reading auth from the query string. Until `start` binds, the socket is unauthenticated. Messages are limited to 64 KiB. One Twilio `connected` event is ignored. Any other frame before `start` closes the socket with 1008, and a socket with no bound `start` within 5 seconds is closed with 1008. Those closes terminate about 1 second later if the peer does not finish the handshake. At most 4 unbound sockets are accepted per client, and at most 32 at once. When the global cap is full, the oldest unbound socket is evicted instead of refusing the new one. The per-client key is `CF-Connecting-IP` only when the TCP peer is loopback; otherwise it is the remote address. IPv6 clients are keyed by the /64 prefix. `CF-Connecting-IP` is safe only behind cloudflared on this host. A valid `X-Twilio-Signature` leaves the unsigned pool and is counted in a separate pool of 8 unbound sockets per client and 128 globally. That signature is static for the host and does not expire. A full signed pool evicts the oldest unbound signed socket. A leaked signature sent from 16 or more client addresses can fill that global pool of 128. The next signed socket then evicts the oldest unbound signed socket, which can be a Twilio stream that has not sent `start` yet. If the signature leaks, rotate `TWILIO_AUTH_TOKEN`. A signature header that is present but does not validate is logged at most once per second, without the header value. Pre-bind logs do not include the client event name. Rate limit `/media-stream` at the edge as well.
6. On Twilio's `start` event the bridge:
   - Reads `callSid`, `timestamp`, and `signature` only from `start.customParameters`
   - Requires `start.callSid` to match that `callSid`
   - Requires the pending session's CallSid to match that `callSid`
   - Verifies the HMAC signature using constant-time comparison
   - Checks the timestamp is within `MEDIA_AUTH_WINDOW_MS` (default 2 minutes)
   - Rejects a signature that was already consumed in this process, or that has no pending session
7. Only after that verification binds the socket does the bridge open the xAI Realtime WebSocket

Anyone who captures the TwiML `<Parameter>` values can open `/media-stream` and race the real Twilio stream until the signature is consumed or it expires. The upgrade itself does not authenticate.

**This mitigates:**
- **Replay attacks:** Signatures are single-use within a process instance and time-limited (default 2 minutes)
- **Forged signatures:** HMAC signatures cannot be forged without the media secret (`MEDIA_STREAM_SECRET` when non-empty after trim and `BRIDGE_API_KEY` is set; otherwise `BRIDGE_API_KEY`). Signatures are not minted or verified when `BRIDGE_API_KEY` is unset, even if `MEDIA_STREAM_SECRET` is set
- **CallSid forgery:** Signature verification fails if CallSid is tampered with
- **Parameter injection:** `start.callSid` must match the signed `callSid` parameter and the pending session. Goal, context, and voice are not taken from the start event.
- **Unauthenticated sockets:** Oversized frames, extra waiting sockets, non-start frames, and a missing `start` are closed instead of left open

**Signature verification:**
- HMAC-SHA256 signature over `callSid:timestamp` using `MEDIA_STREAM_SECRET` when non-empty after trim and `BRIDGE_API_KEY` is set; otherwise `BRIDGE_API_KEY`. Not minted or verified when `BRIDGE_API_KEY` is unset
- Constant-time comparison prevents timing attacks
- Timestamp must be within `MEDIA_AUTH_WINDOW_MS` (default 2 minutes)
- Signatures are single-use (claimed when the start event is accepted; a second start with the same signature is rejected)
- Old signatures invalidated on `/twiml-connect` retry (prevents multi-sig accumulation)

**Security properties:**
- **Call binding:** The signature covers that CallSid and timestamp. Replays in this process are rejected, and the timestamp must fall inside `MEDIA_AUTH_WINDOW_MS`
- **Single-use per process:** Each call gets a unique signature; replays are rejected within the same process instance
- **Time-limited:** Timestamps expire after `MEDIA_AUTH_WINDOW_MS`
- **No bearer tokens:** Cannot be used without knowing the secret key

**Note:** This HMAC-based approach provides cryptographic signature verification and time-limited, single-use tokens. Replay protection is process-local (in-memory state), so horizontal scaling requires sticky sessions. The signature cannot be forged without the secret key, and leaked credentials only work for the specific CallSid + timestamp they were generated for, within the expiration window.

### Session Lifecycle & Error Handling

**Crash containment:** All WebSocket message handlers validate and parse JSON defensively. Malformed or null frames are logged and ignored per-socket; parsing errors never crash the Node process.

**Session garbage collection:** Every 2 minutes, a session that has connected and whose Twilio and Grok sockets are both not open is removed without a hangup. A session that has never connected (still ringing) is kept until it is older than `NEVER_CONNECTED_TIMEOUT_MS` (default 10 minutes), so an early sweep does not make `/twiml-connect` return 404. That timeout must be an integer of at least 60000 milliseconds. `NaN`, `0`, `999`, `1000`, `59999`, a negative number, and `Infinity` warn and use the default. A session that still has a socket open and is older than `SESSION_MAX_AGE_MS` (default 2 hours) is hung up.

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

Values are read from the process environment. `src/server.js` calls `require('dotenv').config({ override: true })`, so values in `.env` replace existing environment variables. `ALLOW_UNAUTHENTICATED_OPERATOR`, `ENABLE_RECORDING`, `SKIP_AI_DISCLOSURE`, and `LOG_TRANSCRIPTS` are on only when the value is exactly `1`. `true`, `yes`, and `0` do not turn them on. `DISABLE_OPENER_ON_CONNECT` disables the connect greeting only when the value is exactly `1`. Unset, `0`, and `false` leave the greeting on.

Numeric settings use `Number(process.env.NAME || default)`. The environment value is a string, so `"0"` is kept and becomes numeric 0; it is not replaced by the default. An empty or unset value uses the default. `Number(value) || default` would drop numeric 0; these settings do not use that form.

The process calls `process.exit(1)` at startup when `BRIDGE_API_KEY` is unset or empty and `ALLOW_UNAUTHENTICATED_OPERATOR` is not exactly `1`.

`TWILIO_AUTH_TOKEN` enables `X-Twilio-Signature` checks on `/twiml-connect` only when it is non-empty. The signed URL is `https://${PUBLIC_HOST}` plus the request path and query. If `PUBLIC_HOST` is not the host Twilio used, validation fails with **403**. An empty `PUBLIC_HOST` makes `POST /call` return 500 and makes `/twiml-connect` return 500 when it builds TwiML.

Media-stream HMAC uses `MEDIA_STREAM_SECRET` when that value is non-empty after trim and `BRIDGE_API_KEY` is set; otherwise it uses `BRIDGE_API_KEY`. Both keys are read once at startup. Signatures are not minted or verified when `BRIDGE_API_KEY` is unset, even if `MEDIA_STREAM_SECRET` is set, and `/twiml-connect` returns 500 because minting throws. `ALLOW_UNAUTHENTICATED_OPERATOR=1` leaves operator routes open and does not let calls complete the media handshake.

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
| `BRIDGE_API_KEY` | Operator secret (Bearer or `X-Bridge-Key`). Required for media HMAC. When `MEDIA_STREAM_SECRET` is empty, this value is the HMAC key | unset; process exits unless the override below is exactly `1` |
| `MEDIA_STREAM_SECRET` | Dedicated media HMAC key only when `BRIDGE_API_KEY` is also set. When non-empty after trim, signatures use this instead of `BRIDGE_API_KEY`. If `BRIDGE_API_KEY` is unset, signatures are not minted or verified | unset |
| `ALLOW_UNAUTHENTICATED_OPERATOR` | Exactly `1` starts without `BRIDGE_API_KEY` and leaves operator routes open. It does not enable media HMAC | off |
| `MEDIA_AUTH_WINDOW_MS` | HMAC timestamp window in milliseconds | `120000` |
| `SESSION_MAX_AGE_MS` | A session older than this with a socket still open is hung up. A session that already connected and whose sockets are both closed is removed without a hangup, at any age | `7200000` |
| `NEVER_CONNECTED_TIMEOUT_MS` | How long a never-connected (still ringing) session is kept before the sweep removes it. An integer of at least 60000; other values warn and use the default | `600000` |
| `DISABLE_OPENER_ON_CONNECT` | Exactly `1` disables the greeting sent when the stream connects. Any other value, including unset, `0`, and `false`, leaves the greeting on. Per-call `openerOnConnect: true` still greets | off (greeting on) |
| `ENABLE_RECORDING` | Exactly `1` passes `record: true` and dual-channel recording to Twilio | off |
| `SKIP_AI_DISCLOSURE` | Exactly `1` omits the AI disclosure block from instructions | off (disclosure on) |
| `LOG_TRANSCRIPTS` | Exactly `1` writes transcript lines to stdout. The placed-call log masks the destination. `[call] error:`, `[hangup] Twilio update failed:`, `[twiml-connect] Error:`, `[http] unexpected error:`, `[http] 400 body parse error:`, and `[grok] error` log `err.message` after digit runs of 7 or more in that text are masked. The same mask covers `[grok] server error`, `[grok] JSON parse error`, `[twilio] JSON parse error`, and `[twilio] ws error` | off |
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

- **BRIDGE_API_KEY**: The process exits unless this is set or `ALLOW_UNAUTHENTICATED_OPERATOR` is exactly `1`. It is required for media HMAC. When `MEDIA_STREAM_SECRET` is empty, this value is the HMAC key. Signatures are not minted or verified when `BRIDGE_API_KEY` is unset, even if `MEDIA_STREAM_SECRET` is set. `/twiml-connect` then returns 500 because signature minting throws.
- **Media Stream WebSocket** checks an HMAC-SHA256 signature on the `start` event. The `<Stream>` URL is the bare path `wss://HOST/media-stream`. `callSid`, `timestamp`, and `signature` travel as `<Parameter>` values. The socket is unauthenticated until `start` binds. Captured TwiML parameters can race the real stream until the signature is consumed or it expires. A signature covers a CallSid and timestamp, is single-use in this process, and expires after `MEDIA_AUTH_WINDOW_MS`.
- **X-Twilio-Signature validation**: Runs on `/twiml-connect` only when `TWILIO_AUTH_TOKEN` is non-empty. The checked URL uses `PUBLIC_HOST`; a different host than the one Twilio signed returns 403.
- **Recording** is on only when `ENABLE_RECORDING` is exactly `1`.
- **AI disclosure** stays on unless `SKIP_AI_DISCLOSURE` is exactly `1`.
- **Privacy defaults:** The placed-call log masks the destination. `[call] error:`, `[hangup] Twilio update failed:`, `[twiml-connect] Error:`, `[http] unexpected error:`, `[http] 400 body parse error:`, and `[grok] error` log `err.message` after digit runs of 7 or more in that text are masked. The same mask covers `[grok] server error`, `[grok] JSON parse error`, `[twilio] JSON parse error`, and `[twilio] ws error`. The HTTP 500 body from `POST /call` uses it too. Spaces, hyphens, parentheses, and periods inside the run count. A letter or digit on either side is left alone, so Call SIDs and short error codes stay intact. A whole IPv4 address and a whole calendar date are left alone. There is no epoch-millisecond exemption, so a 13-digit run is masked, including a run that starts with + and the country code. Transcript lines are written to stdout only when `LOG_TRANSCRIPTS` is exactly `1`.
- Keep Twilio tokens, xAI keys, BRIDGE_API_KEY, and real phone numbers out of git.
- Twilio needs a public WSS URL for Media Streams.

## Deployment requirements

- **BRIDGE_API_KEY must be set for media HMAC**. `MEDIA_STREAM_SECRET` is only a separate rotation key and is not used unless the operator key is set. `ALLOW_UNAUTHENTICATED_OPERATOR=1` opens operator routes and does not mint or verify signatures
- **Sticky/single-node required**: In-memory pending session state means replay protection and session tracking are process-local; load balancers must route all requests from the same call to the same server instance
- **HTTPS/WSS required**: Twilio Media Streams require secure WebSocket connections
- **TWILIO_AUTH_TOKEN recommended**: Enables X-Twilio-Signature validation on `/twiml-connect` to prevent sessionId theft

## License

MIT — see LICENSE.
