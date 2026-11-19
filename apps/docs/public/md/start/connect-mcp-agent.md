# Connect an MCP Agent

> Mint a scoped dkf_agt_ token, connect Claude Code, Cursor, or OpenCode to DakFlare's Streamable HTTP /mcp endpoint or stdio bridge, and approve a gated SMS send.

An AI agent never holds `ADMIN_TOKEN`. Instead, it authenticates with a scoped `dkf_agt_` bearer token whose **scopes** bound what it may attempt and whose **time-boxed authority grants** bound what it may actually execute.

## Step 1: Mint a Scoped Agent Token

Mint a token with read scopes plus `sms:send` (printed once; D1 stores only its SHA-256 digest):

```bash
dakflare auth mint-agent-token \
  --name "claude-code" \
  --scope devices:read,messages:read,flows:read,sms:send \
  --max-per-hour 20
```

Save the printed `dkf_agt_...` value to a mode-`600` file (for example, `~/.dakflare-agent-token`).

> `devices:revoke` and `auth:reset` are in `NEVER_GRANTABLE`—no token can be minted with them, and no approval grant can ever authorize them.

## Step 2: Connect Your MCP Client

### Option A: Stdio Bridge (`dakflare mcp serve`)

Best for Claude Code, Cursor, Windsurf, and OpenCode local configs. `dakflare mcp serve` speaks stdio JSON-RPC to the editor and Streamable HTTP (`POST`/`GET`/`DELETE /mcp`) with `Mcp-Session-Id` tracking to your Worker:

```json
{
  "mcpServers": {
    "dakflare": {
      "command": "dakflare",
      "args": ["mcp", "serve", "--token-file", "/home/you/.dakflare-agent-token"]
    }
  }
}
```

### Option B: Direct Streamable HTTP (`/mcp`)

Point any Streamable HTTP MCP client at `https://<your-worker>.workers.dev/mcp`:
- Header `Authorization: Bearer dkf_agt_...`
- Header `Accept: application/json, text/event-stream` (requests omitting both return `406`)
- Public OAuth discovery metadata is served at `/.well-known/oauth-protected-resource` (RFC 9728) and `/.well-known/oauth-authorization-server` (RFC 8414), with RFC 8707 audience binding.

## Step 3: Verify Tool Discovery

`tools/list` is the permission surface: tools not covered by the token's scopes are omitted completely (calling them returns JSON-RPC `-32601`). With `devices:read,messages:read,flows:read,sms:send`, the client sees all 9 tools:
- `list_devices`, `telemetry` (`devices:read`)
- `read_messages`, `command_status`, `trace`, `triage` (`messages:read`)
- `list_flows`, `get_flow` (`flows:read`)
- `send_sms` (`sms:send` + live `sms:send:production` grant)

## Step 4: Execute a Gated `send_sms` Round

When the agent calls `send_sms` without a live grant, DakFlare sends nothing. Instead:
1. On Streamable HTTP `/mcp`, the server initiates MCP **elicitation** (`elicitation/create` over SSE) asking the human operator for `confirm_deployment`, a 6-digit `totp_code`, and `max_uses` (or returns a Multi-Round-Trip `input_required` envelope naming the `approval_request_id`).
2. Alternatively, approve the pending request via CLI or the console's `/admin/approvals` page:

```bash
dakflare auth approvals
dakflare auth approve <request-id> --for 15m
```

3. The agent retries `send_sms` with the same `idempotency_key`. The server re-reads D1 and `AuthorityGuard`, verifies the live grant covers the exact recipient(s) or `device_id`, decrements `max_uses`, and queues the command.

## Step 5: Inspect Live Grants and Revoke Anytime

```bash
dakflare auth grants --live
dakflare auth grants revoke <grant-id> --yes
dakflare auth revoke-agent-token <token-id> --yes
```

Revocation takes effect immediately on the very next request.
