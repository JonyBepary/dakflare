import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { conversationIdFor } from "../src/agent/conversation";
import { streamIdFor, turnFrame } from "../src/lib/agent-runtime";

/**
 * Durable turn streams, read the way the console reads them after a reload.
 *
 * Only the pool can do this: the `Streams` capability writes to the Durable
 * Object's SQLite, the SSE response is produced by the object's real
 * `onRequest`, and the `read()` generator tails a live stream. The node check
 * drives `Streams` over `node:sqlite`, so it cannot prove the object's HTTP
 * surface ends a closed stream with `done`, nor that a second read does not
 * hang waiting for frames that will never come.
 */
const KEY = "pool-stream";
const ACTOR = "u1";
const ID = streamIdFor(KEY);

function stub() {
  return env.ASSISTANT.getByName("assistant");
}

async function seedTurn(): Promise<void> {
  await stub().fetch("https://assistant/__runtime/status");
  await runInDurableObject(stub(), async (instance) => {
    const writer = await instance.streams.open(ID, {
      tag: conversationIdFor(ACTOR),
      metadata: { turn: KEY, actor: ACTOR },
    });
    const frames = [
      turnFrame(KEY, conversationIdFor(ACTOR)),
      { type: "token", text: "checking" },
      { type: "tool", tool: "telemetry", ok: true, result: { ok: true } },
      { type: "answer", text: "done" },
    ];
    for (const frame of frames) writer.append(frame);
    writer.close();
  });
}

async function readSse(from: number): Promise<{ status: number; body: string }> {
  const response = await stub().fetch(
    `https://assistant/streams/${encodeURIComponent(ID)}?from=${from}`,
    { headers: { "x-dakflare-actor": ACTOR } }
  );
  return { status: response.status, body: await response.text() };
}

function seqIds(body: string): number[] {
  return [...body.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
}

describe("durable turn stream resume", () => {
  it("replays every frame from 0 and closes with done", async () => {
    await seedTurn();
    const { status, body } = await readSse(0);
    expect(status).toBe(200);
    expect(seqIds(body)).toEqual([0, 1, 2, 3]);
    expect(body).toContain('"type":"answer"');
    expect(body.endsWith("event: done\ndata: {}\n\n")).toBe(true);
  }, 15_000);

  it("replays from a mid-sequence cursor", async () => {
    const { status, body } = await readSse(2);
    expect(status).toBe(200);
    expect(seqIds(body)).toEqual([2, 3]);
    expect(body).not.toContain('"type":"token"');
    expect(body.endsWith("event: done\ndata: {}\n\n")).toBe(true);
  }, 15_000);

  it("ends a second read of a closed stream with done instead of blocking", async () => {
    const first = await readSse(0);
    expect(first.body.endsWith("event: done\ndata: {}\n\n")).toBe(true);

    // No new frames will ever be appended. If the resume path tailed instead of
    // observing the completed status, this read would sit until its idle timer.
    const second = await readSse(3);
    expect(seqIds(second.body)).toEqual([3]);
    expect(second.body.endsWith("event: done\ndata: {}\n\n")).toBe(true);
  }, 15_000);
});
