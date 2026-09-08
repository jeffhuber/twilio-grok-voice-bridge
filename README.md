# twilio-grok-voice-bridge

**Repo:** https://github.com/jeffhuber/twilio-grok-voice-bridge


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

- Keep Twilio tokens, xAI keys, and real phone numbers out of git.
- Twilio needs a public WSS URL for Media Streams.
- Dual-channel recording is enabled on call create.

## License

MIT — see LICENSE.
