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
2. The bridge generates HMAC-SHA256 signature: `HMAC(BRIDGE_API_KEY, callSid:timestamp)`
3. The signature, CallSid, and timestamp are embedded in the Media Stream URL: `wss://HOST/media-stream?callSid=...&timestamp=...&signature=...`
4. These parameters are also passed as TwiML custom parameters for defense-in-depth verification
5. On WebSocket upgrade, the bridge:
   - Verifies the HMAC signature using constant-time comparison
   - Checks timestamp is within `MEDIA_AUTH_WINDOW_MS` (default 2 minutes)
   - Ensures the signature hasn't been claimed before (prevents replay)
   - Validates CallSid matches the pending session
6. **Signature claim:** On upgrade, the signature is atomically moved from pending to claimed state. Second upgrade attempts with the same signature are rejected with 409 Conflict.
7. On Twilio's `start` event, the bridge verifies:
   - CallSid from Twilio matches the URL CallSid
   - Custom parameters match URL parameters (prevents parameter injection)
8. Only after HMAC verification + CallSid binding succeeds does the bridge open the xAI Realtime WebSocket

**This prevents:**
- **Replay attacks:** Signatures are single-use and time-limited (default 2 minutes)
- **Token leakage:** Even if a signature is intercepted, it's bound to a specific CallSid and timestamp
- **Bearer token weakness:** Unlike bare tokens, HMAC signatures cannot be forged without knowing `BRIDGE_API_KEY`
- **CallSid forgery:** Signature verification fails if CallSid is tampered with
- **Parameter injection:** Custom parameters are cross-checked against URL parameters
- **Signature burn DoS:** Claimed signatures that close before CallSid bind are restored to pending with preserved TTL

**Signature verification:**
- HMAC-SHA256 signature over `callSid:timestamp` using `BRIDGE_API_KEY` as secret
- Constant-time comparison prevents timing attacks
- Timestamp must be within `MEDIA_AUTH_WINDOW_MS` (default 2 minutes)
- Signatures are single-use (claimed atomically on upgrade)
- Old signatures invalidated on `/twiml-connect` retry (prevents multi-sig accumulation)

**Security properties:**
- **Strong binding:** Signature is cryptographically bound to CallSid and timestamp
- **Non-replayable:** Each call gets a unique signature; replays fail even within TTL
- **Time-limited:** Timestamps expire after `MEDIA_AUTH_WINDOW_MS`
- **No bearer tokens:** Cannot be used without knowing the secret key

**Note:** This HMAC-based approach provides production-grade security for hostile edge environments. The signature cannot be forged or reused, and leaked credentials only work for the specific CallSid + timestamp they were generated for, within the expiration window.

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
- **REQUIRE_BRIDGE_AUTH=1 + no key:** server exits on startup.
- **No key, no REQUIRE flag:** server starts with a loud warning; operator routes are OPEN (dev/localhost only).

### Recording and Disclosure

- **Recording** is **opt-in only** (default off). Set `ENABLE_RECORDING=1` to enable dual-channel call recording.
- **AI disclosure** is **on by default**. The agent is instructed to disclose it is AI at the start of calls. Set `SKIP_AI_DISCLOSURE=1` to disable (review legal requirements in your jurisdiction first).

### Production deployment

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
| REQUIRE_BRIDGE_AUTH | Set to `1` to exit on startup if BRIDGE_API_KEY is missing |
| MEDIA_AUTH_WINDOW_MS | HMAC signature validity window in milliseconds (default 120000 = 2 minutes) |
| SESSION_MAX_AGE_MS | Maximum session age before GC in milliseconds (default 7200000 = 2 hours) |
| ENABLE_RECORDING | Set to `1` to enable dual-channel call recording (default off) |
| SKIP_AI_DISCLOSURE | Set to `1` to disable AI disclosure (default: disclosure enabled; check legal requirements first) |
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
- **Media Stream WebSocket** uses HMAC-SHA256 signature authentication (not bearer tokens) for strong security. Signatures are cryptographically bound to CallSid + timestamp.
- **X-Twilio-Signature validation**: Set `TWILIO_AUTH_TOKEN` to enable signature validation on `/twiml-connect` (prevents sessionId theft).
- **Recording is opt-in** via `ENABLE_RECORDING=1` (default off).
- **AI disclosure is on by default**. Review legal requirements before setting `SKIP_AI_DISCLOSURE=1`.
- Keep Twilio tokens, xAI keys, BRIDGE_API_KEY, and real phone numbers out of git.
- Twilio needs a public WSS URL for Media Streams.

## Deployment requirements

- **BRIDGE_API_KEY must be set**: Required for HMAC signing; calls fail without it
- **Sticky/single-node required**: In-memory pending session state; load balancer must route all requests from same call to same server
- **HTTPS/WSS required**: Twilio Media Streams require secure WebSocket connections
- **TWILIO_AUTH_TOKEN recommended**: Enables X-Twilio-Signature validation on `/twiml-connect` to prevent sessionId theft

## License

MIT — see LICENSE.
