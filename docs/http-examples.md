# HTTP examples

Set BRIDGE=http://127.0.0.1:3000 (or your public base URL).

## POST /call

```
POST {BRIDGE}/call
Content-Type: application/json

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

{ "callSid": "CAxxxx", "text": "Ask for booth seating instead of patio." }
```

## POST /hangup

```
POST {BRIDGE}/hangup
Content-Type: application/json

{ "callSid": "CAxxxx" }
```

## GET /transcript

```
GET {BRIDGE}/transcript?callSid=CAxxxx
```

## POST /voice

```
POST {BRIDGE}/voice
Content-Type: application/json

{ "callSid": "CAxxxx", "voice": "Eve" }
```
