# Testing HMAC-Based Media Stream Authentication

This document describes how to test the new HMAC-SHA256 signature-based authentication for media streams.

## Overview

The HMAC authentication replaces the previous bearer token approach with cryptographic signatures that are:
- Bound to specific CallSid and timestamp
- Non-replayable (single-use)
- Time-limited (default 5 minutes)
- Require knowledge of `BRIDGE_API_KEY` to forge

## Prerequisites

1. Valid Twilio credentials (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`)
2. Valid xAI API key (`XAI_API_KEY`)
3. Set `BRIDGE_API_KEY` to a strong random value (32+ bytes recommended)
4. Set `PUBLIC_HOST` to a public hostname Twilio can reach
5. Set `REQUIRE_BRIDGE_AUTH=1` to enforce authentication

## Unit Tests (Manual)

### Test 1: HMAC Signature Generation

```javascript
const crypto = require('crypto');

const BRIDGE_API_KEY = 'test-secret-key-32-bytes-long!!';
const callSid = 'CA1234567890abcdef1234567890abcdef';
const timestamp = Date.now();

function generateMediaAuthSignature(callSid, timestamp) {
  const message = `${callSid}:${timestamp}`;
  const hmac = crypto.createHmac('sha256', BRIDGE_API_KEY);
  hmac.update(message);
  return hmac.digest('base64url');
}

const signature = generateMediaAuthSignature(callSid, timestamp);
console.log('Signature:', signature);
console.log('CallSid:', callSid);
console.log('Timestamp:', timestamp);
```

### Test 2: Signature Verification

```javascript
function verifyMediaAuthSignature(callSid, timestamp, signature) {
  const now = Date.now();
  const tsNum = Number(timestamp);
  const MEDIA_AUTH_WINDOW_MS = 300000; // 5 minutes
  
  if (!Number.isFinite(tsNum) || tsNum <= 0) {
    return { valid: false, error: 'invalid timestamp' };
  }
  
  const age = now - tsNum;
  if (age < 0) {
    return { valid: false, error: 'timestamp in future' };
  }
  
  if (age > MEDIA_AUTH_WINDOW_MS) {
    return { valid: false, error: 'timestamp expired' };
  }
  
  const expected = generateMediaAuthSignature(callSid, timestamp);
  
  const sigBuf = Buffer.from(signature, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  
  if (sigBuf.length !== expectedBuf.length) {
    return { valid: false, error: 'signature mismatch' };
  }
  
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return { valid: false, error: 'signature mismatch' };
  }
  
  return { valid: true };
}

// Test valid signature
const result1 = verifyMediaAuthSignature(callSid, timestamp, signature);
console.log('Valid signature:', result1);

// Test invalid signature
const result2 = verifyMediaAuthSignature(callSid, timestamp, 'invalid-signature');
console.log('Invalid signature:', result2);

// Test expired timestamp
const oldTimestamp = Date.now() - 400000; // 6.67 minutes ago
const oldSignature = generateMediaAuthSignature(callSid, oldTimestamp);
const result3 = verifyMediaAuthSignature(callSid, oldTimestamp, oldSignature);
console.log('Expired signature:', result3);
```

## Integration Tests

### Test 3: Place a Call via /call Endpoint

```bash
# Set environment variables
export BRIDGE_API_KEY="your-secret-key-here"
export TWILIO_ACCOUNT_SID="your-twilio-account-sid"
export TWILIO_AUTH_TOKEN="your-twilio-auth-token"
export TWILIO_FROM_NUMBER="+1234567890"
export XAI_API_KEY="your-xai-api-key"
export PUBLIC_HOST="your-public-host.example.com"

# Start the server
npm start

# In another terminal, place a call
curl -X POST http://localhost:3000/call \
  -H "Authorization: Bearer $BRIDGE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "+19876543210",
    "goal": "Test HMAC authentication",
    "context": "This is a test call"
  }'
```

Expected response:
```json
{
  "ok": true,
  "callSid": "CAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "status": "queued",
  "to": "+19876543210",
  "from": "+1234567890",
  "style": "support",
  "softContinue": false,
  "voice": "ara",
  "voiceLabel": "Ara",
  "hangupRequested": false
}
```

### Test 4: Verify TwiML Generation

The bridge will log TwiML generation when Twilio fetches from `/twiml-connect`:

```
[twiml-connect] Generated TwiML callSid=CAxxxxx ts=1234567890
```

Check the server logs for:
1. HMAC signature generation
2. TwiML endpoint hit by Twilio
3. Media stream WebSocket upgrade with signature verification
4. CallSid binding success

### Test 5: Verify WebSocket Upgrade Security

**Positive test:** Legitimate Twilio connection should succeed
- Server logs: `[media-stream] HMAC auth success callSid=CAxxxxx ts=xxxxx`
- Server logs: `[twilio] bound HMAC auth to callSid=CAxxxxx`

**Negative test 1:** Missing auth params
```bash
# Try to connect without auth params
websocat wss://your-public-host.example.com/media-stream
```
Expected: 400 Bad Request

**Negative test 2:** Invalid signature
```bash
# Try to connect with invalid signature
websocat "wss://your-public-host.example.com/media-stream?callSid=CAtest&timestamp=1234567890&signature=invalid"
```
Expected: 403 Forbidden with log: `[media-stream] HMAC verification failed: signature mismatch`

**Negative test 3:** Expired timestamp
```bash
# Generate signature with old timestamp (> 5 minutes ago)
OLD_TS=$(($(date +%s) * 1000 - 400000))
# Try to connect
websocat "wss://your-public-host.example.com/media-stream?callSid=CAtest&timestamp=$OLD_TS&signature=..."
```
Expected: 403 Forbidden with log: `[media-stream] HMAC verification failed: timestamp expired`

**Negative test 4:** Signature reuse
```bash
# Capture a valid signature from logs
# Try to connect twice with the same signature
```
Expected: First connection succeeds, second returns 409 Conflict

### Test 6: End-to-End Call Flow

1. Place a call via POST /call
2. Monitor server logs for:
   ```
   [call] placed sid=CAxxxxx to=+1... style=support twimlUrl=https://...
   [twiml-connect] Generated TwiML callSid=CAxxxxx ts=xxxxx
   [media-stream] HMAC auth success callSid=CAxxxxx ts=xxxxx
   [twilio] media-stream websocket connected
   [twilio] bound HMAC auth to callSid=CAxxxxx streamSid=MZxxxxx style=support
   [grok] connecting model=grok-voice-latest voice=ara
   [grok] open callSid=CAxxxxx
   ```
3. Verify audio flows both ways
4. Check GET /transcript endpoint:
   ```bash
   curl "http://localhost:3000/transcript?callSid=CAxxxxx" \
     -H "Authorization: Bearer $BRIDGE_API_KEY"
   ```
5. Hangup via POST /hangup:
   ```bash
   curl -X POST http://localhost:3000/hangup \
     -H "Authorization: Bearer $BRIDGE_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"callSid":"CAxxxxx"}'
   ```

## Security Verification

### Verify HMAC Binding

1. Extract a valid signature from server logs during a call
2. Try to use it with a different CallSid:
   ```bash
   websocat "wss://host/media-stream?callSid=CAdifferent&timestamp=xxxxx&signature=captured-sig"
   ```
   Expected: 403 Forbidden (signature verification fails because CallSid doesn't match)

### Verify Time-Limited

1. Extract a valid signature from server logs
2. Wait 6 minutes
3. Try to use the signature:
   Expected: 403 Forbidden with `timestamp expired` error

### Verify Single-Use

1. Capture a valid signature
2. Before the legitimate Twilio connection completes, try to connect:
   Expected: 409 Conflict (signature already claimed)

### Verify Constant-Time Comparison

The signature verification uses `crypto.timingSafeEqual` to prevent timing attacks. This is a security property that's hard to test directly but can be verified by code inspection in `verifyMediaAuthSignature()`.

## Expected Behavior

### Before HMAC Auth (Bearer Token)
- ❌ Leaked token + CallSid could be reused multiple times within 2-minute TTL
- ❌ Token itself had no cryptographic binding to CallSid
- ❌ Attacker with leaked URL could replay until expiration

### After HMAC Auth
- ✅ Signature cryptographically bound to CallSid and timestamp
- ✅ Single-use: claimed once, 409 on replay
- ✅ Time-limited: 5-minute window (configurable)
- ✅ Non-forgeable without knowing `BRIDGE_API_KEY`
- ✅ Replay protection even within TTL window

## Common Issues

### Issue: "BRIDGE_API_KEY required for HMAC media auth"
**Cause:** `BRIDGE_API_KEY` is not set
**Fix:** Set `BRIDGE_API_KEY` environment variable

### Issue: "HMAC verification failed: timestamp expired"
**Cause:** Timestamp is older than `MEDIA_AUTH_WINDOW_MS` (default 5 minutes)
**Fix:** Ensure clocks are synchronized; Twilio should connect quickly after TwiML fetch

### Issue: 409 Conflict on media stream connection
**Cause:** Signature already claimed (legitimate or replay attack)
**Fix:** Check server logs for duplicate connection attempts; investigate if unexpected

### Issue: "CallSid parameter mismatch"
**Cause:** TwiML custom parameters don't match URL parameters
**Fix:** Investigate potential parameter injection attempt; check server logs

## Performance Considerations

HMAC-SHA256 is fast (sub-millisecond on modern hardware):
- Signature generation: ~0.1ms per call
- Signature verification: ~0.1ms per WebSocket upgrade
- No noticeable impact on call setup latency

## Conclusion

The HMAC-based authentication provides strong, production-grade security for media stream WebSocket connections. Unlike bearer tokens, HMAC signatures cannot be forged or replayed, even if intercepted, making them suitable for hostile edge environments.
