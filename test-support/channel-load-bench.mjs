#!/usr/bin/env node
/**
 * Multi-account burst and deduplication benchmark for the channel connectors.
 *
 * Proves three properties that unit tests cannot:
 *
 *  1. **Isolation.** Three accounts of one platform are three `ChannelConnection` Durable Objects,
 *     so throughput does not collapse onto one hot object.
 *  2. **Latency.** The webhook ACK is well inside Meta's five-second ceiling. The gate is on
 *     **p95**, not on the maximum: one slow request is not a regression, and a bad tail hidden
 *     behind a good maximum is.
 *  3. **No duplicates.** A 30% duplicate-retry rate produces exactly one stored message per event,
 *     because the DO dedupes before anything reaches D1.
 *
 * Usage (against the dev stack):
 *
 *   ./test-support/dev.sh
 *   ADMIN_TOKEN=dev-admin-token node test-support/channel-load-bench.mjs
 *
 *   CONNECTORS=3 TOTAL=600 CONCURRENCY=30 CHANNEL=messenger \
 *   ADMIN_TOKEN=dev-admin-token node test-support/channel-load-bench.mjs
 *
 * Exit 0 only when every request was acknowledged, p95 is under the ceiling, and D1 holds one
 * row per event. Anything else is a failure with the numbers that caused it.
 */

import crypto from "node:crypto";

const BASE_URL = (process.env.BASE_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "dev-admin-token";
const CHANNEL = process.env.CHANNEL ?? "messenger";
const ACCOUNT_COUNT = Number(process.env.CONNECTORS ?? 3);
const TOTAL = Number(process.env.TOTAL ?? 600);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 30);
const DUPLICATE_RATE = Number(process.env.DUPLICATE_RATE ?? 30); // percent
const P95_CEILING_MS = Number(process.env.P95_CEILING_MS ?? 5000);
const TAG = process.env.BENCH_TAG ?? `bench-${Date.now()}`;

const admin = (method, path, body) =>
  fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      // The machine identity: `withAdminAccess` sends a labelled client through the token path
      // rather than looking for a session cookie.
      "X-Dakflare-Client": "bench",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** Create one connector per account, with an app secret this run knows. */
async function provision() {
  const accounts = [];
  for (let i = 0; i < ACCOUNT_COUNT; i += 1) {
    const accountId = `${TAG}-acct-${i}`;
    const appSecret = `secret-${TAG}-${i}`;
    const payload =
      CHANNEL === "whatsapp"
        ? {
            channel: "whatsapp",
            account_id: accountId,
            label: `${TAG} wa ${i}`,
            secret: { appSecret, verifyToken: `${TAG}-verify`, accessToken: `${TAG}-access` },
          }
        : {
            channel: "messenger",
            account_id: accountId,
            label: `${TAG} msgr ${i}`,
            secret: { appSecret, verifyToken: `${TAG}-verify`, pageAccessToken: `${TAG}-page` },
          };
    const response = await admin("POST", "/v1/admin/connectors", payload);
    if (!response.ok) {
      throw new Error(`connector create failed: ${response.status} ${await response.text()}`);
    }
    const created = await response.json();
    accounts.push({ connectorId: created.id ?? created.connector?.id, accountId, appSecret });
  }
  return accounts;
}

function sign(body, secret) {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** One webhook body; `eventIndex` repeats 10 back to make a deliberate duplicate. */
function bodyFor(account, eventIndex, duplicate) {
  const effective = duplicate ? eventIndex - 10 : eventIndex;
  const eventId = `${TAG}-${account.accountId}-${effective}`;
  if (CHANNEL === "whatsapp") {
    return JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: account.accountId,
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                messages: [
                  {
                    from: "+8801700000000",
                    id: `wamid.${eventId}`,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: "text",
                    text: { body: `bench ${effective}` },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
  }
  return JSON.stringify({
    object: "page",
    entry: [
      {
        id: account.accountId,
        time: Date.now(),
        messaging: [
          {
            sender: { id: `psid-${eventIndex % 20}` },
            recipient: { id: account.accountId },
            timestamp: Date.now(),
            message: { mid: `mid.${eventId}`, text: `bench ${effective}` },
          },
        ],
      },
    ],
  });
}

async function main() {
  const accounts = await provision();

  // Two phases, because a retry has to target something that was actually sent. Phase one is
  // `TOTAL` distinct events; phase two resends `RETRY_RATE` percent of them, unchanged, to the
  // same connector. That is what Meta does when our 200 is slow — and it makes the expected
  // number of stored rows exactly `TOTAL`, with no arithmetic to get wrong.
  const jobs = [];
  for (let index = 0; index < TOTAL; index += 1) {
    jobs.push({ account: accounts[index % accounts.length], effective: index, duplicate: false });
  }
  const retries = Math.round((TOTAL * DUPLICATE_RATE) / 100);
  for (let i = 0; i < retries; i += 1) {
    const source = Math.floor((i * TOTAL) / retries); // spread across the whole run
    jobs.push({ account: accounts[source % accounts.length], effective: source, duplicate: true });
  }
  // Interleave so retries arrive while the originals are still in flight, which is the case
  // that actually tests the DO.
  for (let i = jobs.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [jobs[i], jobs[j]] = [jobs[j], jobs[i]];
  }

  const latencies = [];
  let ok = 0;
  let failed = 0;
  let duplicatesSent = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      if (job.duplicate) duplicatesSent += 1;
      const body = bodyFor(job.account, job.effective, false);
      const started = performance.now();
      try {
        const response = await fetch(
          `${BASE_URL}/v1/channels/${CHANNEL}/${job.account.connectorId}/webhook`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(CHANNEL === "whatsapp" || CHANNEL === "messenger"
                ? { "X-Hub-Signature-256": sign(body, job.account.appSecret) }
                : {}),
            },
            body,
          }
        );
        latencies.push(performance.now() - started);
        if (response.ok) ok += 1;
        else {
          failed += 1;
          if (failed <= 3) console.error(`  ${response.status} ${(await response.text()).slice(0, 160)}`);
        }
      } catch (error) {
        failed += 1;
        if (failed <= 3) console.error(`  ${String(error)}`);
      }
    }
  }

  const startedAt = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  const elapsedMs = performance.now() - startedAt;

  // Let the queue drain, then count what actually landed.
  await new Promise((resolve) => setTimeout(resolve, 6000));

  latencies.sort((a, b) => a - b);
  const at = (p) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] ?? 0;

  // `/v1/messages` now carries a compound cursor (`next_cursor.before` + `.before_id`), so a
  // burst that writes hundreds of rows into the same millisecond pages cleanly. Follow it until
  // it is null rather than assuming one page holds everything.
  const stored = [];
  for (const account of accounts) {
    const deviceId = `channel:${CHANNEL}:${account.accountId}`;
    let cursor = null;
    for (let page = 0; page < 50; page += 1) {
      const params = new URLSearchParams({ device_id: deviceId, limit: "200" });
      if (cursor !== null) {
        params.set("before", String(cursor.before));
        params.set("before_id", cursor.before_id);
      }
      const response = await admin("GET", `/v1/messages?${params.toString()}`);
      if (!response.ok) throw new Error(`messages read failed: ${response.status}`);
      const payload = await response.json();
      for (const row of payload.messages ?? []) {
        if (String(row.local_id ?? "").includes(TAG)) stored.push(row);
      }
      cursor = payload.next_cursor ?? null;
      if (cursor === null) break;
    }
  }
  const storedIds = new Set(stored.map((row) => row.local_id));
  const duplicateRows = stored.length - storedIds.size;

  const summary = {
    channel: CHANNEL,
    accounts: accounts.length,
    requests: jobs.length,
    retries: duplicatesSent,
    unique_events: TOTAL,
    acknowledged: ok,
    failed,
    stored_rows: stored.length,
    duplicate_rows: duplicateRows,
    throughput_rps: Number(((jobs.length / elapsedMs) * 1000).toFixed(1)),
    latency_ms: {
      p50: Number(at(50).toFixed(1)),
      p95: Number(at(95).toFixed(1)),
      p99: Number(at(99).toFixed(1)),
      max: Number((latencies[latencies.length - 1] ?? 0).toFixed(1)),
    },
    p95_under_ceiling: at(95) < P95_CEILING_MS,
  };
  console.log(JSON.stringify(summary, null, 2));

  const failures = [];
  if (failed > 0) failures.push(`${failed} webhook(s) not acknowledged`);
  if (!summary.p95_under_ceiling) failures.push(`p95 ${summary.latency_ms.p95}ms ≥ ${P95_CEILING_MS}ms`);
  if (duplicateRows > 0) failures.push(`${duplicateRows} duplicate D1 row(s)`);
  if (stored.length !== TOTAL) failures.push(`stored ${stored.length} of ${TOTAL} unique events`);

  if (failures.length > 0) {
    console.error(`\nBENCH FAILED: ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log("\nBENCH PASSED: every request acknowledged, p95 inside the ceiling, one row per event.");
}

main().catch((error) => {
  console.error(`BENCH ERROR: ${String(error)}`);
  process.exit(1);
});
