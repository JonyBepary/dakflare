# Notes for Coding Agents (`dakflare`)

DakFlare is a sovereign multi-platform messaging hub and SMS gateway: one Android handset (`dev.dakflare.device`), one Cloudflare Worker (`dakflare-worker`), one SvelteKit console (`/admin`), and one zero-dependency CLI (`dakflare`).

## Documentation Surfaces (Dual-Audience)

- **Human & Agent Docs Site (`apps/docs/`)**: Astro Starlight deployed on Cloudflare Workers.
- **Machine Endpoints**: `/llms.txt`, `/llms-full.txt`, `/{any-path}.md` (and `Accept: text/markdown` with `x-markdown-tokens`), `/openapi.json` (OpenAPI 3.1.0), `/SKILL.md`, and `POST /mcp` (Docs MCP server).
- **Modular Repo Skills**: `skills/dakflare-provision/`, `skills/dakflare-messaging/`, `skills/dakflare-flows/`, `skills/dakflare-agents/`.

## Fast Discovery Commands

```bash
dakflare capabilities --agent
dakflare describe <command>
dakflare schema <command> --agent
dakflare schema states --agent
dakflare schema --flow-v2 --json
```

## Critical Invariants

- **Canonical IDs**: Always use `device_id`, `command_id`, `local_id`, `dkf_agt_`, `ag1_`.
- **Async SMS**: `SENT` is radio acceptance, never delivery (`DELIVERED`). Exit `75` means in flight—poll `status`, never re-run `send`. Always pass `--idempotency-key` when retries are possible.
- **Durable Objects**: 4 SQLite-backed classes (`DeviceGateway`, `AuthGuard`, `AuthorityGuard`, `AssistantAgent`).
- **D1 Schema**: 17 migrations (`0001_baseline.sql`–`0017_alert_acknowledged_by.sql`). Apply by D1 UUID via `cf d1 migrations apply <uuid>`, never by name and never from CI.
- **MCP Surface**: 9 tools in `worker/src/mcp/tools.ts` (`list_devices`, `read_messages`, `command_status`, `list_flows`, `get_flow`, `triage`, `telemetry`, `trace`, `send_sms`). Regenerate `contracts/mcp-tools.json` with `node worker/scripts/mcp-contract.mjs --write` whenever tools change.
- **Webhooks**: Actor `webhook:<id>` can read/propose only (`webhook_cannot_act`). Secret rotation is create → cut over → delete.
- **Worker-to-Worker RPC**: Use `DakFlareApi` service binding (`BINDING_AUTH=trusted|agent_token`), never raw Durable Object bindings.

## Verification Gates Before Claiming Done

```bash
cd worker && npm run typecheck && npm run check:config
cd dashboard && npm run check
cd simulator/core && cargo test
cd simulator/flow && cargo test
./test-support/dev.sh && node dakflare_test_harness.mjs pair && node dakflare_test_harness.mjs suite
```
