# Call styles

Pass `style` on `POST /call` (also forwarded as a short TwiML custom parameter).

## support (default)

Professional errand / customer-support pacing.

- Wait through IVR and hold; do not babble over hold music.
- Concise, clear, lightly energetic delivery.
- Soft-continue **off** unless you set `softContinue: true`.
- Universal speech manners apply (no English vocative man/dude/bro/buddy).

## restaurant-book (sample)

Sample reservation coaching for booking dinner.

- Natural opener (person booking dinner — not "customer support").
- Contact details come from env:
  - `CONTACT_FULL_NAME` — name on the reservation (spell if asked)
  - `CONTACT_MOBILE` — only if the restaurant asks for a callback number
- If those env vars are unset, the model is instructed to **ask / refuse inventing** numbers and names.
- Soft-continue off by default.
- After confirm or clear failure: goodbye + `[[HANGUP_REQUESTED]]`.

Replace the sample with your own coaching via `style=custom` + rich `goal`/`context`, or by
forking the coaching strings in `src/server.js`.

## custom

Goal + context only — no built-in personal coaching beyond universal speech rules and hangup token.

Use when the Caller bot supplies all domain instructions in `goal` / `context`.

## softContinue (request flag, not a style)

Set `"softContinue": true` on `/call` to enable post-playback soft-continue nudges
(after Twilio mark / drain). Generic continue prompt — not tied to any personal style.
