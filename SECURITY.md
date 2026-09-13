# Security

## Vulnerability Reporting

If you discover a security vulnerability in this bridge, please report it via [GitHub Security Advisories](https://github.com/jeffhuber/twilio-grok-voice-bridge/security/advisories/new).

## Security Hardening Summary

This bridge implements multiple layers of defense against common attack vectors:

### 1. Operator Route Authentication (BRIDGE_API_KEY)

All control-plane routes (`/call`, `/steer`, `/hangup`, `/voice`, `/transcript`) require authentication via `BRIDGE_API_KEY` using constant-time comparison (`crypto.timingSafeEqual`).

**Required:** Set `BRIDGE_API_KEY` to a strong random secret (32+ bytes) before deploying publicly.

**Fail-closed by default:** If `BRIDGE_API_KEY` is not set, the server exits on startup unless the explicit escape hatch `ALLOW_UNAUTHENTICATED_OPERATOR=1` is set. The escape hatch is intended ONLY for localhost demos and displays loud security warnings on startup. Never deploy publicly with `ALLOW_UNAUTHENTICATED_OPERATOR=1`.

### 2. Media Stream WebSocket Security

**HMAC-SHA256 signature authentication:**
- Cryptographically signed authentication using `BRIDGE_API_KEY` as secret
- Signatures computed over `callSid:timestamp`, preventing forgery
- Unforgeable: requires knowledge of `BRIDGE_API_KEY` to generate valid signatures
- Signature generated at `/twiml-connect` when Twilio fetches TwiML
- CallSid cryptographically bound into MAC
- Time-limited: signatures expire after `MEDIA_AUTH_WINDOW_MS` (default 2 minutes)
- Constant-time comparison uses `crypto.timingSafeEqual` to prevent timing attacks

**Single-use claim:**
- Signatures can only be claimed once; duplicate attempts return 409 Conflict
- CallSid binding: expected CallSid is frozen at session creation; mismatches close the WebSocket immediately
- Signature DoS mitigation: unclaimed signatures are restored to pending with preserved TTL to prevent burn loops

### 5. Session Lifecycle Management

- **Crash containment:** All WebSocket JSON parsing is wrapped with defensive validation; null/malformed frames never crash the process
- **Garbage collection:** Orphan sessions (both WebSockets closed) and sessions exceeding `SESSION_MAX_AGE_MS` (default 2 hours) are automatically cleaned up every 2 minutes
- **One stream per CallSid:** Duplicate active streams for the same CallSid are rejected to prevent resource exhaustion
- **Duplicate start protection:** After CallSid bind, duplicate `start` events are ignored to prevent parameter re-injection

### 4. Body Parser Error Handling

**Filesystem path leak prevention:**
- Body parsing runs before authentication middleware (Express architectural constraint)
- All body-parser errors (malformed JSON, encoding errors, oversized payloads) are caught by custom error middleware
- Returns safe JSON responses without exposing filesystem paths, stack traces, or HTML error pages
- Production-safe Express configuration (`app.set('env', 'production')`) prevents default error page leakage
- `x-powered-by` header disabled to avoid version disclosure

**Error responses:**
- Malformed JSON/urlencoded body → `400 {"error": "invalid request body"}`
- Oversized payload → `413 {"error": "payload too large"}`
- Unexpected errors → `500 {"error": "internal server error"}`

**Testing:** Run `scripts/test-body-parser-safety.sh` to verify body-parser errors don't leak paths.

### 5. Dependency Security

- **npm audit:** All known vulnerabilities are resolved via `npm audit fix` or dependency overrides
- **qs override:** Uses `qs@^6.16.0` to patch CVE-2026-82417 (isBuffer DoS) and CVE-2026-82562 (comma-arrayLimit bypass) in express transitive dependencies

## Environment Variables

Sensitive environment variables should never be committed:

- `TWILIO_AUTH_TOKEN`
- `XAI_API_KEY`
- `BRIDGE_API_KEY`

Use `.env` (gitignored) or secret management systems in production.

## Production Deployment Checklist

- [ ] Set `BRIDGE_API_KEY` to a strong random secret (required - server exits on startup without it)
- [ ] Ensure `ALLOW_UNAUTHENTICATED_OPERATOR` is NOT set (fail-closed by default; only use `=1` for localhost demos)
- [ ] Enable HTTPS/WSS (Twilio Media Streams require WSS)
- [ ] Configure `SESSION_MAX_AGE_MS` for your use case (default 2 hours)
- [ ] Review AI disclosure requirements for your jurisdiction
- [ ] Enable recording only if required (`ENABLE_RECORDING=1`) and comply with consent laws
- [ ] Use Cloudflare Access, VPN, or IP allowlists for additional access control
- [ ] Monitor logs for suspicious activity (token reuse, CallSid mismatches, parse errors)

## Threat Model & Residual Risks

### What HMAC Media Auth Protects Against

- **Stolen/leaked URLs within TTL:** Even if a media stream URL is intercepted, the HMAC signature is bound to the CallSid and cannot be reused for other calls
- **Replay attacks:** Signatures are single-use and expire after `MEDIA_AUTH_WINDOW_MS`
- **Parameter tampering:** CallSid and timestamp are cryptographically signed; modifications invalidate the signature
- **Unauthorized xAI credit consumption:** Only calls initiated via authenticated `/call` endpoint can open xAI Realtime sessions

### Residual Risks

**Within-TTL attacks (LOW-MEDIUM impact):**

*Scenario 1: Stolen URL + forged `start.callSid`*
- If an attacker captures the media stream URL (callSid + timestamp + signature from query string)
- AND forges a Twilio Media Stream `start` event with matching `start.callSid` from the URL query
- The attacker can bind to the session within `MEDIA_AUTH_WINDOW_MS` (default 2 minutes)
- **Impact:** Single connection to xAI Realtime for that specific CallSid
- **Why this works:** WebSocket upgrade validates signature + CallSid from URL, but `start` event CallSid comes from Twilio's JSON payload (which attacker can forge if they have the URL)
- **Mitigations:**
  - Single-use claim (second connection → 409)
  - Short TTL (default 2 minutes)
  - Signature tied to specific CallSid (cannot transfer to other calls)
  - DoS mitigation: burned signatures restored for legitimate connection if not yet bound

*Scenario 2: `/twiml-connect` sessionId leak*
- If `sessionId` query parameter is leaked before Twilio fetches TwiML
- AND attacker can reach `/twiml-connect` (no `X-Twilio-Signature` validation if `TWILIO_AUTH_TOKEN` not set)
- Attacker can fetch TwiML and obtain valid media stream URL
- **Mitigations:**
  - Enable X-Twilio-Signature validation by setting `TWILIO_AUTH_TOKEN` (now implemented)
  - Short window: `sessionId` only valid between call creation and first Twilio fetch
  - Old signatures invalidated on retry
  
**Operator route compromise:**
- If `BRIDGE_API_KEY` is compromised, an attacker can:
  - Place calls via `/call` endpoint (spending Twilio account)
  - Generate valid HMAC signatures for media streams
- **Mitigations:**
  - Rotate `BRIDGE_API_KEY` immediately if compromised
  - Use strong random keys (32+ bytes)
  - Monitor Twilio billing for unexpected usage
  - Add additional controls: IP allowlists, Cloudflare Access, etc.

**Operator/bridge logs contain call metadata and transcript snippets:**
- Bridge stdout logs include destination numbers (`to=`) and partial transcript content (~120 chars per log line) for operational visibility
- **Risk:** Pasting bridge or Twilio operator logs into public channels (chat, gist, GitHub issues) leaks:
  - Call destination numbers
  - Portions of conversation transcripts (PII, PHI, or sensitive content)
- **Mitigations:**
  - Do not paste raw operator/bridge/Twilio logs into public or semi-public channels
  - Redact `to=` and transcript fields before sharing logs
  - Use private support channels or direct communications when sharing diagnostic output

**Out of scope:**
- **Twilio account compromise:** If Twilio credentials are stolen, attackers can place calls directly via Twilio API (bypassing this bridge entirely)
- **xAI API key compromise:** Direct xAI Realtime API calls (bypassing Twilio)
- **Network-level attacks:** DDoS, SSL/TLS attacks (mitigate at edge/load balancer)

### Security Properties

The HMAC-based authentication provides:
- ✅ **Unforgeability:** Signatures cannot be generated without `BRIDGE_API_KEY`
- ✅ **Cryptographic binding:** CallSid is bound into the signature; tampering invalidates it
- ✅ **Time-limited:** Signatures expire after `MEDIA_AUTH_WINDOW_MS` (default 2 minutes)
- ✅ **Single-use:** Signatures can only be claimed once
- ✅ **X-Twilio-Signature validation:** `/twiml-connect` protected when `TWILIO_AUTH_TOKEN` is set

**Deployment requirements:**
- Requires `BRIDGE_API_KEY` to be set for signature generation
- Sticky/single-node deployment required (in-memory state)
- HTTPS/WSS required for Twilio Media Streams

## Known Limitations

- This bridge is a proof-of-concept; it is not production-hardened out of the box
- Rate limiting is not implemented; add rate limiting at the reverse proxy level
- DDoS protection should be handled by your edge (Cloudflare, AWS Shield, etc.)
- No intrusion detection; monitor logs for anomalies
- `BRIDGE_API_KEY` serves dual purposes (HTTP auth + HMAC signing); consider separate keys for defense in depth

## Audit History

| Date | Version | Changes |
|------|---------|---------|
| 2026-09-13 | v1.3 | Body-parser error handling hardening: prevent filesystem path leakage on malformed JSON |
| 2026-09-12 | v1.2 | HMAC-SHA256 signature-based media stream auth with cryptographic CallSid binding |
| 2026-09-11 | v1.1 | Crash containment, session GC, qs audit fix, duplicate stream prevention |
| 2026-09-10 | v1.0 | Initial security hardening: CallSid bind, signature claim, BRIDGE_API_KEY auth |
| 2026-09-09 | v0.1 | Proof-of-concept public release |
