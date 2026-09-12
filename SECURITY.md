# Security

## Vulnerability Reporting

If you discover a security vulnerability in this bridge, please report it via [GitHub Security Advisories](https://github.com/jeffhuber/twilio-grok-voice-bridge/security/advisories/new).

## Security Hardening Summary

This bridge implements multiple layers of defense against common attack vectors:

### 1. Operator Route Authentication (BRIDGE_API_KEY)

All control-plane routes (`/call`, `/steer`, `/hangup`, `/voice`, `/transcript`) require authentication via `BRIDGE_API_KEY` using constant-time comparison (`crypto.timingSafeEqual`).

**Required:** Set `BRIDGE_API_KEY` to a strong random secret (32+ bytes) before deploying publicly.

### 2. Media Stream WebSocket Security

**HMAC-SHA256 signatures (NEW):**
- Cryptographically signed authentication using `BRIDGE_API_KEY` as secret
- Signatures computed over `callSid:timestamp`, preventing forgery
- Unforgeable: requires knowledge of `BRIDGE_API_KEY` to generate valid signatures
- Late mint at `/twiml-connect`: signature created only when Twilio fetches TwiML, not at call creation
- CallSid cryptographically bound into MAC
- Time-limited: signatures expire after `MEDIA_AUTH_WINDOW_MS` (default 2 minutes)
- Constant-time comparison uses `crypto.timingSafeEqual` to prevent timing attacks

**Single-use claim (INHERITED from main):**
- Signatures can only be claimed once; duplicate attempts return 409 Conflict
- CallSid binding: expected CallSid is frozen at session creation; mismatches close the WebSocket immediately
- Signature DoS mitigation: unclaimed signatures are restored to pending with preserved TTL to prevent burn loops

**Key improvements over previous bearer token:**
1. **Unforgeability:** Bearer tokens were random; HMAC signatures require secret key
2. **CallSid-in-MAC:** CallSid is cryptographically bound to signature; tampering invalidates it
3. **Late mint:** Signature generated at TwiML fetch time, not call creation (tighter window)
4. **Signature invalidation:** Old signatures invalidated on `/twiml-connect` retry (prevents multi-sig accumulation)

### 3. Session Lifecycle Management

- **Crash containment:** All WebSocket JSON parsing is wrapped with defensive validation; null/malformed frames never crash the process
- **Garbage collection:** Orphan sessions (both WebSockets closed) and sessions exceeding `SESSION_MAX_AGE_MS` (default 2 hours) are automatically cleaned up every 2 minutes
- **One stream per CallSid:** Duplicate active streams for the same CallSid are rejected to prevent resource exhaustion
- **Duplicate start protection:** After CallSid bind, duplicate `start` events are ignored to prevent parameter re-injection

### 4. Dependency Security

- **npm audit:** All known vulnerabilities are resolved via `npm audit fix` or dependency overrides
- **qs override:** Uses `qs@^6.16.0` to patch CVE-2026-82417 (isBuffer DoS) and CVE-2026-82562 (comma-arrayLimit bypass) in express transitive dependencies

## Environment Variables

Sensitive environment variables should never be committed:

- `TWILIO_AUTH_TOKEN`
- `XAI_API_KEY`
- `BRIDGE_API_KEY`

Use `.env` (gitignored) or secret management systems in production.

## Production Deployment Checklist

- [ ] Set `BRIDGE_API_KEY` to a strong random secret
- [ ] Set `REQUIRE_BRIDGE_AUTH=1` to enforce auth on startup
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

**Out of scope:**
- **Twilio account compromise:** If Twilio credentials are stolen, attackers can place calls directly via Twilio API (bypassing this bridge entirely)
- **xAI API key compromise:** Direct xAI Realtime API calls (bypassing Twilio)
- **Network-level attacks:** DDoS, SSL/TLS attacks (mitigate at edge/load balancer)

### HMAC vs Bearer Token Security Comparison

**Main branch already had:**
- ✅ Single-use claim (tokens/signatures claimed once, 409 on replay)
- ✅ CallSid binding (session frozen to CallSid)
- ✅ DoS mitigation (burned tokens/signatures restored to pending)

**NEW with HMAC (real improvements):**
- ✅ **Unforgeability:** HMAC requires `BRIDGE_API_KEY`; bearer tokens were just random bytes
- ✅ **CallSid-in-MAC:** CallSid cryptographically bound; tampering invalidates signature (bearer had no cryptographic binding)
- ✅ **Late mint:** Signature generated at `/twiml-connect` fetch, not call creation (tighter window)
- ✅ **Signature invalidation:** Old signatures dropped on retry; bearer approach accumulated multiple valid tokens on retry
- ✅ **X-Twilio-Signature validation:** `/twiml-connect` protected against sessionId theft (when `TWILIO_AUTH_TOKEN` set)

**Both approaches share:**
- ⚠️ Stolen URL + forged `start.callSid` can bind within TTL (single-use only)
- ⚠️ Require `BRIDGE_API_KEY` / secret key for security
- ⚠️ In-memory state (sticky/single-node deployment required)

## Known Limitations

- This bridge is a proof-of-concept; it is not production-hardened out of the box
- Rate limiting is not implemented; add rate limiting at the reverse proxy level
- DDoS protection should be handled by your edge (Cloudflare, AWS Shield, etc.)
- No intrusion detection; monitor logs for anomalies
- `BRIDGE_API_KEY` serves dual purposes (HTTP auth + HMAC signing); consider separate keys for defense in depth

## Audit History

| Date | Version | Changes |
|------|---------|---------|
| 2026-09-12 | HMAC Auth | Replaced bearer token with HMAC-SHA256 signature-based media stream auth; cryptographic binding to CallSid+timestamp; non-replayable signatures |
| 2026-09-11 | Batch B | Crash containment, session GC, qs audit fix, duplicate stream prevention |
| 2026-09-10 | Batch A | CallSid bind, token claim, BRIDGE_API_KEY auth |
| 2026-09-09 | Initial | Proof-of-concept public release |
