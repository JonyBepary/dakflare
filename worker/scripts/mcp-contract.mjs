#!/usr/bin/env node
/**
 * The published MCP tool contract, generated from the running endpoint.
 *
 *   node scripts/mcp-contract.mjs --write     rewrite contracts/mcp-tools.json
 *   node scripts/mcp-contract.mjs --check     fail when the file and the server differ
 *
 * Why generated rather than hand-written: the contract is what a client author
 * codes against, so it has to BE what the server serves. A second hand-maintained
 * copy is a copy that drifts, and the drift shows up as a client that sends a
 * field the server rejects. Generating it from `tools/list` makes that impossible,
 * and `--check` makes a change to a tool without a regenerated contract a build
 * failure rather than a surprise.
 *
 * It needs a running deployment and an agent token with every scope, because
 * `tools/list` is filtered by scope:
 *
 *   WORKER_URL=http://127.0.0.1:8787 DKF_AGENT_TOKEN=dkf_agt_… \
 *     node scripts/mcp-contract.mjs --write
 *
 * The file records the protocol revision next to the tools, so a revision bump is
 * visible in the diff rather than implied.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const CONTRACT = path.join(ROOT, "contracts", "mcp-tools.json");

const WORKER_URL = (process.env.WORKER_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const TOKEN = process.env.DKF_AGENT_TOKEN ?? "";
const VERSION = process.env.MCP_PROTOCOL_VERSION ?? "2026-07-28";

const mode = process.argv.includes("--write") ? "write" : "check";

if (TOKEN === "") {
  console.error("DKF_AGENT_TOKEN is required: the tool list is filtered by scope.");
  process.exit(2);
}

const response = await fetch(`${WORKER_URL}/v1/mcp`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
    "MCP-Protocol-Version": VERSION,
    "Mcp-Method": "tools/list",
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": VERSION,
        "io.modelcontextprotocol/clientInfo": { name: "contract", version: "0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  }),
});

const text = await response.text();
if (!response.ok) {
  console.error(`tools/list answered ${response.status}: ${text.slice(0, 400)}`);
  process.exit(2);
}

const parsed = JSON.parse(text);
const tools = parsed?.result?.tools;
if (!Array.isArray(tools)) {
  console.error("tools/list returned no tools array");
  process.exit(2);
}

const contract = {
  protocol_version: VERSION,
  generated_by: "worker/scripts/mcp-contract.mjs",
  note:
    "Generated from tools/list. Do not edit by hand: run the script with --write. " +
    "`x-mcp-header` on an inputSchema property becomes an `Mcp-Param-{name}` request " +
    "header, is allowed on string, integer and boolean properties only, and a " +
    "mismatch is answered with -32020.",
  tools: tools.map((tool) => ({
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
    ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
  })),
};

const serialized = `${JSON.stringify(contract, null, 2)}\n`;

if (mode === "write") {
  fs.mkdirSync(path.dirname(CONTRACT), { recursive: true });
  fs.writeFileSync(CONTRACT, serialized);
  console.log(`wrote ${path.relative(ROOT, CONTRACT)} (${contract.tools.length} tools)`);
  process.exit(0);
}

if (!fs.existsSync(CONTRACT)) {
  console.error(`missing ${path.relative(ROOT, CONTRACT)}; run this with --write`);
  process.exit(1);
}

if (fs.readFileSync(CONTRACT, "utf8") !== serialized) {
  console.error(
    `contract drift: ${path.relative(ROOT, CONTRACT)} does not match the running endpoint. ` +
      "Run this with --write and review the diff."
  );
  process.exit(1);
}

console.log(`contract in sync: ${contract.tools.length} tools at ${VERSION}`);
