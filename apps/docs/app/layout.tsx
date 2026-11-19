import type { ReactNode } from "react";
import { RootProvider } from "fumadocs-ui/provider/next";
import "./global.css";

export const metadata = {
  title: {
    template: "%s | DakFlare Docs",
    default: "DakFlare Documentation",
  },
  description:
    "Sovereign multi-platform messaging hub and SMS gateway on Cloudflare Workers and Android.",
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
