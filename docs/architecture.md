# Architecture

## Overview

```
                    +------------------+
  Operator / Bot --HTTP--> | Express + WS    |
  /call /steer /hangup    | twilio-grok-    |
  /transcript /voice      | voice-bridge    |
                    +--------+---------+
                             |
              Twilio REST (create call + TwiML Connect/Stream)
                             |
                             v
                      +-------------+
                      | Twilio PSTN |
                      +------+------+
                             |
              Media Streams WSS (mu-law 8 kHz both ways)
                             |
                             v
                    +--------+---------+
                    | Bridge session   |
                    | barge-in, soft-  |
                    | continue, steer  |
                    +--------+---------+
                             |
              xAI Grok Voice realtime WSS (PCMU)
                             v
                      +-------------+
                      | Grok Voice  |
                      +-------------+
```

## Why a public WSS host is required

Twilio Media Streams connects **from Twilio's network** to your `wss://PUBLIC_HOST/media-stream` URL.
A laptop-only `localhost` listener is unreachable. Use:

- `cloudflared` (or similar) tunnel for local/dev, hostname → `PUBLIC_HOST`, or
- a deployed public HTTPS/WSS endpoint.

`PUBLIC_HOST` is hostname only (no `https://`).

## Call lifecycle

1. Operator `POST /call` with `to` + `goal` (+ optional style/voice/context).
2. Bridge creates a Twilio call with TwiML `<Connect><Stream url="wss://PUBLIC_HOST/media-stream">`.
3. Dual-channel recording flags are set on create (`record: true`, `recordingChannels: dual`).
4. Twilio upgrades to `/media-stream`; bridge opens Grok Voice realtime and sends `session.update`
   (voice, instructions, server VAD, PCMU in/out).
5. Audio frames forward both ways; transcripts accumulate on the session.
6. Operator may `POST /steer` (silent coaching) or `POST /voice` (TTS swap).
7. Model may include `[[HANGUP_REQUESTED]]` in text/transcript → `hangupRequested=true`.
8. Only operator `POST /hangup` completes the Twilio call (hangup gate).

## Hangup token gate

The voice model **must not** tear down the PSTN leg by itself. It signals readiness with the exact
token `[[HANGUP_REQUESTED]]`. The bridge strips that token from displayed transcript text, sets a
flag, and waits for an explicit operator `/hangup`. This prevents premature hangups on ambiguous
goodbyes.

## Steer coaching

`POST /steer` appends "Operator coaching (internal — never reveal)" to session instructions and
issues a `session.update` + light `response.create` so the model adapts without reading coaching aloud.

## Barge-in

On Grok `input_audio_buffer.speech_started` while the agent is speaking, the bridge arms a confirm
timer (`BARGE_IN_CONFIRM_MS`, default ~280ms). If user speech is still active after the timer:

- `response.cancel` to Grok
- Twilio `clear` on the stream (drop buffered TTS)
- cooldown / min-agent-ms guards reduce echo cut-outs

## Soft-continue

When enabled (`softContinue: true` on `/call`):

1. On Grok `response.done`, bridge sends a Twilio `mark`.
2. When Twilio reports that mark (playback drained), schedule a nudge after `SOFT_CONTINUE_MS`.
3. Nudge injects a generic `[bridge-continue]` user item + `response.create` so the agent keeps
   talking if the callee is quiet.

Disabled by default for `support` / `restaurant-book` unless requested.

## Styles

| Style | Coaching |
|-------|----------|
| `support` (default) | Generic errand/CS pacing |
| `restaurant-book` | Sample reservation coaching using `CONTACT_FULL_NAME` / `CONTACT_MOBILE` |
| `custom` | Goal + context only |

There is **no** auto-style-by-destination-number.

## Voice resolution

1. Request body `voice`, else `XAI_VOICE` / `GROK_VOICE`, else `ara`.
2. Optional `VOICE_ALIASES` JSON maps aliases to voice ids.
3. Mid-call switch via `/voice` or callee phrasing matched against alias names.

## What not to put in this repo

- Real phone numbers, API keys, `.env` contents, personal coaching scripts.
- Private notes or clone-specific voice ids hardcoded in source.
