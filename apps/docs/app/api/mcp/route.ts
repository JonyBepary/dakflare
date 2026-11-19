import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";

async function readPublic(rel: string): Promise<string | null> {
  try {
    return await readFile(path.join(process.cwd(), "public", rel), "utf8");
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const rpc = (await request.json().catch(() => null)) as {
    jsonrpc?: string;
    id?: string | number | null;
    method?: string;
    params?: Record<string, unknown>;
  } | null;

  if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid JSON-RPC request" } },
      { status: 400 }
    );
  }

  if (rpc.method === "initialize") {
    return NextResponse.json({
      jsonrpc: "2.0",
      id: rpc.id ?? null,
      result: {
        protocolVersion: "2026-07-28",
        serverInfo: { name: "dakflare-docs", version: "6.3.0-alpha.1" },
        capabilities: { tools: {} },
      },
    });
  }

  if (rpc.method === "tools/list") {
    return NextResponse.json({
      jsonrpc: "2.0",
      id: rpc.id ?? null,
      result: {
        tools: [
          {
            name: "list_sections",
            description: "Return /llms.txt ordered by onboarding priority.",
            inputSchema: { type: "object", properties: {} },
          },
          {
            name: "get_doc_page",
            description: "Fetch clean source Markdown for one slug (e.g. 'start/quickstart').",
            inputSchema: {
              type: "object",
              properties: { slug: { type: "string" } },
              required: ["slug"],
            },
          },
          {
            name: "search_docs",
            description: "Search across all DakFlare docs and return top matching sections.",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
          {
            name: "get_openapi_operation",
            description: "Fetch one operation from /openapi.json by HTTP path (e.g. '/v1/sms/send').",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        ],
      },
    });
  }

  if (rpc.method === "tools/call") {
    const name = String(rpc.params?.name ?? "");
    const args = (rpc.params?.arguments ?? {}) as Record<string, unknown>;

    if (name === "list_sections") {
      const text = (await readPublic("llms.txt")) ?? "llms.txt unavailable";
      return NextResponse.json({ jsonrpc: "2.0", id: rpc.id ?? null, result: { content: [{ type: "text", text }] } });
    }

    if (name === "get_doc_page") {
      const slug = String(args.slug ?? "").replace(/^\/+|\/+$/g, "").replace(/\.md$/, "");
      if (!/^[a-z0-9/_-]+$/i.test(slug)) {
        return NextResponse.json({
          jsonrpc: "2.0",
          id: rpc.id ?? null,
          result: { isError: true, content: [{ type: "text", text: "Invalid slug." }] },
        });
      }
      const text = await readPublic(`md/${slug}.md`);
      if (!text) {
        return NextResponse.json({
          jsonrpc: "2.0",
          id: rpc.id ?? null,
          result: { isError: true, content: [{ type: "text", text: `Not found: ${slug}` }] },
        });
      }
      return NextResponse.json({ jsonrpc: "2.0", id: rpc.id ?? null, result: { content: [{ type: "text", text }] } });
    }

    if (name === "search_docs") {
      const q = String(args.query ?? "").trim().toLowerCase();
      const full = (await readPublic("llms-full.txt")) ?? "";
      const hits = full
        .split(/^---\s*$/m)
        .filter((s) => q.length > 0 && s.toLowerCase().includes(q))
        .slice(0, 5)
        .map((s) => s.trim().slice(0, 1500));
      return NextResponse.json({
        jsonrpc: "2.0",
        id: rpc.id ?? null,
        result: { content: [{ type: "text", text: hits.length ? hits.join("\n\n===\n\n") : `No matches for "${q}".` }] },
      });
    }

    if (name === "get_openapi_operation") {
      const opPath = String(args.path ?? "");
      const raw = await readPublic("openapi.json");
      const spec = raw ? (JSON.parse(raw) as { paths?: Record<string, unknown> }) : null;
      const entry = spec?.paths?.[opPath];
      if (!entry) {
        return NextResponse.json({
          jsonrpc: "2.0",
          id: rpc.id ?? null,
          result: { isError: true, content: [{ type: "text", text: `Path not found: ${opPath}` }] },
        });
      }
      return NextResponse.json({
        jsonrpc: "2.0",
        id: rpc.id ?? null,
        result: { content: [{ type: "text", text: JSON.stringify({ [opPath]: entry }, null, 2) }] },
      });
    }

    return NextResponse.json({
      jsonrpc: "2.0",
      id: rpc.id ?? null,
      error: { code: -32601, message: `Unknown tool: ${name}` },
    });
  }

  return NextResponse.json({
    jsonrpc: "2.0",
    id: rpc.id ?? null,
    error: { code: -32601, message: `Method not found: ${rpc.method}` },
  });
}
