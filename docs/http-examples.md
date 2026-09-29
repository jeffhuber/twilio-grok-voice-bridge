# HTTP examples

Set BRIDGE=http://127.0.0.1:3000 (or your public base URL).

**Authentication:** If `BRIDGE_API_KEY` is set, include either:
- `Authorization: Bearer <BRIDGE_API_KEY>`, or
- `X-Bridge-Key: <BRIDGE_API_KEY>`

Examples below show the Bearer header.

## POST /call

```
POST {BRIDGE}/call
Content-Type: application/json
Authorization: Bearer <BRIDGE_API_KEY>

{
  "to": "+15555550100",
  "goal": "Book a table for 2 tonight at 7pm, patio if available",
  "style": "restaurant-book",
  "voice": "ara",
  "discloseAi": true,
  "record": false
}
```

`style` is optional. Omit it (or send null or "") to let `STYLE_AUTO_SELECT` choose from the destination. An explicit style wins. An unknown explicit style still falls through to `custom`.

`discloseAi` is an optional boolean. `true` includes the AI disclosure block for this call even when `SKIP_AI_DISCLOSURE` is exactly `1`. `false` omits it only when `ALLOW_PER_CALL_DISCLOSURE_OFF` is exactly `1`. Otherwise the response is 403 and no call is placed. The operator is responsible for leaving the disclosure out. This software does not decide that omitting it is lawful. Some states require all parties to consent before a private call is recorded, including California Penal Code 632 and Washington RCW 9.73.030. In February 2024 the FCC ruled that AI-generated voices are artificial voices under the TCPA. California's bot-disclosure law, Business and Professions Code sections 17940 through 17943, can require a bot to disclose that it is a bot when it communicates with a person in California to encourage a sale or to influence a vote. The effective boolean is returned as `discloseAi` and stored on the session, so `/steer` rebuilds keep it. When `discloseAi: false` is honored, the bridge logs `disclosure=off` with the call SID and no phone number. Any other JSON type is 400:

```json
{ "error": "discloseAi must be a boolean when provided" }
```

`record` is an optional boolean. `true` asks Twilio for dual-channel recording on this call only when `ALLOW_PER_CALL_RECORDING` is exactly `1`, even if `ENABLE_RECORDING` is off. Otherwise the response is 403 and no call is placed. `false` records nothing even when `ENABLE_RECORDING` is exactly `1`. The global default stays off. The operator is responsible for recording. All-party consent rules include California Penal Code 632 and Washington RCW 9.73.030. Other states have their own rules. In February 2024 the FCC ruled that AI-generated voices are artificial voices under the TCPA. When recording is on, Twilio stores the audio in the Twilio account that placed the call. Anyone who can sign in to that account's Console, and any API client with the account credentials, can open the recording and its media URL. The recording stays there until someone deletes it in the Console or with the Twilio Recordings API. This bridge does not delete it. When `record: true` is honored, the bridge logs `recording=on` with the call SID and no phone number. The effective boolean is returned as `record`. Any other JSON type is 400:

```json
{ "error": "record must be a boolean when provided" }
```

`softContinue` is an optional boolean. It overrides the style default. When it is omitted, a private pack's `softContinue` boolean is used if that pack sets one, otherwise soft-continue is off.

The response includes `style`, `softContinue`, `discloseAi`, and `record`.

### Style pack file

Private styles are JSON files in `STYLE_PACKS_DIR`, not fields on `/call`. `templates/style-packs/example-warm-personal.json` is an example only.

```json
{
  "name": "warm-personal",
  "description": "Warm, personal pacing. Example only.",
  "aliases": ["warm"],
  "role": "You are placing a phone call in a warm, personal tone.",
  "coaching": ["Keep turns short.", "Do not invent personal details."],
  "closing": "Thank them and say goodbye.",
  "softContinue": false,
  "softContinuePrompt": "[bridge-continue] Offer one short warm sentence, or finish the call and include [[HANGUP_REQUESTED]]."
}
```

`name` must match `^[a-z0-9][a-z0-9-]{0,39}$`. `role` is required. `coaching` and `closing` are a string or an array of strings. Unknown keys are ignored. A closing or `softContinuePrompt` that does not contain `[[HANGUP_REQUESTED]]` gets the generic hangup-token lines appended. Pack contents are not written to logs. They are sent to xAI as the model instructions for a call that uses the pack. Keep real packs outside the repo, for example in a gitignored `style-packs.local/` directory. Unauthenticated `GET /health` does not list pack names or aliases. It reports `stylePackCount`. A symlink is loaded only when the resolved target is a regular file inside `STYLE_PACKS_DIR`. A symlink that points outside that directory is skipped.


## POST /steer

Each call replaces prior operator coaching. Instructions are rebuilt from the call goal, context, style, private pack text, and the per-call `discloseAi` choice. Earlier steer text is not accumulated.

`respond` defaults to true. `false` updates instructions and does not force a reply. Only a JSON boolean is accepted.

```
POST {BRIDGE}/steer
Content-Type: application/json
Authorization: Bearer <BRIDGE_API_KEY>

{ "callSid": "call-1", "text": "Ask for booth seating instead of patio.", "respond": false }
```

## POST /hangup

```
POST {BRIDGE}/hangup
Content-Type: application/json
Authorization: Bearer <BRIDGE_API_KEY>

{ "callSid": "CAxxxx" }
```

## GET /transcript

```
GET {BRIDGE}/transcript?callSid=CAxxxx
Authorization: Bearer <BRIDGE_API_KEY>
```

## POST /voice

```
POST {BRIDGE}/voice
Content-Type: application/json
Authorization: Bearer <BRIDGE_API_KEY>

{ "callSid": "CAxxxx", "voice": "Eve" }
```
