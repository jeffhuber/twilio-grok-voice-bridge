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
  "to": "+15551234567",
  "goal": "Book a table for 2 tonight at 7pm, patio if available",
  "style": "restaurant-book",
  "voice": "ara"
}
```

## POST /steer

```
POST {BRIDGE}/steer
Content-Type: application/json
Authorization: Bearer <BRIDGE_API_KEY>

{ "callSid": "CAxxxx", "text": "Ask for booth seating instead of patio." }
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
