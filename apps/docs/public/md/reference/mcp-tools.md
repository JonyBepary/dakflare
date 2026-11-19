# MCP & WebMCP Tools

> Complete schema, scope, OAuth discovery, elicitation, and JSON-RPC error reference for DakFlare's 9 Streamable HTTP MCP tools and 4 browser WebMCP tools.

## Streamable HTTP MCP Server (`/mcp`)

- **Endpoints**: `POST /mcp` (JSON-RPC requests & batches), `GET /mcp` (SSE stream for stateful sessions), `DELETE /mcp` (terminate session). Legacy `POST /v1/mcp` remains supported for stateless `_meta` clients.
- **Required Header**: `Accept` must include `application/json` or `text/event-stream` (otherwise HTTP `406`).
- **Session Tracking**: Stateful clients track `Mcp-Session-Id`; stateless clients pass `params._meta`.
- **OAuth Discovery (Public)**:
  - `GET /.well-known/oauth-protected-resource` (RFC 9728)
  - `GET /.well-known/oauth-authorization-server` (RFC 8414)
  - Audience binding enforced per RFC 8707; `401` responses include `WWW-Authenticate` pointing to the metadata document.
- **Stdio Bridge**: `dakflare mcp serve --token-file <path>`

> **Contract Drift Note**: `worker/src/mcp/tools.ts` currently registers **9 tools** (including `triage` and `telemetry`), whereas `contracts/mcp-tools.json` reflects the earlier 7-tool snapshot. Run `node worker/scripts/mcp-contract.mjs --write` to regenerate `contracts/mcp-tools.json`.

## The 9 MCP Tools (`worker/src/mcp/tools.ts`)

`tools/list` filters dynamically by the caller's token scopes. Calling an unregistered tool returns JSON-RPC `-32601`.

| Tool | Required Scope | Inputs | Output Summary |
| --- | --- | --- | --- |
| `list_devices` | `devices:read` | `{ archived?: boolean }` | `{ devices: [{ device_id, label, sim_slot, last_seen, fcm }] }` |
| `read_messages` | `messages:read` | `{ device_id (Mcp-Param-Device-Id), limit?: 1..200 }` | `{ messages: [{ id, local_id, direction, peer, body, received_at, reply_verdict }], limit }` |
| `command_status` | `messages:read` | `{ command_id, device_id }` | `{ command: { command_id, state, to? } \| null }` |
| `list_flows` | `flows:read` | `{}` | `{ workflows: [{ id, name, enabled, node_count }] }` |
| `get_flow` | `flows:read` | `{ id }` | `{ workflow: { id, name, version, graph } \| null }` |
| `triage` | `messages:read` | `{ message (1..4096), sender (1..64), spans?: [{ index, text }] (max 20) }` | `{ intent, injection, specificity, roles, invariant: { balanceAtLeastPrincipal }, source }` |
| `telemetry` | `devices:read` | `{ question (1..500) }` | `{ plan, rows, truncated, took_ms }` |
| `trace` | `messages:read` | `{ id, device_id? }` | `{ verdict, kind, why: string[] }` |
| `send_sms` | `sms:send` (+ grant) | `{ device_id, to (E.164), body (<=4096), idempotency_key? (<=128) }` | `{ command_id?, sent, approval_request_id? }` or MRTR `input_required` |

> **Header Binding (`x-mcp-header`)**: `read_messages.device_id` declares `x-mcp-header: "Device-Id"`, mapped to request header `Mcp-Param-Device-Id`. A header/argument mismatch returns JSON-RPC `-32020`.

## Elicitation & Multi-Round-Trip (`send_sms`)

Mutating tools never execute on an unapproved agent token:
1. If no live `sms:send:production` grant covers the target, `send_sms` returns an MCP `input_required` result (or SSE `elicitation/create` prompt requiring `confirm_deployment`, 6-digit `totp_code`, and `max_uses`).
2. Grants minted via elicitation are clamped by `SCOPE_CAPS` and capped at 15 minutes.
3. On retry, the tool re-reads the authority store in D1/`AuthorityGuard`; client-supplied `inputResponses` can never widen permissions.

## JSON-RPC Error Codes

| Code | Meaning |
| --- | --- |
| `-32700` | Parse error |
| `-32600` | Invalid JSON-RPC envelope or session |
| `-32601` | Unknown or out-of-scope tool |
| `-32602` | Invalid params, or payload mutated after confirmation |
| `-32603` | Internal server error |
| `-32000` | Not acceptable (`Accept` header missing JSON/SSE) |
| `-32001` | Session not found |
| `-32002` | Elicitation declined by operator |
| `-32003` | Elicitation timed out |
| `-32004` | TOTP code rejected |
| `-32020` | `Mcp-Param-*` header mismatch |

## Browser WebMCP Tools (`/admin/workflows/edit`)

Registered on `document.modelContext` (fallback `navigator.modelContext`) while the workflow editor is mounted:

| Tool | Annotations | Behavior |
| --- | --- | --- |
| `dakflare_get_flow_ast` | `readOnlyHint: true`, `destructiveHint: false` | Returns live `{ flow_id, name, enabled, dirty, staged_patch, graph }` |
| `dakflare_stage_flow_patch` | `readOnlyHint: false`, `consequentialHint: true`, `destructiveHint: true` | Validates and stages a dashed ghost preview (`STAGED PATCH · NOT APPLIED`); never saves |
| `dakflare_synthesize_pattern` | `destructiveHint: false` | Runs local `flow.wasm` template synthesis from `sample` and optional `spans` |
| `dakflare_diagnose_message` | `readOnlyHint: true`, `destructiveHint: false` | Calls `POST /v1/agent/diagnose` with a 15s timeout |
