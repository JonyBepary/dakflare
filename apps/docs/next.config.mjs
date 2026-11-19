import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  async redirects() {
    return [
      // The site lives under `/docs`, so the bare hostname answered Next's 404 — a dead end for
      // anyone who was given the origin rather than a page. Permanent: the origin will keep this
      // shape, and a cached redirect saves a round trip.
      { source: "/", destination: "/docs", permanent: true },
    ];
  },
  async rewrites() {
    return [
      { source: "/docs/:path*.md", destination: "/api/md/:path*" },
      { source: "/mcp", destination: "/api/mcp" },
    ];
  },
};

export default withMDX(config);
