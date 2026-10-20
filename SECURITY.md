# DakFlare Security Policy

## Supported versions

Only the latest released version receives security fixes. This project is distributed as
self-hosted software: you run it in **your own** Cloudflare account, so patching is your
deployment action, not ours.

| Version | Supported |
|---|---|
| latest release | yes |
| anything older | no — upgrade |

## Reporting a vulnerability

**Do not open a public issue.**

Use GitHub's private vulnerability reporting on this repository
(*Security → Report a vulnerability*). If that is unavailable, contact the maintainers
listed in `README.md` directly.

Please include:

- the affected version (see `GET /v1/admin/health` → `version`),
- what an attacker can do, and the preconditions,
- a minimal reproduction (a failing test case is ideal),
- whether the deployment was reachable from the public internet.

## What is in scope

- The Worker, Durable Object, D1 schema, and route handlers.
- Device authentication: the ECDSA P-256 canonical-string scheme, the nonce replay guard,
  the pairing flow, and key rotation.
- The Android client: key storage, signing, SMS handling, and rule evaluation.
- The install path: anything that would let one deployment compromise another, or leak a
  secret into the repository.

## What is out of scope

- **Your Cloudflare account configuration** — WAF rules, Access policies, budget alerts,
  DNS, TLS mode, workers.dev toggles. Those are yours to operate and are not shipped here.
- **Your carrier and SIM** — including carrier rate limits and bundle exhaustion.
- Vulnerabilities in Cloudflare's platform, Android, or third-party dependencies that have
  no project-specific exploitation path.
- Denial of service through sheer request volume against a deployment you exposed publicly
  without rate limiting. The shipped configuration includes rate limiters; disabling them
  is your decision.

## A note on secrets

This repository must contain **no credentials**. A test fixture that is shaped like a key
(the contract's published test vector, and a key generated at test time for the local FCM
stub) is not a credential and is documented as such — but a committed OAuth client secret,
API token, service-account key, or admin token is a release blocker.

## AGPL-3.0 and security disclosure

This project is licensed AGPL-3.0. Under section 13, if you run a modified version as a
network service, you must offer its source to the people using it. That obligation is
yours as the operator — and it is also why the shipped deployment exposes a `/source`
link: the unmodified deployment already satisfies it.

If you patch a vulnerability locally, please still report it upstream. A silent local patch
leaves every other operator exposed.
