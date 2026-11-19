import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * `/api/md/[...slug]` — the clean markdown for one page.
 *
 * The files are generated from the MDX at build (`scripts/sync-markdown.mjs`) into `public/md`, so
 * they are static assets. On Cloudflare Workers there is no filesystem: the first version of this
 * route read them with `node:fs` and returned 404 for every page once deployed, while working
 * locally under `next start`. Reading through the `ASSETS` binding is what makes the deployed and
 * the local behaviour the same; the disk branch is the local one.
 */

async function fromAssets(slug: string): Promise<string | null> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const { env } = getCloudflareContext();
    const assets = (env as { ASSETS?: { fetch: (input: Request) => Promise<Response> } }).ASSETS;
    if (assets === undefined) return null;
    const response = await assets.fetch(new Request(`https://assets.local/md/${slug}.md`));
    if (!response.ok) return null;
    return await response.text();
  } catch {
    // Not running on Workers (or no binding): fall through to the filesystem.
    return null;
  }
}

async function fromDisk(slug: string): Promise<string | null> {
  try {
    return await readFile(path.join(process.cwd(), "public", "md", `${slug}.md`), "utf8");
  } catch {
    return null;
  }
}

export async function GET(
  _req: Request,
  context: { params: Promise<{ slug: string[] }> }
) {
  const { slug } = await context.params;
  const joined = slug.join("/").replace(/\.md$/, "");
  if (!/^[a-z0-9/_-]+$/i.test(joined)) {
    return NextResponse.json({ error: "invalid_slug" }, { status: 400 });
  }

  const body = (await fromAssets(joined)) ?? (await fromDisk(joined));
  if (body === null) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const tokens = Math.max(1, Math.ceil(body.length / 4));
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      Vary: "Accept",
      "x-markdown-tokens": String(tokens),
      "Cache-Control": "public, max-age=300",
    },
  });
}
