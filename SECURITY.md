# Security

## Vulnerability Reporting

If you discover a security vulnerability in this bridge, please email security@[your-domain] or open a private security advisory on GitHub.

## Security Hardening Summary

This bridge implements multiple layers of defense against common attack vectors:

### 1. Operator Route Authentication (BRIDGE_API_KEY)

All control-plane routes (`/call`, `/steer`, `/hangup`, `/voice`, `/transcript`) require authentication via `BRIDGE_API_KEY` using constant-time comparison (`crypto.timingSafeEqual`).

**Required:** Set `BRIDGE_API_KEY` to a strong random secret (32+ bytes) before deploying publicly.

### 2. Media Stream WebSocket Security

- **Bridge tokens:** Short-lived (default 2 min TTL), single-use tokens prevent unauthorized WebSocket connections
- **Token claim atomicity:** Tokens can only be claimed once; duplicate attempts return 409 Conflict
- **CallSid binding:** Expected CallSid is frozen at session creation; mismatches close the WebSocket immediately
- **Token DoS mitigation:** Unclaimed tokens are restored to pending with preserved TTL to prevent burn loops

### 3. Session Lifecycle Management

- **Crash containment:** All WebSocket JSON parsing is wrapped with defensive validation; null/malformed frames never crash the process
- **Garbage collection:** Orphan sessions (both WebSockets closed) and sessions exceeding `SESSION_MAX_AGE_MS` (default 2 hours) are automatically cleaned up every 2 minutes
- **One stream per CallSid:** Duplicate active streams for the same CallSid are rejected to prevent resource exhaustion
- **Duplicate start protection:** After CallSid bind, duplicate `start` events are ignored to prevent parameter re-injection

### 4. Dependency Security

- **npm audit:** All known vulnerabilities are resolved via `npm audit fix` or dependency overrides
- **qs override:** Uses `qs@^6.16.0` to patch CVE-2024-xxxxx in express transitive dependencies

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

## Known Limitations

- This bridge is a proof-of-concept; it is not production-hardened out of the box
- Rate limiting is not implemented; add rate limiting at the reverse proxy level
- DDoS protection should be handled by your edge (Cloudflare, AWS Shield, etc.)
- No intrusion detection; monitor logs for anomalies

## Audit History

| Date | Version | Changes |
|------|---------|---------|
| 2026-09-11 | Batch B | Crash containment, session GC, qs audit fix, duplicate stream prevention |
| 2026-09-10 | Batch A | CallSid bind, token claim, BRIDGE_API_KEY auth |
| 2026-09-09 | Initial | Proof-of-concept public release |
