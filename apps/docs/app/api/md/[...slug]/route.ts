import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";

export async function GET(
  _req: Request,
  context: { params: Promise<{ slug: string[] }> }
) {
  const { slug } = await context.params;
  const joined = slug.join("/").replace(/\.md$/, "");
  if (!/^[a-z0-9/_-]+$/i.test(joined)) {
    return NextResponse.json({ error: "invalid_slug" }, { status: 400 });
  }

  const filePath = path.join(process.cwd(), "public", "md", `${joined}.md`);
  try {
    const body = await readFile(filePath, "utf8");
    const tokens = Math.max(1, Math.ceil(body.length / 4));
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Vary": "Accept",
        "x-markdown-tokens": String(tokens),
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
}
