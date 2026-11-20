import type { ReactNode } from "react";

export interface PageBannerFact {
  label: string;
  value: string;
}

export interface PageBannerProps {
  /** Section or audience label, e.g. "Start here". */
  kicker: string;
  /** The promise of the page, not a repeat of the page title. */
  title: string;
  /** One or two sentences of orientation, usually the page description. */
  lede: string;
  /** Desktop capture. Also the link target when `href` is omitted. */
  image?: string;
  /** Narrow capture used below 700px so the detail survives a phone. */
  mobileImage?: string;
  alt?: string;
  href?: string;
  /** Two to four facts that make the page concrete. */
  facts?: PageBannerFact[];
  /** A three- or four-step flow, used where a screenshot would not explain. */
  steps?: string[];
  /** A request/response card, used by API and CLI pages. */
  code?: { label: string; lines: string[] };
  /** Provenance line under the facts. */
  caption?: string;
}

/**
 * The first visual on a docs page: one real screen (or one flow), the promise of
 * the page, and the facts a reader needs before the first heading. It is wrapped
 * in `llms-ignore` at the call site, so the machine markdown keeps the prose and
 * drops the picture.
 */
export function PageBanner({
  kicker,
  title,
  lede,
  image,
  mobileImage,
  alt,
  href,
  facts,
  steps,
  code,
  caption,
}: PageBannerProps) {
  let visual: ReactNode = null;

  if (image) {
    visual = (
      <a
        className="df-banner-shot"
        href={href ?? image}
        aria-label={alt ? `${alt} — open at full size` : "Open the screenshot at full size"}
      >
        <picture>
          {mobileImage ? <source media="(max-width: 700px)" srcSet={mobileImage} /> : null}
          <img src={image} alt={alt ?? ""} loading="lazy" decoding="async" />
        </picture>
      </a>
    );
  } else if (steps?.length) {
    visual = (
      <ol className="df-banner-steps">
        {steps.map((step, index) => (
          <li key={`${step}-${index}`}>
            <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
            {step}
          </li>
        ))}
      </ol>
    );
  } else if (code) {
    visual = (
      <div className="df-banner-code">
        <span className="df-banner-code-label">{code.label}</span>
        <pre>
          <code>{code.lines.join("\n")}</code>
        </pre>
      </div>
    );
  }

  return (
    <section className={`df-banner${visual ? "" : " df-banner-text"}`} aria-label={kicker}>
      {visual ? <div className="df-banner-visual">{visual}</div> : null}
      <div className="df-banner-copy">
        <span className="df-banner-kicker">{kicker}</span>
        <p className="df-banner-title">{title}</p>
        <p className="df-banner-lede">{lede}</p>
        {facts?.length ? (
          <dl className="df-banner-facts">
            {facts.map((fact) => (
              <div key={fact.label}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {caption ? <p className="df-banner-caption">{caption}</p> : null}
      </div>
    </section>
  );
}
