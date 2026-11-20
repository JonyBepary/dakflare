/**
 * Template and audience routes.
 *
 * Handler-level tests against the real D1 schema (`applyD1Migrations` in
 * `setup.ts`). They pin the contract the console depends on: create/list/
 * preview/delete, duplicate-name refusal, segment accounting, the parsed contact
 * view, the 50-row import chunks and the two guard levels (member reads, member
 * writes refused).
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/index";
import type { AdminActor } from "../src/audit";
import {
  handleContactsImport,
  handleContactsList,
  handleTemplateCreate,
  handleTemplateDelete,
  handleTemplateList,
  handleTemplatePreview,
} from "../src/routes/templates";

const testEnv = env as unknown as Env;

const owner: AdminActor = {
  userId: null,
  label: "test-owner",
  role: "owner",
  canGrantOwner: true,
};

const member: AdminActor = {
  userId: "usr_member",
  label: "member@example.test",
  role: "member",
  canGrantOwner: false,
};

const agent: AdminActor = {
  userId: null,
  label: "agent:dkf_agt_test",
  role: "agent",
  canGrantOwner: false,
  agentTokenId: "agt_test",
};

function unique(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function jsonRequest(body: unknown, url = "https://example.com/v1/templates"): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface CreatedTemplate {
  template: { id: string; name: string } & Record<string, unknown>;
  variables: string[];
}

async function createTemplate(
  body: Record<string, unknown> = {}
): Promise<{
  id: string;
  name: string;
  response: Response;
  payload: CreatedTemplate;
}> {
  const name = unique("tpl");
  const response = await handleTemplateCreate(
    jsonRequest({ name, body: "Hello {{name}}", ...body }),
    testEnv,
    owner
  );
  const payload = (await response.json()) as CreatedTemplate;
  return {
    id: payload.template?.id ?? "",
    name: payload.template?.name ?? name,
    response,
    payload,
  };
}

describe("template routes", () => {
  it("creates, lists, previews and deletes a template", async () => {
    const first = await createTemplate({
      name: unique("tpl"),
      body: "Hi {{first}} {{last}}",
      channel: "sms",
    });
    expect(first.response.status).toBe(201);
    const created = first.payload;
    expect(created.template.id).toBe(first.id);
    expect(created.template.channel).toBe("sms");
    expect(created.variables).toEqual(["first", "last"]);

    // Distinct created_at so "newest first" is deterministic.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await createTemplate({ name: unique("tpl"), body: "Second" });
    expect(second.response.status).toBe(201);

    const listResponse = await handleTemplateList(testEnv, owner);
    expect(listResponse.status).toBe(200);
    const list = (await listResponse.json()) as {
      templates: Array<{ id: string; variables: string[] }>;
    };
    expect(list.templates[0].id).toBe(second.id);
    expect(list.templates.some((row) => row.id === first.id)).toBe(true);

    const preview = await handleTemplatePreview(
      jsonRequest({ vars: { first: "Ada" } }),
      testEnv,
      owner,
      first.id
    );
    expect(preview.status).toBe(200);
    const previewed = (await preview.json()) as {
      rendered: string;
      missing: string[];
      used: string[];
      segments: { encoding: string; units: number; segments: number; remaining: number };
    };
    expect(previewed.rendered).toBe("Hi Ada ");
    expect(previewed.missing).toEqual(["last"]);
    expect(previewed.used).toEqual(["first", "last"]);
    expect(previewed.segments.segments).toBe(1);

    const deleted = await handleTemplateDelete(testEnv, owner, first.id);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true, id: first.id });

    const listAfter = (await (await handleTemplateList(testEnv, owner)).json()) as {
      templates: Array<{ id: string }>;
    };
    expect(listAfter.templates.some((row) => row.id === first.id)).toBe(false);
  });

  it("counts segments for 200 ASCII characters and for an emoji", async () => {
    const ascii = await createTemplate({ body: "a".repeat(200) });
    const asciiPreview = (await (
      await handleTemplatePreview(
        jsonRequest({ vars: {} }),
        testEnv,
        owner,
        ascii.id
      )
    ).json()) as { segments: { encoding: string; segments: number } };
    // GSM-7: 160 in one segment, 153 per part after that.
    expect(asciiPreview.segments.encoding).toBe("GSM-7");
    expect(asciiPreview.segments.segments).toBe(2);

    const emoji = await createTemplate({ body: "Hello 😀" });
    const emojiPreview = (await (
      await handleTemplatePreview(
        jsonRequest({ vars: {} }),
        testEnv,
        owner,
        emoji.id
      )
    ).json()) as { segments: { encoding: string; segments: number } };
    // Any character outside GSM-7 forces UCS-2.
    expect(emojiPreview.segments.encoding).toBe("UCS-2");
    expect(emojiPreview.segments.segments).toBe(1);
  });

  it("refuses a duplicate template name with 409", async () => {
    const name = unique("tpl");
    const first = await createTemplate({ name });
    expect(first.response.status).toBe(201);

    const duplicate = await handleTemplateCreate(
      jsonRequest({ name, body: "Another body" }),
      testEnv,
      owner
    );
    expect(duplicate.status).toBe(409);
    expect(((await duplicate.json()) as { error: string }).error).toBe(
      "template_name_taken"
    );
  });

  it("returns 404 for an unknown template and 400 for a bad channel", async () => {
    const missingPreview = await handleTemplatePreview(
      jsonRequest({ vars: {} }),
      testEnv,
      owner,
      "tpl_missing"
    );
    expect(missingPreview.status).toBe(404);

    const missingDelete = await handleTemplateDelete(testEnv, owner, "tpl_missing");
    expect(missingDelete.status).toBe(404);

    const badChannel = await handleTemplateCreate(
      jsonRequest({ name: unique("tpl"), body: "Body", channel: "carrier-pigeon" }),
      testEnv,
      owner
    );
    expect(badChannel.status).toBe(400);
  });

  it("refuses a member or agent write but allows a member read", async () => {
    const created = await createTemplate({ name: unique("tpl") });

    const memberCreate = await handleTemplateCreate(
      jsonRequest({ name: unique("tpl"), body: "Nope" }),
      testEnv,
      member
    );
    expect(memberCreate.status).toBe(403);

    const agentCreate = await handleTemplateCreate(
      jsonRequest({ name: unique("tpl"), body: "Nope" }),
      testEnv,
      agent
    );
    expect(agentCreate.status).toBe(403);

    const memberDelete = await handleTemplateDelete(testEnv, member, created.id);
    expect(memberDelete.status).toBe(403);

    // Reads match `withAdminAccess` read semantics: a member session may read.
    const memberList = await handleTemplateList(testEnv, member);
    expect(memberList.status).toBe(200);
    const memberPreview = await handleTemplatePreview(
      jsonRequest({ vars: {} }),
      testEnv,
      member,
      created.id
    );
    expect(memberPreview.status).toBe(200);

    const agentList = await handleTemplateList(testEnv, agent);
    expect(agentList.status).toBe(403);
  });
});

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

describe("contacts routes", () => {
  it("imports CSV with quotes, CRLF, an empty peer and an opt-out", async () => {
    const lines = ["peer,name,opt_out,tags,timezone,note"];
    for (let i = 1; i <= 51; i += 1) {
      const peer = i === 51 ? "" : `+1555555${String(i).padStart(4, "0")}`;
      const name = i === 1 ? "Doe, Jane" : `Person ${i}`;
      const optOut = i === 2 ? "1" : "0";
      const tags = i === 1 ? "vip;lead" : "";
      const timezone = i === 3 ? "Not/AZone" : "UTC";
      lines.push(
        [
          csvCell(peer),
          csvCell(name),
          csvCell(optOut),
          csvCell(tags),
          csvCell(timezone),
          csvCell("row"),
        ].join(",")
      );
    }
    const csv = lines.join("\r\n");

    const request = new Request("https://example.com/v1/contacts/import", {
      method: "POST",
      headers: { "content-type": "text/csv; charset=utf-8" },
      body: csv,
    });
    const response = await handleContactsImport(request, testEnv, owner);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, imported: 50, skipped: 1 });

    const all = (await (
      await handleContactsList(testEnv, new URL("https://example.com/v1/contacts"), owner)
    ).json()) as {
      contacts: Array<{
        peer: string;
        name: string | null;
        tags: string[];
        attrs: Record<string, string>;
        timezone: string;
        opt_out: boolean;
      }>;
      total: number;
      opted_out: number;
    };
    expect(all.total).toBe(50);
    expect(all.opted_out).toBe(1);
    expect(all.contacts).toHaveLength(50);

    const jane = all.contacts.find((row) => row.name === "Doe, Jane");
    expect(jane).toBeDefined();
    expect(jane?.tags).toEqual(["vip", "lead"]);
    expect(jane?.attrs).toEqual({ note: "row" });
    expect(jane?.opt_out).toBe(false);

    const bustedZone = all.contacts.find((row) => row.name === "Person 3");
    expect(bustedZone?.timezone).toBe("UTC");

    const optedOut = (await (
      await handleContactsList(
        testEnv,
        new URL("https://example.com/v1/contacts?opt_out=1"),
        owner
      )
    ).json()) as { contacts: Array<{ opt_out: boolean }>; total: number; opted_out: number };
    expect(optedOut.contacts).toHaveLength(1);
    expect(optedOut.contacts[0].opt_out).toBe(true);
    // The summary ignores the opt_out filter: "1 of 50".
    expect(optedOut.total).toBe(50);
    expect(optedOut.opted_out).toBe(1);

    const page = (await (
      await handleContactsList(
        testEnv,
        new URL("https://example.com/v1/contacts?limit=10&offset=5"),
        owner
      )
    ).json()) as { contacts: unknown[]; total: number };
    expect(page.contacts).toHaveLength(10);
    expect(page.total).toBe(50);

    // The audit row exists and carries counts, not peers.
    const audit = await testEnv.DB.prepare(
      `SELECT detail_json FROM audit_log WHERE action = 'contacts.imported' ORDER BY at DESC LIMIT 1`
    ).first<{ detail_json: string }>();
    expect(audit?.detail_json).toBe('{"imported":50,"skipped":1}');
  });

  it("imports a JSON contact array", async () => {
    const response = await handleContactsImport(
      jsonRequest(
        {
          contacts: [
            { phone: "15555550999", name: "Json Person", tags: ["beta"], city: "Lagos" },
            { peer: "", name: "No peer" },
          ],
        },
        "https://example.com/v1/contacts/import"
      ),
      testEnv,
      owner
    );
    expect(await response.json()).toEqual({ ok: true, imported: 1, skipped: 1 });

    const listed = (await (
      await handleContactsList(
        testEnv,
        new URL("https://example.com/v1/contacts?channel=sms&limit=200"),
        owner
      )
    ).json()) as {
      contacts: Array<{
        peer: string;
        tags: string[];
        attrs: Record<string, string>;
      }>;
    };
    const row = listed.contacts.find((contact) => contact.peer === "+15555550999");
    expect(row?.tags).toEqual(["beta"]);
    expect(row?.attrs).toEqual({ city: "Lagos" });
  });

  it("refuses a member or agent import and an oversized body", async () => {
    const csv = "peer,name\r\n+15555550100,Someone\r\n";
    const memberResponse = await handleContactsImport(
      new Request("https://example.com/v1/contacts/import", {
        method: "POST",
        headers: { "content-type": "text/csv" },
        body: csv,
      }),
      testEnv,
      member
    );
    expect(memberResponse.status).toBe(403);

    const agentResponse = await handleContactsImport(
      new Request("https://example.com/v1/contacts/import", {
        method: "POST",
        headers: { "content-type": "text/csv" },
        body: csv,
      }),
      testEnv,
      agent
    );
    expect(agentResponse.status).toBe(403);

    const oversized = `peer,name\r\n+15555550100,${"x".repeat(300 * 1024)}\r\n`;
    const oversizedResponse = await handleContactsImport(
      new Request("https://example.com/v1/contacts/import", {
        method: "POST",
        headers: { "content-type": "text/csv" },
        body: oversized,
      }),
      testEnv,
      owner
    );
    expect(oversizedResponse.status).toBe(413);

    const empty = await handleContactsImport(
      new Request("https://example.com/v1/contacts/import", {
        method: "POST",
        headers: { "content-type": "text/csv" },
        body: "peer,name\r\n",
      }),
      testEnv,
      owner
    );
    expect(empty.status).toBe(400);
  });
});
