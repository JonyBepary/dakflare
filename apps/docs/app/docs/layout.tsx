import type { ReactNode } from "react";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { source } from "@/lib/source";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <DocsLayout
      tree={source.pageTree}
      nav={{
        title: (
          <span className="df-brand">
            <span className="df-brand-mark" aria-hidden />
            DakFlare
            <span className="df-brand-tag">docs</span>
          </span>
        ),
        url: "/docs",
      }}
      githubUrl="https://github.com/JonyBepary/dakflare"
    >
      {children}
    </DocsLayout>
  );
}
