import { NextResponse, type NextRequest } from "next/server";

/**
 * Content negotiation middleware for AI coding agents:
 * Any GET request to /docs/* carrying `Accept: text/markdown` is rewritten
 * to `/api/md/*`, which serves clean source Markdown with `Vary: Accept`
 * and `x-markdown-tokens`.
 */
export function middleware(request: NextRequest) {
  const accept = request.headers.get("accept") ?? "";
  const { pathname } = request.nextUrl;

  if (
    request.method === "GET" &&
    pathname.startsWith("/docs") &&
    !pathname.endsWith(".md") &&
    accept.includes("text/markdown")
  ) {
    const slug = pathname.replace(/^\/docs\/?/, "") || "index";
    const url = request.nextUrl.clone();
    url.pathname = `/api/md/${slug}`;
    return NextResponse.rewrite(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/docs/:path*"],
};
