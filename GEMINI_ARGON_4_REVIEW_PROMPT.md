# Instructions for Gemini Argon 4: Independent Security & Architecture Audit

You are acting as an elite **Principal Systems & Security Conformance Auditor**. Your task is to perform an exhaustive, independent review of the **DakFlare AI-First Messaging Hub & Gateway (v7.0.0)** repository package enclosed in this archive, evaluating the resolution of the prior CONDITIONAL PASS findings (F-V7-01 through F-V7-06) for unconditional PASS ratification.

---

## 1. Context & Evolution
DakFlare evolved from a single-handset SMS gateway into an enterprise multi-platform agentic messaging hub spanning SMS, WhatsApp, Telegram, Signal, and third-party extensions, deployed 100% natively on Cloudflare Free Tier with elastic Pro scaling.

The engineering team has executed:
1. **Four Regression Fixes from Prior Conditional Pass**:
   - `admin.ts`: Clean device revocation removing invalid D1 command deletion.
   - `SmsReceiver.kt`: Blank-SIM customer reply loop reflection suppression without breaking normal auto-replies.
   - `authority.ts`: Target serialization normalization and strict scope matching.
   - `dispatch.ts`: Webhook grant scope fallback and private IP SSRF blocking.
2. **Resolution of Gemini Argon 4 Audit Findings (F-V7-01 through F-V7-06)**:
   - `F-V7-01 (High)`: Resolved Kotlin compile error in `SmsReceiver.kt` by parameterizing `inboundBody` in `reply()`.
   - `F-V7-02 (Medium)`: Fail-closed webhook security on WhatsApp Cloud (`X-Hub-Signature-256`, 64-hex regex) and constant-time SHA-256 digest comparison on Telegram secret token.
   - `F-V7-03 (Medium)`: Removed duplicate D1 `conversations` write in `whatsapp-cloud.ts`; wired `dispatchFlows` for WhatsApp and Telegram ingress in `index.ts`.
   - `F-V7-04 (Medium)`: Declared `[[queues.consumers]]` in wrangler configs; added SSRF + 10s AbortSignal in queue processor; enabled post-delay Workflow continuation for `send_sms` and authorized webhooks.
   - `F-V7-05 (Low)`: Exposed canonical lifecycle tuple on `POST /v1/sms/send` and included `error_code` + `updated_at` in `GET /v1/sms/status/:id`.
   - `F-V7-06 (Low)`: Added `wasm.dealloc(inPtr)` in `wasm-engine.ts`; protected text inputs from `Ctrl+Z` undo hijack, seeded initial undo history, and auto-connected edges in Simple mode.
3. **Live Production Deployment**:
   - Worker Version `2af8447a-34f2-4045-910e-796cf9331b53` (`Producer + Consumer for dakflare-webhook-queue`, `workflow: flow-execution-workflow`).
   - Remote D1 migration `0007_multi_platform_and_conversations.sql` applied (`18/7 applied`).
   - `dakflare doctor` status: **9 pass, 0 fail, 3 skip**.

---

## 2. Directory Layout in This Archive

| Directory | Contents |
|---|---|
| `00_REMEDIATION_OVERVIEW/` | `architecture.md`, `REPORT.md`, `FINDINGS-DETAIL.md`, `findings.json`, `remediation.patch`, `REMEDIATION_PLAN_AND_LOG.md` |
| `01_planning_and_specifications/` | `MULTI_PLATFORM_AI_HUB_SPEC.md`, `WORKFLOW_EDITOR.md`, `PROTOCOL_CONTRACT_V5.md`, `AGENTS.md`, runbooks |
| `02_security_and_audits/` | Full security audit reports, attack class matrices, and harness verifications |
| `03_remediated_source_code/` | Remediated source files for Worker, Rust Flow Engine, Android Bridge, and SvelteKit Dashboard |
| `04_configurations_and_contracts/` | Canonical Cloudflare configuration (`cloudflare.config.ts`, `wrangler.toml`), zero-drift checker, test vectors |
| `05_skills_specifications/` | Skill specifications (`dakflare-provision`, `dakflare-messaging`, `dakflare-flows`, `dakflare-agents`) |
| `06_design_reviews/` | Web & Mobile UI design reviews |
| `07_verification_and_evidence/` | Live command outputs (`dakflare doctor`, `cargo test`, `check-config`, typecheck, screenshots) |

---

## 3. Scope of Your Audit & Verification Checklist

Please evaluate the codebase against the following critical criteria:
1. **F-V7-01 Kotlin Telephony Bridge Compilation**: Verify that `SmsReceiver.kt` correctly scopes `inboundBody` and compiles without unresolved references.
2. **F-V7-02 Fail-Closed Ingress Authentication**: Verify constant-time SHA-256 digest comparison in `telegram.ts` and 64-hex HMAC verification in `whatsapp-cloud.ts`.
3. **F-V7-03 Ingress Write Amplification & Flow Dispatch**: Verify single-write D1 conversation session tracking and flow dispatch via `ctx.waitUntil` for all channels.
4. **F-V7-04 Queue Consumer & Workflow Continuation**: Verify `[[queues.consumers]]` in wrangler configs and uninterrupted action execution after `step.sleep()` in `FlowExecutionWorkflow`.
5. **F-V7-05 Canonical Lifecycle Tuple Parity**: Verify `(state, substate, is_terminal, settled, remediation)` format on send and status endpoints.
6. **F-V7-06 WASM Simulator & Super Editor Polish**: Verify deallocation of `inPtr` in `wasm-engine.ts`, simple-mode auto-edge creation, and input field shortcut isolation.

---

## 4. Required Output Format

Deliver your findings using this structure:
1. **Executive Quality Gate Verdict**: [**PASS** | **CONDITIONAL PASS** | **FAIL**]
2. **Verification Scorecard**:
   - Status of the Four Previous Regressions
   - Status of Gemini Argon 4 Audit Findings (F-V7-01 through F-V7-06)
   - Multi-Platform Channel Connectors & Ingress Webhooks
   - Cloudflare Workflows & Queues Durability
   - Tri-Modal Super Editor & WASM Simulator Engine
   - Conformance & Static Analysis Review
3. **Detailed Findings (if any)**:
   - Severity, Title, File Location with Line Numbers, Attack/Failure Scenario, Concrete Code Remediation.
4. **Final Assessment & Architecture Ratification**.
