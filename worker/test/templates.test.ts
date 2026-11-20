import { describe, expect, it } from "vitest";
import {
  countSmsSegments,
  extractTemplateVariables,
  parseCsvRecords,
  renderTemplate,
  whatsappParameterValues
} from "../src/lib/templates";

describe("renderTemplate", () => {
  it("substitutes values and uses a fallback when the value is empty", () => {
    const result = renderTemplate("Hi {{name | there}}, order #{{order}} is ready.", {
      order: "DK-402"
    });
    expect(result.rendered).toBe("Hi there, order #DK-402 is ready.");
    expect(result.missing).toEqual([]);
    expect(result.used).toEqual(["name", "order"]);
  });

  it("reports a missing variable only when there is no fallback", () => {
    const result = renderTemplate("{{first}} {{last | friend}}", { first: "Amina" });
    expect(result.rendered).toBe("Amina friend");
    expect(result.missing).toEqual([]);
  });

  it("collects a variable with no value and no fallback", () => {
    const result = renderTemplate("{{a}} and {{b}}", { a: "one" });
    expect(result.rendered).toBe("one and ");
    expect(result.missing).toEqual(["b"]);
  });

  it("ignores whitespace inside the braces and keeps repeats in used", () => {
    const result = renderTemplate("{{ name }} {{name}}", { name: "Amina" });
    expect(result.rendered).toBe("Amina Amina");
    expect(result.used).toEqual(["name", "name"]);
  });

  it("extracts unique variables in first-use order", () => {
    expect(extractTemplateVariables("{{b}} {{a}} {{b}} {{c | x}}")).toEqual(["b", "a", "c"]);
  });

  it("supports WhatsApp positional parameters", () => {
    const result = renderTemplate("Order {{1}} for {{2}}", { "1": "DK-402", "2": "Amina" });
    expect(result.rendered).toBe("Order DK-402 for Amina");
  });
});

describe("whatsappParameterValues", () => {
  it("orders numeric parameters by number, not appearance", () => {
    expect(whatsappParameterValues("{{2}} then {{1}}", { "1": "one", "2": "two" })).toEqual([
      "one",
      "two"
    ]);
  });

  it("falls back to first-use order for named parameters", () => {
    expect(whatsappParameterValues("{{name}} {{order}}", { order: "DK-1", name: "Amina" })).toEqual([
      "Amina",
      "DK-1"
    ]);
  });
});

describe("countSmsSegments", () => {
  it("treats plain ASCII as GSM-7 with 160 units in one segment", () => {
    expect(countSmsSegments("a".repeat(160))).toMatchObject({
      encoding: "GSM-7",
      units: 160,
      segments: 1,
      remaining: 0
    });
    expect(countSmsSegments("a".repeat(161))).toMatchObject({
      encoding: "GSM-7",
      segments: 2
    });
  });

  it("bills a GSM extension character as two units", () => {
    expect(countSmsSegments("€").units).toBe(2);
    expect(countSmsSegments("€".repeat(80)).segments).toBe(1);
    expect(countSmsSegments("€".repeat(81)).segments).toBe(2);
  });

  it("switches the whole message to UCS-2 for one unsupported character", () => {
    expect(countSmsSegments("hi 😀")).toMatchObject({ encoding: "UCS-2", units: 5, segments: 1 });
    expect(countSmsSegments("😀".repeat(35)).segments).toBe(1);
    expect(countSmsSegments("😀".repeat(36)).segments).toBe(2);
  });

  it("reports zero segments for an empty body", () => {
    expect(countSmsSegments("")).toMatchObject({ segments: 0, remaining: 160 });
  });
});

describe("parseCsvRecords", () => {
  it("keys rows by a lowercased header and strips a BOM", () => {
    const rows = parseCsvRecords("\uFEFFpeer,channel,name\n+8801,sms,Amina\n");
    expect(rows).toEqual([{ peer: "+8801", channel: "sms", name: "Amina" }]);
  });

  it("handles quoted commas, escaped quotes and CRLF", () => {
    const csv = 'peer,name,note\r\n+8801,"Amina, S.","said ""hi"""\r\n';
    expect(parseCsvRecords(csv)).toEqual([
      { peer: "+8801", name: "Amina, S.", note: 'said "hi"' }
    ]);
  });

  it("keeps a newline inside a quoted cell", () => {
    const csv = 'peer,note\n+8801,"line one\nline two"\n';
    expect(parseCsvRecords(csv)).toEqual([{ peer: "+8801", note: "line one\nline two" }]);
  });

  it("returns nothing without a header and a data row", () => {
    expect(parseCsvRecords("peer\n")).toEqual([]);
    expect(parseCsvRecords("")).toEqual([]);
  });
});
