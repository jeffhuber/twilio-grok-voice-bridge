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

The `/media-stream` WebSocket endpoint validates Twilio request signatures using `TWILIO_AUTH_TOKEN`:
- Rejects requests without a valid `X-Twilio-Signature` header
- Requires a `CallSid` (query param) matching a pending/active call created by authenticated `/call`
- Refuses unbound CallSids to prevent attackers from opening free xAI Realtime sessions

This prevents unauthorized WebSocket connections from consuming your xAI credits.

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

Twilio-facing webhook and Media Streams paths validate Twilio signatures instead.

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
| TWILIO_AUTH_TOKEN | Twilio auth token (also used for signature validation) |
| TWILIO_FROM_NUMBER | E.164 Twilio voice number |
| XAI_API_KEY | xAI API key |
| XAI_VOICE | Default TTS voice id (example: ara) |
| PORT | HTTP listen port (default 3000) |
| PUBLIC_HOST | Public hostname for media-stream WSS (no scheme) |
| BRIDGE_API_KEY | **CRITICAL:** Shared secret for operator routes (Bearer or X-Bridge-Key) |
| REQUIRE_BRIDGE_AUTH | Set to `1` to exit on startup if BRIDGE_API_KEY is missing |
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

- **Set BRIDGE_API_KEY** to protect operator routes or restrict access via Cloudflare Access / localhost-only binding.
- **Media Stream WebSocket** validates Twilio signatures and requires bound CallSids to prevent unauthorized xAI session creation.
- **Recording is opt-in** via `ENABLE_RECORDING=1` (default off).
- **AI disclosure is on by default**. Review legal requirements before setting `SKIP_AI_DISCLOSURE=1`.
- Keep Twilio tokens, xAI keys, BRIDGE_API_KEY, and real phone numbers out of git.
- Twilio needs a public WSS URL for Media Streams.

## License

MIT — see LICENSE.
