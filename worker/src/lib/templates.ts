/**
 * Zero-dependency template personalization, SMS segment accounting and an
 * RFC-4180 CSV reader.
 *
 * Templates are deliberately a tiny language: `{{name}}` or
 * `{{name | fallback}}`, where a name is letters, digits, `_`, `.` or `-`.
 * WhatsApp's positional `{{1}}` form matches the same grammar, so one renderer
 * serves a preview and a cloud template.
 */

const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_.-]+)(?:\s*\|\s*([^}]+?))?\s*\}\}/g;

export interface RenderResult {
  rendered: string;
  /** Variables that had neither a value nor a fallback. */
  missing: string[];
  /** Every variable the template referenced, in first-use order, with repeats. */
  used: string[];
}

export function extractTemplateVariables(template: string): string[] {
  const vars = new Set<string>();
  for (const match of template.matchAll(TOKEN_RE)) vars.add(match[1]);
  return [...vars];
}

export function renderTemplate(
  template: string,
  vars: Record<string, string | number | boolean | null | undefined>
): RenderResult {
  const missing: string[] = [];
  const used: string[] = [];
  const rendered = template.replace(
    TOKEN_RE,
    (_full, key: string, fallback?: string) => {
      used.push(key);
      const raw = vars[key];
      const value = raw === null || raw === undefined ? "" : String(raw).trim();
      if (value !== "") return value;
      if (fallback !== undefined) return fallback.trim();
      missing.push(key);
      return "";
    }
  );
  return { rendered, missing, used };
}

/**
 * Ordered values for a WhatsApp Cloud template's positional parameters.
 *
 * A body of `{{1}} … {{2}}` maps to the values for `1`, `2`; a named body
 * falls back to first-use order, which is what a human would paste into the
 * Meta template editor.
 */
export function whatsappParameterValues(
  template: string,
  vars: Record<string, string | number | boolean | null | undefined>
): string[] {
  const keys = [...template.matchAll(TOKEN_RE)].map((match) => match[1]);
  const numeric = keys.filter((key) => /^\d+$/.test(key));
  const ordered = numeric.length > 0 ? [...new Set(numeric)].sort((a, b) => Number(a) - Number(b)) : [...new Set(keys)];
  return ordered.map((key) => {
    const raw = vars[key];
    return raw === null || raw === undefined ? "" : String(raw).trim();
  });
}

/** GSM 03.38 basic alphabet; anything outside it forces UCS-2. */
const GSM7_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_EXTENSION = "^{}\\[~]|€";
const GSM7_BASIC_SET = new Set(GSM7_BASIC);
const GSM7_EXTENSION_SET = new Set(GSM7_EXTENSION);

export interface SmsSegments {
  encoding: "GSM-7" | "UCS-2";
  /** Encoded length in septets (GSM-7) or UTF-16 code units (UCS-2). */
  units: number;
  segments: number;
  /** Units free in the last segment. */
  remaining: number;
}

/**
 * The exact segment count an SMS gateway will bill.
 *
 * GSM-7 is 160 units in one segment and 153 per part after that; a character
 * from the extension table costs two units. Any character outside GSM-7 makes
 * the whole message UCS-2: 70 units single, 67 per part.
 */
export function countSmsSegments(text: string): SmsSegments {
  let gsmUnits = 0;
  let isGsm = true;
  for (const char of text) {
    if (GSM7_BASIC_SET.has(char)) {
      gsmUnits += 1;
    } else if (GSM7_EXTENSION_SET.has(char)) {
      gsmUnits += 2;
    } else {
      isGsm = false;
      break;
    }
  }

  if (isGsm) {
    const segments = gsmUnits === 0 ? 0 : gsmUnits <= 160 ? 1 : Math.ceil(gsmUnits / 153);
    const capacity = segments <= 1 ? 160 : 153;
    return {
      encoding: "GSM-7",
      units: gsmUnits,
      segments,
      remaining: segments === 0 ? 160 : Math.max(0, segments * capacity - gsmUnits)
    };
  }

  let units = 0;
  for (const char of text) units += char.length;
  const segments = units === 0 ? 0 : units <= 70 ? 1 : Math.ceil(units / 67);
  const capacity = segments <= 1 ? 70 : 67;
  return {
    encoding: "UCS-2",
    units,
    segments,
    remaining: segments === 0 ? 70 : Math.max(0, segments * capacity - units)
  };
}

/**
 * Minimal RFC-4180 CSV parser keyed by the header row.
 *
 * Quoted cells may contain commas, escaped double quotes and newlines. Cells
 * are trimmed, which is what an operator pasting a spreadsheet means; a quoted
 * value that genuinely starts or ends with a space is not a supported shape.
 */
export function parseCsvRecords(csvText: string): Record<string, string>[] {
  const text = csvText.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(cell.trim());
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell.trim());
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell.trim());
    if (row.some((value) => value !== "")) rows.push(row);
  }
  if (rows.length < 2) return [];

  const headers = rows[0].map((header) => header.trim().toLowerCase());
  return rows.slice(1).map((values) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (header) record[header] = values[index] ?? "";
    });
    return record;
  });
}
