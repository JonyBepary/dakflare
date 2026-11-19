# P-256 Identity & Authentication

> Hardware-wrapped P-256 device signing, canonical string construction, replay protection, and Better Auth multi-factor operator security.

## Zero Shared Secrets Between Handset and Edge

Every device request is authenticated with asymmetric **ECDSA P-256** (`worker/src/auth/canonical.ts`, `worker/src/auth/ecdsa.ts`):

1. **Hardware Key Wrapping**: On Android, `KeyVault.kt` creates a non-exportable AES-256-GCM key inside `AndroidKeyStore` and wraps the handset's P-256 private key before storing it in local libSQL as `keystore:v1:<iv>:<ciphertext>`. D1 stores only the public key. Exfiltrating either database cannot impersonate the handset.
2. **Canonical 5-Line String**:
   ```text
   METHOD
   PATH
   TIMESTAMP
   NONCE
   SHA256(raw_body_bytes)
   ```
   - Separated by `0x0A` (`\n`), **no trailing newline**, **no query string** (any query parameter on a signed device route fails with `400 unexpected_query`).
   - Empty bodies (e.g., `GET`) use SHA-256 of zero bytes (`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`).
3. **Strict Header Grammar**:
   - `X-Device-Id`: `^[A-Za-z0-9_-]{8,64}$`
   - `X-Timestamp`: `^\d{13}$` (UTC epoch ms, must be within ±300,000 ms of edge clock)
   - `X-Nonce`: `^[0-9a-f]{32}$` (16 random bytes, lowercase hex)
   - `X-Signature`: standard Base64 (`=` padded) of the 64-byte IEEE P1363 `r || s` signature
4. **Atomic Replay Guard**: `DeviceGateway` records every spent `X-Nonce` inside its SQLite storage for `NONCE_WINDOW_MS` (300,000 ms). A reused nonce returns `401 nonce_replay` before any write occurs.
5. **Cross-Language Test Vectors**: `test-support/protocol-vectors.json` is verified identically by the TypeScript harness, Rust `simulator/core`, and `test-support/independent-canonical-check.py`.

## Operator Authentication & Sessions

Registration is strictly **invite-only** (no public sign-up). Four sign-in factors are supported:
1. **Passkey (WebAuthn)** — primary, phishing-resistant; `AUTH_RP_ID` pinned to the deployment hostname.
2. **TOTP** — optional second factor (requires a passkey to enroll); disabling deletes the secret and clears all pending challenges.
3. **Password** — optional; defaults to `AUTH_PASSWORD_MODE=client-derived` (210,000-round PBKDF2 in the browser) to stay inside Workers Free 10 ms CPU limits.
4. **Magic Link** — advertised only when `RESEND_API_KEY` is configured; consumed exclusively via button `POST /v1/auth/magic-link/consume` so email scanners cannot burn links.

- **Host-only session cookies**: `__Secure-better-auth.session_token` (`HttpOnly`, `Secure`, `SameSite=Lax`, 7 days) is bound strictly to the Worker's origin—never open the console through a localhost reverse proxy.
- **Dual-scope lockout**: `AuthGuard` enforces 5 attempts/account and 20 attempts/IP per 900s window.
