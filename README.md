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

The `/media-stream` WebSocket endpoint checks an HMAC-SHA256 signature on the Twilio `start` event. The socket is unauthenticated until that event binds.

**How it works:**
1. When `/call` is invoked, Twilio fetches TwiML from the `/twiml-connect` endpoint
2. The bridge generates HMAC-SHA256 signature: `HMAC(BRIDGE_API_KEY, callSid:timestamp)`
3. The `<Stream url>` is the bare path `wss://HOST/media-stream` with no query string. Twilio error [31920](https://www.twilio.com/docs/api/errors/31920) rejects Stream URLs that include a query string.
4. `callSid`, `timestamp`, and `signature` are `<Parameter>` values. Twilio delivers them on the start message as `start.customParameters` ([WebSocket messages](https://www.twilio.com/docs/voice/media-streams/websocket-messages)).
5. The WebSocket upgrade accepts `/media-stream` without reading auth from the query string. Until `start` binds, the socket is unauthenticated. Messages are limited to 64 KiB. One Twilio `connected` event is ignored. Any other frame before `start` closes the socket with 1008, and a socket with no bound `start` within 5 seconds is closed with 1008. Each of those pre-bind closes is followed by `terminate` about 1 second later if the peer does not finish the close handshake, so a silent client cannot hold a waiting slot for the 30 second handshake timeout. At most 4 unbound sockets are accepted per client, and at most 32 unbound sockets at once. When that global cap is full, the oldest unbound socket is evicted instead of refusing the new one. The per-client key is `CF-Connecting-IP` only when the TCP peer is loopback (cloudflared on this host; every tunneled socket would otherwise be `127.0.0.1`). Any other peer is keyed by its remote address, and a `CF-Connecting-IP` header on those connections is ignored. IPv6 clients are keyed by the /64 prefix. When `TWILIO_AUTH_TOKEN` is set, an upgrade with a valid `X-Twilio-Signature` leaves the unsigned pool and is counted in a separate pool of 8 unbound sockets per client and 128 globally. That signature is static for the host and does not expire, so a leaked header is not an unlimited exemption. A leaked signature sent from 16 or more client addresses can fill that global pool of 128. The next signed socket then evicts the oldest unbound signed socket, which can be a Twilio stream that has not sent `start` yet. If the signature leaks, rotate `TWILIO_AUTH_TOKEN`. A full signed pool evicts the oldest unbound signed socket and does not evict unsigned sockets or a socket that has already bound. A signature header that is present but does not validate is logged at most once per second, without the header value, and that socket stays in the unsigned pool. Pre-bind warnings, `media start rejected`, and `ws error` are each logged at most once per second and do not include the client event name. Put rate limiting in front of this process as well (Cloudflare or another edge). The in-process caps are not a substitute for that.
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
- **Forged signatures:** HMAC signatures cannot be forged without knowing `BRIDGE_API_KEY`
- **CallSid forgery:** Signature verification fails if CallSid is tampered with
- **Parameter injection:** `start.callSid` must match the signed `callSid` parameter and the pending session. Goal, context, and voice are not taken from the start event.
- **Unauthenticated sockets:** Oversized frames, extra waiting sockets from one client, non-start frames, and a missing `start` are closed and then terminated. A full global waiting list evicts the oldest unbound socket in that pool. A valid `X-Twilio-Signature` uses a separate pool (8 per client, 128 global) because the signature does not expire. Edge rate limiting is still required

**Signature verification:**
- HMAC-SHA256 signature over `callSid:timestamp` using `BRIDGE_API_KEY` as secret
- Constant-time comparison prevents timing attacks
- Timestamp must be within `MEDIA_AUTH_WINDOW_MS` (default 2 minutes)
- Signatures are single-use (claimed when the start event is accepted; a second start with the same signature is rejected)
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

- **Recording** is **opt-in only** (default off). Set `ENABLE_RECORDING=1` to enable dual-channel call recording.
- **AI disclosure** is **on by default**. The agent is instructed to disclose it is AI at the start of calls. Set `SKIP_AI_DISCLOSURE=1` to disable (review legal requirements in your jurisdiction first).

### Public deployment

For public hosts, **always** use one of:
1. Set `BRIDGE_API_KEY` to a strong secret
2. Put the server behind Cloudflare Access or equivalent
3. Bind to localhost only and access via tunnel

**Do NOT** deploy this bridge publicly without authentication.

## Environment table

| Variable | Purpose |
|----------|---------|
| TWILIO_ACCOUNT_SID | Twilio account SID |
| TWILIO_AUTH_TOKEN | Twilio auth token |
| TWILIO_FROM_NUMBER | E.164 Twilio voice number |
| XAI_API_KEY | xAI API key |
| XAI_VOICE | Default TTS voice id (example: ara) |
| PORT | HTTP listen port (default 3000) |
| PUBLIC_HOST | Public hostname for media-stream WSS (no scheme) |
| BRIDGE_API_KEY | **REQUIRED:** Shared secret for operator routes (Bearer or X-Bridge-Key) AND HMAC signing key for media stream auth. Without it, `/twiml-connect` returns 500 and calls fail. |
| ALLOW_UNAUTHENTICATED_OPERATOR | Set to `1` to bypass auth when BRIDGE_API_KEY is unset (localhost demos only — never use for shared/public deployments). Server exits on startup if BRIDGE_API_KEY is missing and this is not set. |
| MEDIA_AUTH_WINDOW_MS | HMAC signature validity window in milliseconds (default 120000 = 2 minutes) |
| SESSION_MAX_AGE_MS | Maximum session age before GC in milliseconds (default 7200000 = 2 hours) |
| ENABLE_RECORDING | Set to `1` to enable dual-channel call recording (default off) |
| SKIP_AI_DISCLOSURE | Set to `1` to disable AI disclosure (default: disclosure enabled; check legal requirements first) |
| LOG_TRANSCRIPTS | Set to `1` to enable transcript logging in stdout (default off for privacy; destination phone numbers are masked regardless) |
| CONTACT_FULL_NAME | Optional; restaurant-book style |
| CONTACT_MOBILE | Optional callback number for restaurant-book |
| BARGE_IN_CONFIRM_MS | Barge-in confirm window ms (default 280) |
| SOFT_CONTINUE_MS | Soft-continue delay ms (default 400) |
| VOICE_ALIASES | Optional JSON alias map |

Do not commit a real dotenv file. Use .env.example as the template only.

## Styles

See templates/styles.md: support (default), restaurant-book (sample), custom (goal+context).

Optional softContinue true on POST /call enables post-playback soft-continue.

## Docs

- docs/architecture.md
- docs/http-examples.md — request bodies for call/steer/hangup
- templates/caller-bot-persona.md
- SKILL.md

## Security notes

- **BRIDGE_API_KEY is REQUIRED**: Without it, `/twiml-connect` returns 500 and calls fail. This key serves dual purposes: HTTP auth and HMAC signing.
- **Media Stream WebSocket** checks an HMAC-SHA256 signature on the `start` event. The socket is unauthenticated until that bind. A signature covers a CallSid and timestamp.
- **X-Twilio-Signature validation**: Set `TWILIO_AUTH_TOKEN` to enable signature validation on `/twiml-connect` (prevents sessionId theft).
- **Recording is opt-in** via `ENABLE_RECORDING=1` (default off).
- **AI disclosure is on by default**. Review legal requirements before setting `SKIP_AI_DISCLOSURE=1`.
- **Privacy defaults:** Phone numbers are masked in logs (last 4 digits only), transcript logging is off by default (`LOG_TRANSCRIPTS=0`).
- Keep Twilio tokens, xAI keys, BRIDGE_API_KEY, and real phone numbers out of git.
- Twilio needs a public WSS URL for Media Streams.

## Deployment requirements

- **BRIDGE_API_KEY must be set**: Required for HMAC signing; calls fail without it
- **Sticky/single-node required**: In-memory pending session state means replay protection and session tracking are process-local; load balancers must route all requests from the same call to the same server instance
- **HTTPS/WSS required**: Twilio Media Streams require secure WebSocket connections
- **TWILIO_AUTH_TOKEN recommended**: Enables X-Twilio-Signature validation on `/twiml-connect` to prevent sessionId theft

## License

MIT — see LICENSE.
