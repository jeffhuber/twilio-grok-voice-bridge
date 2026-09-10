---
name: Wire Twilio Grok Voice
description: >-
  Use when connecting Twilio outbound voice to xAI Grok Voice for a Grok Bot
  or agent, including Media Streams bridge setup and caller-bot persona.
---

Connect Twilio outbound calling to Grok Voice so a Grok Bot can place, steer, and
hang up voice calls through a small Node bridge.

## Package

- Public repo: https://github.com/jeffhuber/twilio-grok-voice-bridge
- Local scrubbed package (if present): /workspace/twilio-grok-voice-bridge

Read README.md and docs/architecture.md in that package before improvising.

## Steps

1. Copy or clone the package. Work only in the scrubbed package (or a fresh public clone).
   Do not copy secrets from any private live bridge.

2. Configure env from .env.example:
   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER, XAI_API_KEY,
   optional XAI_VOICE, CONTACT_FULL_NAME, CONTACT_MOBILE, BARGE_IN_CONFIRM_MS,
   SOFT_CONTINUE_MS, VOICE_ALIASES (JSON).
   **CRITICAL:** Set BRIDGE_API_KEY for production to protect operator routes.

3. Set PUBLIC_HOST to a hostname Twilio can reach over WSS.

4. Install dependencies and start the server. Confirm GET /health shows publicHostSet true.

5. Smoke-test: use the /call API toward a number you control, read /transcript, try /steer, then /hangup when done.

6. Wire Caller bot persona from templates/caller-bot-persona.md (fill placeholders).
   See templates/styles.md for support / restaurant-book / custom.

## Hard rules

- Never auto-hangup without operator /hangup (hangup token is a request, not a kill switch).
- Never invent contact phone numbers; use env CONTACT_* or ask / refuse.
- Never commit dotenv secrets, tokens, or real personal numbers.

## Hygiene

- No secrets in git; scrub before publishing.
- Public repo: https://github.com/jeffhuber/twilio-grok-voice-bridge
