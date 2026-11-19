/**
 * The syntax palette, in DakFlare token names rather than hex.
 *
 * Shiki writes each token colour into an inline `--shiki-light` / `--shiki-dark`
 * custom property, and a custom property may hold a `var(...)` reference, so the
 * highlighter reads the same `design/tokens.css` the console does. Nothing here
 * duplicates a palette value: change a primitive and the code blocks move with
 * the paper.
 *
 * Light sits on the card (cream-50); dark sits on night-700, the dark card. Ink
 * carries the base text, the metadata step carries comments, and the five state
 * inks carry the syntax families. Keywords take coral because a keyword is the
 * one thing a reader scans for; strings take mint, numbers sky, types butter,
 * calls lilac — the same rotation the console uses for state, so code never
 * introduces a colour the product does not already own.
 */

type Roles = {
  bg: string;
  ink: string;
  line: string;
  comment: string;
  string: string;
  number: string;
  keyword: string;
  call: string;
  type: string;
  property: string;
  punctuation: string;
  operator: string;
  invalid: string;
};

function theme(name: string, type: "light" | "dark", r: Roles) {
  return {
    name,
    type,
    colors: {
      "editor.background": r.bg,
      "editor.foreground": r.ink,
      "editorLineNumber.foreground": r.line,
      "editorLineNumber.activeForeground": r.comment,
      "editor.selectionBackground": r.property,
      "editorCursor.foreground": r.keyword,
    },
    tokenColors: [
      {
        scope: ["comment", "punctuation.definition.comment", "string.comment"],
        settings: { foreground: r.comment, fontStyle: "italic" },
      },
      {
        scope: [
          "string",
          "string.quoted",
          "string.template",
          "string.regexp",
          "punctuation.definition.string",
        ],
        settings: { foreground: r.string },
      },
      {
        scope: ["constant.numeric", "constant.language.unit", "keyword.other.unit"],
        settings: { foreground: r.number },
      },
      {
        scope: [
          "constant.language",
          "constant.character",
          "constant.other",
          "support.constant",
        ],
        settings: { foreground: r.keyword },
      },
      {
        scope: [
          "keyword",
          "keyword.control",
          "keyword.operator.new",
          "storage",
          "storage.type",
          "storage.modifier",
        ],
        settings: { foreground: r.keyword },
      },
      {
        scope: [
          "entity.name.function",
          "support.function",
          "meta.function-call",
          "entity.name.tag",
          "punctuation.definition.tag",
        ],
        settings: { foreground: r.call },
      },
      {
        scope: [
          "entity.name.type",
          "entity.name.class",
          "support.class",
          "support.type",
          "entity.other.inherited-class",
        ],
        settings: { foreground: r.type },
      },
      {
        scope: [
          "support.type.property-name",
          "meta.object-literal.key",
          "entity.other.attribute-name",
          "variable.other.property",
          "variable.other.object.property",
        ],
        settings: { foreground: r.property },
      },
      {
        scope: ["variable", "variable.parameter", "meta.definition.variable", "entity.name.variable"],
        settings: { foreground: r.ink },
      },
      {
        scope: ["punctuation", "meta.brace", "meta.delimiter"],
        settings: { foreground: r.punctuation },
      },
      {
        scope: ["keyword.operator", "operator"],
        settings: { foreground: r.operator },
      },
      {
        scope: ["markup.heading", "markup.heading entity.name", "entity.name.section"],
        settings: { foreground: r.keyword, fontStyle: "bold" },
      },
      { scope: ["markup.bold", "punctuation.definition.bold"], settings: { fontStyle: "bold" } },
      { scope: ["markup.italic", "punctuation.definition.italic"], settings: { fontStyle: "italic" } },
      {
        scope: ["markup.inserted", "punctuation.definition.inserted"],
        settings: { foreground: r.string },
      },
      {
        scope: ["markup.deleted", "punctuation.definition.deleted"],
        settings: { foreground: r.invalid },
      },
      {
        scope: ["invalid", "invalid.illegal", "message.error"],
        settings: { foreground: r.invalid, fontStyle: "underline" },
      },
    ],
  };
}

export const dakflareLight = theme("dakflare-light", "light", {
  bg: "var(--df-surface-card)",
  ink: "var(--df-text-primary)",
  line: "var(--df-text-meta)",
  comment: "var(--df-text-meta)",
  string: "var(--df-state-ok-ink)",
  number: "var(--df-state-info-ink)",
  keyword: "var(--df-accent-text)",
  call: "var(--df-state-filter-ink)",
  type: "var(--df-state-warn-ink)",
  property: "var(--df-text-secondary)",
  punctuation: "var(--df-text-meta)",
  operator: "var(--df-text-secondary)",
  invalid: "var(--df-state-danger-ink)",
});

export const dakflareDark = theme("dakflare-dark", "dark", {
  bg: "var(--df-surface-card)",
  ink: "var(--df-text-primary)",
  line: "var(--df-text-meta)",
  comment: "var(--df-text-meta)",
  string: "var(--df-state-ok-ink)",
  number: "var(--df-state-info-ink)",
  keyword: "var(--df-accent-text)",
  call: "var(--df-state-filter-ink)",
  type: "var(--df-state-warn-ink)",
  property: "var(--df-text-secondary)",
  punctuation: "var(--df-text-meta)",
  operator: "var(--df-text-secondary)",
  invalid: "var(--df-state-danger-ink)",
});
