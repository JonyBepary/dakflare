"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink, Share2, ChevronDown, FileText } from "lucide-react";

interface PageActionsProps {
  /** Slug relative to /docs, e.g. "start/quickstart" or "index" */
  slug: string;
  title: string;
}

export function PageActions({ slug, title }: PageActionsProps) {
  const [copiedMd, setCopiedMd] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [openMenu, setOpenMenu] = useState<"open" | "share" | null>(null);

  const mdPath = slug === "index" ? "/md/index.md" : `/md/${slug}.md`;

  function getAbsoluteUrl(path: string): string {
    if (typeof window === "undefined") return `https://docs.dakflare.dev${path}`;
    return new URL(path, window.location.origin).toString();
  }

  async function handleCopyMarkdown() {
    try {
      const res = await fetch(mdPath);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const markdown = await res.text();
      await navigator.clipboard.writeText(markdown);
      setCopiedMd(true);
      setTimeout(() => setCopiedMd(false), 2000);
    } catch (err) {
      console.error("Failed to copy Markdown:", err);
    }
  }

  function openInLlm(provider: "chatgpt" | "claude" | "perplexity" | "cursor") {
    const mdUrl = getAbsoluteUrl(mdPath);
    const prompt = encodeURIComponent(
      `Read ${mdUrl} and answer questions about DakFlare (${title}) using only this documentation.`
    );
    const targets: Record<typeof provider, string> = {
      chatgpt: `https://chatgpt.com/?hints=search&q=${prompt}`,
      claude: `https://claude.ai/new?q=${prompt}`,
      perplexity: `https://www.perplexity.ai/search?q=${prompt}`,
      cursor: `cursor://anysphere.cursor-deeplink/prompt?text=${prompt}`,
    };
    window.open(targets[provider], "_blank", "noopener,noreferrer");
    setOpenMenu(null);
  }

  async function handleShare(channel: "copy" | "native" | "x" | "linkedin") {
    const pageUrl = typeof window !== "undefined" ? window.location.href : getAbsoluteUrl(`/docs/${slug}`);
    if (channel === "copy") {
      await navigator.clipboard.writeText(pageUrl);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
      setOpenMenu(null);
      return;
    }
    if (channel === "native" && typeof navigator !== "undefined" && "share" in navigator) {
      try {
        await navigator.share({ title: `DakFlare Docs — ${title}`, url: pageUrl });
      } catch {
        // user cancelled
      }
      setOpenMenu(null);
      return;
    }
    const shareUrls = {
      x: `https://x.com/intent/tweet?text=${encodeURIComponent(`DakFlare Docs: ${title}`)}&url=${encodeURIComponent(pageUrl)}`,
      linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(pageUrl)}`,
    };
    if (channel === "x" || channel === "linkedin") {
      window.open(shareUrls[channel], "_blank", "noopener,noreferrer");
    }
    setOpenMenu(null);
  }

  return (
    <div className="mb-6 flex flex-wrap items-center gap-2 border-b border-fd-border pb-4 text-xs">
      {/* 1. Copy Markdown */}
      <button
        type="button"
        onClick={handleCopyMarkdown}
        className="inline-flex items-center gap-1.5 rounded-md border border-fd-border bg-fd-secondary px-2.5 py-1.5 font-medium text-fd-secondary-foreground transition hover:bg-fd-accent"
      >
        {copiedMd ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
        {copiedMd ? "Copied Markdown" : "Copy Markdown"}
      </button>

      {/* 2. Open in... */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpenMenu(openMenu === "open" ? null : "open")}
          className="inline-flex items-center gap-1.5 rounded-md border border-fd-border bg-fd-secondary px-2.5 py-1.5 font-medium text-fd-secondary-foreground transition hover:bg-fd-accent"
        >
          <ExternalLink className="size-3.5" />
          Open in
          <ChevronDown className="size-3" />
        </button>
        {openMenu === "open" && (
          <div className="absolute left-0 z-30 mt-1.5 w-48 rounded-lg border border-fd-border bg-fd-popover p-1 shadow-lg">
            <button
              type="button"
              onClick={() => openInLlm("chatgpt")}
              className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left hover:bg-fd-accent"
            >
              Open in ChatGPT
            </button>
            <button
              type="button"
              onClick={() => openInLlm("claude")}
              className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left hover:bg-fd-accent"
            >
              Open in Claude
            </button>
            <button
              type="button"
              onClick={() => openInLlm("perplexity")}
              className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left hover:bg-fd-accent"
            >
              Open in Perplexity
            </button>
            <button
              type="button"
              onClick={() => openInLlm("cursor")}
              className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left hover:bg-fd-accent"
            >
              Open in Cursor
            </button>
            <a
              href={mdPath}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpenMenu(null)}
              className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left hover:bg-fd-accent"
            >
              <FileText className="size-3.5" />
              View raw .md
            </a>
          </div>
        )}
      </div>

      {/* 3. Share */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpenMenu(openMenu === "share" ? null : "share")}
          className="inline-flex items-center gap-1.5 rounded-md border border-fd-border bg-fd-secondary px-2.5 py-1.5 font-medium text-fd-secondary-foreground transition hover:bg-fd-accent"
        >
          {copiedLink ? <Check className="size-3.5 text-emerald-500" /> : <Share2 className="size-3.5" />}
          {copiedLink ? "Link copied" : "Share"}
          <ChevronDown className="size-3" />
        </button>
        {openMenu === "share" && (
          <div className="absolute left-0 z-30 mt-1.5 w-44 rounded-lg border border-fd-border bg-fd-popover p-1 shadow-lg">
            <button
              type="button"
              onClick={() => handleShare("copy")}
              className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left hover:bg-fd-accent"
            >
              Copy link
            </button>
            <button
              type="button"
              onClick={() => handleShare("x")}
              className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left hover:bg-fd-accent"
            >
              Share on X
            </button>
            <button
              type="button"
              onClick={() => handleShare("linkedin")}
              className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left hover:bg-fd-accent"
            >
              Share on LinkedIn
            </button>
            <button
              type="button"
              onClick={() => handleShare("native")}
              className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left hover:bg-fd-accent"
            >
              System share...
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
