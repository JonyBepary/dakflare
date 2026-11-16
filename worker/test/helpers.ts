import { env, SELF } from "cloudflare:test";
import { issueSessionCookie } from "../src/auth/session";

/**
 * Seed one Better Auth user and a real session for it.
 *
 * The row shape and date encoding are copied from `handleInviteRedeem`, which
 * is the production path that creates them: Better Auth stores ISO-8601 text in
 * its `date` columns. `issueSessionCookie` goes through the library's own
 * internal adapter and signing, so the cookie is the one `requireRole` accepts.
 */
export async function seedAdminSession(
  role: "owner" | "admin" | "member" = "owner"
): Promise<{ userId: string; cookie: string }> {
  const userId = crypto.randomUUID();
  const email = `${userId}@example.test`;
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO "user" (id, name, email, "emailVerified", image, "createdAt", "updatedAt", "twoFactorEnabled", role)
     VALUES (?, ?, ?, 1, NULL, ?, ?, 0, ?)`
  )
    .bind(userId, "test-owner", email, now, now, role)
    .run();

  const issued = await issueSessionCookie(env, userId, { ip: null, userAgent: null });
  if (!issued.ok) throw new Error(`could not issue a session cookie: ${issued.error}`);

  return { userId, cookie: issued.cookie.split(";")[0] };
}

/** The ticket route is the only supported mint; tests must not insert hashes. */
export async function mintTicketThroughRoute(cookie: string): Promise<string> {
  const response = await SELF.fetch("https://example.com/v1/admin/agent/ticket", {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: "https://example.com",
      "content-type": "application/json",
    },
    body: "{}",
  });
  if (response.status !== 201) {
    throw new Error(`ticket mint failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { ticket?: string };
  if (typeof body.ticket !== "string") throw new Error("ticket mint returned no ticket");
  return body.ticket;
}
