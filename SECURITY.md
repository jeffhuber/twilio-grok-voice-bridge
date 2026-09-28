# Security

## Vulnerability Reporting

If you discover a security vulnerability in this bridge, please report it via [GitHub Security Advisories](https://github.com/jeffhuber/twilio-grok-voice-bridge/security/advisories/new).

## Security Hardening Summary

This bridge implements multiple layers of defense against common attack vectors:

### 1. Operator Route Authentication (BRIDGE_API_KEY)

All control-plane routes (`/call`, `/steer`, `/hangup`, `/voice`, `/transcript`) require authentication via `BRIDGE_API_KEY` using constant-time comparison (`crypto.timingSafeEqual`).

**Required:** Set `BRIDGE_API_KEY` to a strong random secret (32+ bytes) before deploying publicly.

**Fail-closed by default:** If `BRIDGE_API_KEY` is not set, the server exits on startup unless the explicit escape hatch `ALLOW_UNAUTHENTICATED_OPERATOR=1` is set. The escape hatch is intended ONLY for localhost demos and displays loud security warnings on startup. Never deploy publicly with `ALLOW_UNAUTHENTICATED_OPERATOR=1`. The process listens on all interfaces, so that escape hatch leaves `/call`, `/steer`, `/hangup`, and `/transcript` reachable by anyone who can reach the host. It does not enable media HMAC: signatures are not minted or verified unless `BRIDGE_API_KEY` is set, even when `MEDIA_STREAM_SECRET` is set. Calls therefore cannot complete the media handshake in open mode.

### 2. Media Stream WebSocket Security

**HMAC-SHA256 signature authentication:**
- Cryptographically signed authentication. Both keys are read once at startup. The HMAC key is `MEDIA_STREAM_SECRET` when that value is non-empty after trimming and `BRIDGE_API_KEY` is set; otherwise it is `BRIDGE_API_KEY`. `MEDIA_STREAM_SECRET` alone is not enough: mint and verify both refuse when `BRIDGE_API_KEY` is unset. A non-empty `BRIDGE_API_KEY` or `MEDIA_STREAM_SECRET` shorter than 32 bytes logs a startup warning that does not print the secret, and is still accepted. An empty key does not log that short-key warning.
- Signatures computed over `callSid:timestamp`, preventing forgery
- Unforgeable: requires knowledge of that HMAC key to generate valid signatures
- Signature generated at `/twiml-connect` when Twilio fetches TwiML
- CallSid cryptographically bound into MAC
- Time-limited: signatures expire after `MEDIA_AUTH_WINDOW_MS` (default 2 minutes)
- Constant-time comparison uses `crypto.timingSafeEqual` to prevent timing attacks

**Single-use claim:**
- Signatures can only be claimed once; a second start with the same signature is rejected and the socket is closed
- CallSid binding: `start.callSid` must match the signed parameter; mismatches close the WebSocket
- The socket is unauthenticated until `start`. Frames are capped at 64 KiB. One client may hold at most 4 unbound sockets, and the process at most 32. A full global list evicts the oldest unbound socket in that pool. The per-client key is `CF-Connecting-IP` only for a loopback peer (the local tunnel); otherwise it is the remote address. IPv6 clients are keyed by the /64 prefix. A valid `X-Twilio-Signature` is not unlimited: it uses a separate pool of 8 unbound sockets per client and 128 globally, and a full signed pool evicts the oldest unbound signed socket. The signature is static for the host. A header that is present but fails validation is logged at most once per second, without the header value, and the socket stays in the unsigned pool. A non-start frame other than one `connected` event closes the socket, and a missing `start` closes it after 5 seconds. Pre-bind closes terminate after about 1 second if the handshake is not finished. A consumed signature is not put back. Rate limit this path at the edge as well

### 3. Session Lifecycle Management

- **Crash containment:** All WebSocket JSON parsing is wrapped with defensive validation; null/malformed frames never crash the process
- **Garbage collection:** Orphan sessions (both WebSockets closed) and sessions exceeding `SESSION_MAX_AGE_MS` (default 2 hours) are automatically cleaned up every 2 minutes
- **One stream per CallSid:** Duplicate active streams for the same CallSid are rejected to prevent resource exhaustion
- **Duplicate start protection:** After CallSid bind, duplicate `start` events are ignored to prevent parameter re-injection

### 4. Body Parser Error Handling

**Filesystem path leak prevention:**
- Body parsing runs before authentication middleware (Express architectural constraint)
- All body-parser errors (malformed JSON, encoding errors, oversized payloads) are caught by custom error middleware
- Returns safe JSON responses without exposing filesystem paths, stack traces, or HTML error pages
- Hardened Express configuration (`app.set('env', 'production')`) prevents default error page leakage
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
- `MEDIA_STREAM_SECRET` (dedicated media HMAC key only when `BRIDGE_API_KEY` is also set; ignored for mint and verify when the operator key is unset)

Use `.env` (gitignored) or secret management systems for deployments.

## Spending and Rate Controls

**Operator responsibility:**
- This bridge does NOT implement rate limiting or spending caps for Twilio calls or xAI API usage
- **Twilio:** Configure billing alerts and rate limits in the [Twilio Console](https://console.twilio.com) under Account → Usage → Alerts
- **xAI:** Monitor API usage and set up alerts through your xAI dashboard or billing settings
- For shared or public deployments, consider adding:
  - IP allowlists or VPN-only access to operator routes
  - Additional middleware for per-user or per-hour call limits
  - Budget alerting via cloud provider notifications (AWS Budget, GCP Billing Alerts, etc.)

## Deployment Checklist

- [ ] Set `BRIDGE_API_KEY` to a strong random secret (required - server exits on startup without it)
- [ ] Ensure `ALLOW_UNAUTHENTICATED_OPERATOR` is NOT set (fail-closed by default; only use `=1` for localhost demos)
- [ ] Enable HTTPS/WSS (Twilio Media Streams require WSS)
- [ ] Configure `SESSION_MAX_AGE_MS` for your use case (default 2 hours)
- [ ] Review AI disclosure requirements for your jurisdiction
- [ ] Enable recording only if required (`ENABLE_RECORDING=1`, or per-call `record: true`) and comply with consent laws
- [ ] Keep `LOG_TRANSCRIPTS` disabled (default) unless actively debugging
- [ ] Use Cloudflare Access, VPN, or IP allowlists for additional access control
- [ ] Configure Twilio billing alerts and rate limits in Twilio Console
- [ ] Monitor logs for suspicious activity (token reuse, CallSid mismatches, parse errors)

## Threat Model & Residual Risks

### What HMAC Media Auth Protects Against

- **Stolen/leaked URLs within TTL:** Even if a media stream URL is intercepted, the HMAC signature is bound to the CallSid and cannot be reused for other calls
- **Replay attacks:** Signatures are single-use and expire after `MEDIA_AUTH_WINDOW_MS`
- **Parameter tampering:** CallSid and timestamp are cryptographically signed; modifications invalidate the signature
- **Unauthorized xAI credit consumption:** Only calls initiated via authenticated `/call` endpoint can open xAI Realtime sessions

### Residual Risks

**Within-TTL attacks (LOW-MEDIUM impact):**

*Scenario 1: Captured TwiML parameters racing the real stream*
- The `<Stream url>` has no query string (Twilio error 31920). `callSid`, `timestamp`, and `signature` are `<Parameter>` values. The WebSocket is unauthenticated until `start`, so those captured parameters are enough to open `/media-stream` and send `start` before Twilio does.
- If `start.callSid` and `start.customParameters` match the pending session, the attacker binds that CallSid
- **Impact:** That caller can take the single stream for that CallSid until the signature expires (`MEDIA_AUTH_WINDOW_MS`, default 2 minutes)
- **Mitigations:**
  - The signature is removed from the pending set when `start` is accepted, so a second socket cannot bind with it
  - Short TTL (default 2 minutes)
  - Signature tied to specific CallSid (cannot transfer to other calls)
  - Upgrade does not read auth from the query string
  - Waiting sockets are capped per client and globally, with a separate cap for upgrades that carry a valid `X-Twilio-Signature`. A full list evicts the oldest unbound socket in that pool, and a pre-bind close terminates if the peer does not answer the handshake. Frame size and the time before `start` are capped. Rate limit `/media-stream` at the edge; these caps are not a substitute

*Scenario 2: `/twiml-connect` sessionId leak*
- If `sessionId` query parameter is leaked before Twilio fetches TwiML
- AND attacker can reach `/twiml-connect` (no `X-Twilio-Signature` validation if `TWILIO_AUTH_TOKEN` not set)
- Attacker can fetch TwiML and obtain valid media stream URL
- **Mitigations:**
  - Enable X-Twilio-Signature validation by setting `TWILIO_AUTH_TOKEN` (now implemented)
  - Short window: `sessionId` only valid between call creation and first Twilio fetch
  - Old signatures invalidated on retry
  
**Operator route compromise:**
- If `BRIDGE_API_KEY` is compromised, an attacker can place calls via `/call` (spending the Twilio account) and can mint media HMAC signatures when `MEDIA_STREAM_SECRET` is empty
- If the media HMAC key is compromised (`MEDIA_STREAM_SECRET` when that value is non-empty after trimming and `BRIDGE_API_KEY` is set, otherwise `BRIDGE_API_KEY`), an attacker can generate valid media signatures
- **Mitigations:**
  - Rotate the compromised key immediately. Rotating the HMAC key is a hard cut: signatures already issued fail verification. `MEDIA_STREAM_SECRET` exists so media HMAC can rotate without rotating the operator key; it is not a substitute for setting `BRIDGE_API_KEY`
  - Use strong random keys (32+ bytes). A shorter non-empty `BRIDGE_API_KEY` or `MEDIA_STREAM_SECRET` logs a startup warning and is still accepted. The warning does not print the secret
  - Monitor Twilio billing for unexpected usage
  - Add additional controls: IP allowlists, Cloudflare Access, etc.

**Operator/bridge logs contain call metadata (privacy defaults enabled):**
- **Default privacy protections:**
  - Destination phone numbers are **masked by default** (last 4 digits shown: `xxxx1234`)
  - Transcript content is **not logged by default** (set `LOG_TRANSCRIPTS=1` to enable)
  - Set `LOG_TRANSCRIPTS=1` to explicitly enable transcript logging for debugging
- Bridge stdout logs include masked destination numbers and (when enabled) partial transcript content (~120 chars per log line) for operational visibility
- **Risk:** Pasting bridge or Twilio operator logs into public channels (chat, gist, GitHub issues) may leak:
  - Last 4 digits of call destination numbers (even with masking)
  - Portions of conversation transcripts (PII, PHI, or sensitive content) if `LOG_TRANSCRIPTS=1`
  - Twilio logs (when `ENABLE_RECORDING=1`) contain full phone numbers and audio URLs
- **Mitigations:**
  - Do not paste raw operator/bridge/Twilio logs into public or semi-public channels
  - Redact any remaining phone digits and transcript fields before sharing logs
  - Use private support channels or direct communications when sharing diagnostic output
  - Keep `LOG_TRANSCRIPTS` disabled (default) unless actively debugging
  - Review Twilio logs separately for unmasked phone numbers and recording URLs

**Out of scope:**
- **Twilio account compromise:** If Twilio credentials are stolen, attackers can place calls directly via Twilio API (bypassing this bridge entirely)
- **xAI API key compromise:** Direct xAI Realtime API calls (bypassing Twilio)
- **Network-level attacks:** DDoS, SSL/TLS attacks (mitigate at edge/load balancer)

### Security Properties

The HMAC-based authentication provides:
- ✅ **Unforgeability:** Signatures cannot be generated without the HMAC key (`MEDIA_STREAM_SECRET` when non-empty after trimming and `BRIDGE_API_KEY` is set, otherwise `BRIDGE_API_KEY`). They are not generated at all when `BRIDGE_API_KEY` is unset
- ✅ **Cryptographic binding:** CallSid is bound into the signature; tampering invalidates it
- ✅ **Time-limited:** Signatures expire after `MEDIA_AUTH_WINDOW_MS` (default 2 minutes)
- ✅ **Single-use:** Signatures can only be claimed once
- ✅ **X-Twilio-Signature validation:** `/twiml-connect` protected when `TWILIO_AUTH_TOKEN` is set

**Deployment requirements:**
- Requires `BRIDGE_API_KEY` for signature generation. `MEDIA_STREAM_SECRET` is an optional separate rotation key and is not used unless the operator key is set
- Sticky/single-node deployment required (in-memory state)
- HTTPS/WSS required for Twilio Media Streams

## Known Limitations

- This bridge is a proof-of-concept; it is not production-hardened out of the box
- In-process media caps do not replace edge rate limiting. Limit new connections to `/media-stream` at Cloudflare or another reverse proxy
- DDoS protection should be handled by your edge (Cloudflare, AWS Shield, etc.)
- No intrusion detection; monitor logs for anomalies
- When `MEDIA_STREAM_SECRET` is empty, `BRIDGE_API_KEY` serves both HTTP auth and HMAC signing. Set a separate `MEDIA_STREAM_SECRET` (32+ bytes) so those keys can rotate independently. The dedicated secret does not authorize media signatures by itself

## Audit History

| Date | Changes |
|------|---------|
| 2026-09-15 | Privacy defaults: phone number masking (last 4 only), transcript logging opt-in (LOG_TRANSCRIPTS=0 default) |
| 2026-09-13 | Body-parser error handling hardening: prevent filesystem path leakage on malformed JSON |
| 2026-09-12 | HMAC-SHA256 signature-based media stream auth with cryptographic CallSid binding |
| 2026-09-11 | Crash containment, session GC, qs audit fix, duplicate stream prevention |
| 2026-09-10 | Initial security hardening: CallSid bind, signature claim, BRIDGE_API_KEY auth |
| 2026-09-09 | Proof-of-concept public release |
