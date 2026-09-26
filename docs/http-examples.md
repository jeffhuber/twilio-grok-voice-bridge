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
  "voice": "ara"
}
```

## POST /steer

Each call replaces prior operator coaching. Instructions are rebuilt from the call goal, context, and style; earlier steer text is not accumulated.

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
