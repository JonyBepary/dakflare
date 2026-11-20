/**
 * WhatsApp Cloud template request shape.
 *
 * The connector path and the legacy plugin share one sender, so pinning the
 * Graph API body here covers both. The platform expects positional body
 * parameters under `components[0].body.parameters`; a template with no
 * variables must omit `components` entirely.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { sendWhatsAppCloudOutbound } from "../src/channels/whatsapp-cloud";

const credentials = {
  accessToken: "test-access-token",
  phoneNumberId: "123456789",
  graphVersion: "v21.0",
};

interface SentBody {
  to: string;
  type: string;
  template: {
    name: string;
    language: { code: string };
    components?: Array<{
      type: string;
      parameters: Array<{ type: string; text: string }>;
    }>;
  };
}

function stubFetch(): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () =>
    Response.json({ messages: [{ id: "wamid.test" }] })
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

function sentBody(mock: ReturnType<typeof vi.fn>): SentBody {
  const call = mock.mock.calls[0] as [string, RequestInit] | undefined;
  expect(call).toBeDefined();
  return JSON.parse(String(call?.[1].body)) as SentBody;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendWhatsAppCloudOutbound templates", () => {
  it("sends ordered body parameters and the requested language", async () => {
    const mock = stubFetch();
    const result = await sendWhatsAppCloudOutbound(
      {
        to: "15551234567",
        body: "Hi {{1}}, your code is {{2}}",
        templateId: "order_update",
        templateLanguage: "es_ES",
        templateArgs: ["one", "two"],
      },
      credentials
    );
    expect(result.success).toBe(true);

    const sent = sentBody(mock);
    expect(sent.type).toBe("template");
    expect(sent.template.name).toBe("order_update");
    expect(sent.template.language).toEqual({ code: "es_ES" });
    expect(sent.template.components).toEqual([
      {
        type: "body",
        parameters: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
      },
    ]);
  });

  it("omits components when the template has no parameters", async () => {
    const mock = stubFetch();
    await sendWhatsAppCloudOutbound(
      {
        to: "15551234567",
        body: "Announcement",
        templateId: "announcement",
        templateArgs: [],
      },
      credentials
    );

    const sent = sentBody(mock);
    expect(sent.template.name).toBe("announcement");
    expect(sent.template.language).toEqual({ code: "en_US" });
    expect(sent.template).not.toHaveProperty("components");
  });
});
