# Call styles

Pass `style` on `POST /call` (also forwarded as a short TwiML custom parameter).

Built-in styles are `support` (default), `restaurant-book`, and `custom`. Private packs loaded from `STYLE_PACKS_DIR` are additional styles. You do not need to edit `src/server.js` to add one.

## support (default)

Professional errand / customer-support pacing.

- The first line stays `You are placing a phone call to handle an errand or customer-support matter.` unless `SUPPORT_ANNOUNCE_CONTACT_NAME` is exactly `1`.
- When that flag is exactly `1` and `CONTACT_FULL_NAME` is set, the first line is: `You are placing a phone call on behalf of <CONTACT_FULL_NAME> to handle an errand or customer-support matter.`
- `CONTACT_FULL_NAME` and `CONTACT_MOBILE` used for restaurant booking are not sent to the model on a support call, including after a voice change, while the flag is off.
- Wait through IVR and hold; do not babble over hold music.
- Concise, clear, lightly energetic delivery.
- Soft-continue off unless you set `softContinue: true`.
- Universal speech manners apply (no English vocative man/dude/bro/buddy).

## restaurant-book (sample)

Sample reservation coaching for booking dinner.

- Natural opener (person booking dinner, not "customer support").
- Contact details come from env:
  - `CONTACT_FULL_NAME`: name on the reservation (spell if asked)
  - `CONTACT_MOBILE`: only if the restaurant asks for a callback number
- If those env vars are unset, the model is instructed to ask or refuse inventing numbers and names.
- Soft-continue off by default.
- After confirm or clear failure: goodbye plus `[[HANGUP_REQUESTED]]`.

Use `style=custom` plus a rich `goal` and `context`, or add a private style pack, when this sample does not fit.

## custom

Goal plus context only. No built-in personal coaching beyond universal speech rules and the hangup token.

Use when the caller bot supplies all domain instructions in `goal` and `context`.

An unknown `style` still resolves to `custom`.

## Private style packs (`STYLE_PACKS_DIR`)

`STYLE_PACKS_DIR` is an optional absolute path outside this repo. A gitignored `style-packs.local/` directory is one place for real packs. At startup the server reads every top-level `*.json` name in that directory, sorted by filename. It does not walk subdirectories. A symlink is loaded only when its resolved target is a regular file inside the pack directory. A symlink that resolves outside the directory is skipped. The log names the file and says the symlink escapes the pack directory. It does not include the target path. A symlink to a directory is not walked. A broken symlink is skipped. Pack text is not written to logs. It is sent to xAI as the model instructions for a call that uses the pack.

`GET /health` is unauthenticated. `styles` lists only `support`, `restaurant-book`, and `custom`. Pack names and aliases are omitted. `stylePackCount` is the number of packs that loaded.

A missing or unreadable directory logs one warning and the server still starts. A file that is invalid, or that reuses a built-in name or alias (`support`, `cs`, `errand`, `restaurant-book`, `restaurant`, `reservation`, `booking`, `custom`, `goal-only`, `bare`) or another pack's name or alias, is skipped. The warning names the file and the reason. It does not print the file contents. Unknown keys are ignored.

Loaded pack names are added to the style list on `GET /health`. Aliases are not listed there. `normalizeStyle()` resolves a pack name or alias. Names that are still unknown fall through to `custom`.

`templates/style-packs/example-warm-personal.json` is an example only. Copy it if you want a starting point. It is not active unless `STYLE_PACKS_DIR` points at a directory that contains it. Do not commit real names, phone numbers, or private coaching.

Schema:

```json
{
  "name": "warm-personal",
  "description": "short text",
  "aliases": ["warm"],
  "role": "You are placing a phone call in a warm, personal tone.",
  "coaching": ["Keep turns short.", "Do not invent personal details."],
  "closing": "Thank them and say goodbye.",
  "softContinue": false,
  "softContinuePrompt": "[bridge-continue] Offer one short warm sentence, or finish the call and include [[HANGUP_REQUESTED]]."
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Matches `^[a-z0-9][a-z0-9-]{0,39}$`. This is the style id. |
| `description` | no | Short text stored as the style profile description. |
| `aliases` | no | Extra names that normalize to this style. |
| `role` | yes | Non-empty string. Opening lines of the instructions. |
| `coaching` | no | String, or an array of strings joined with newlines. |
| `closing` | no | Replaces the generic custom closing. If it does not contain `[[HANGUP_REQUESTED]]`, the generic hangup-token lines are appended. |
| `softContinue` | no | Boolean default when `/call` omits `softContinue`. |
| `softContinuePrompt` | no | Replaces the generic `[bridge-continue]` nudge for this style. If it does not contain `[[HANGUP_REQUESTED]]`, the same generic hangup-token lines used for closings are appended. |

Pack instructions are: role, `Your goal for this call: <goal>`, the context block, a blank line, coaching, a blank line, the universal speech rules, the AI disclosure block, a blank line, `Never mention that you are being coached or that an operator is listening.`, a blank line, then the closing. Per-call `discloseAi` controls the disclosure block the same way it does for built-in styles. `/steer` rebuilds this text.

## `STYLE_AUTO_SELECT`

Optional JSON object mapping an E.164 `to` number to a style name, for example `{"+15555550100":"warm-personal"}`.

Used only when `POST /call` omits `style` (null or empty). Whitespace in the configured key is stripped, then the key must be E.164, the same check as `to` (`+` and 2 to 15 digits). Any other key is dropped with a masked warning. An explicit `style` on the request wins. Entries whose style is not a known built-in or pack (including aliases) are dropped at startup. Invalid JSON is ignored. Numbers are not written to logs. `GET /health` includes `styleAutoSelectCount` only.

## softContinue (request flag, not a style)

A JSON boolean `softContinue` on `/call` overrides the style default. `true` enables post-playback soft-continue nudges (after Twilio mark / drain). `false` disables them. If the field is omitted, or is not a boolean, the pack's `softContinue` value is used when that pack sets a boolean. Otherwise soft-continue stays off.

VAD uses the soft thresholds when the effective value is true, and the normal thresholds when it is false.

When the session's pack sets `softContinuePrompt`, that text replaces the generic `[bridge-continue]` nudge. If that text does not contain `[[HANGUP_REQUESTED]]`, the generic hangup-token lines are appended.
