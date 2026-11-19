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
    <div className="df-actions">
      <span className="df-actions-label">Page</span>

      {/* 1. Copy Markdown */}
      <button
        type="button"
        onClick={handleCopyMarkdown}
        className="df-action"
        data-state={copiedMd ? "copied" : undefined}
      >
        {copiedMd ? (
          <Check className="df-action-icon text-fd-success" />
        ) : (
          <Copy className="df-action-icon" />
        )}
        {copiedMd ? "Copied Markdown" : "Copy Markdown"}
      </button>

      {/* 2. Open in... */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setOpenMenu(openMenu === "open" ? null : "open")}
          className="df-action"
          data-state={openMenu === "open" ? "open" : undefined}
          aria-haspopup="menu"
          aria-expanded={openMenu === "open"}
        >
          <ExternalLink className="df-action-icon" />
          Open in
          <ChevronDown className="size-3 opacity-60" />
        </button>
        {openMenu === "open" && (
          <div className="df-menu left-0 w-48" role="menu">
            <button type="button" role="menuitem" onClick={() => openInLlm("chatgpt")} className="df-menu-item">
              Open in ChatGPT
            </button>
            <button type="button" role="menuitem" onClick={() => openInLlm("claude")} className="df-menu-item">
              Open in Claude
            </button>
            <button type="button" role="menuitem" onClick={() => openInLlm("perplexity")} className="df-menu-item">
              Open in Perplexity
            </button>
            <button type="button" role="menuitem" onClick={() => openInLlm("cursor")} className="df-menu-item">
              Open in Cursor
            </button>
            <a
              href={mdPath}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpenMenu(null)}
              className="df-menu-item"
              role="menuitem"
            >
              <FileText />
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
          className="df-action"
          data-state={openMenu === "share" ? "open" : undefined}
          aria-haspopup="menu"
          aria-expanded={openMenu === "share"}
        >
          {copiedLink ? (
            <Check className="df-action-icon text-fd-success" />
          ) : (
            <Share2 className="df-action-icon" />
          )}
          {copiedLink ? "Link copied" : "Share"}
          <ChevronDown className="size-3 opacity-60" />
        </button>
        {openMenu === "share" && (
          <div className="df-menu left-0 w-44" role="menu">
            <button type="button" role="menuitem" onClick={() => handleShare("copy")} className="df-menu-item">
              Copy link
            </button>
            <button type="button" role="menuitem" onClick={() => handleShare("x")} className="df-menu-item">
              Share on X
            </button>
            <button type="button" role="menuitem" onClick={() => handleShare("linkedin")} className="df-menu-item">
              Share on LinkedIn
            </button>
            <button type="button" role="menuitem" onClick={() => handleShare("native")} className="df-menu-item">
              System share...
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
