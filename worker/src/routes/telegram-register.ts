/**
 * Telegram one-click webhook registration.
 *
 * Telegram will not deliver a single update until `setWebhook` names the exact
 * URL and, when configured, the connector's secret token. Asking an operator to
 * run that call by hand means asking them to paste a bot token into a terminal;
 * this route performs it with the sealed credential instead.
 *
 * The bot token appears only in the request to Telegram. It is never returned,
 * logged, or written to the audit detail.
 */

import type { Env } from "../index";
import type { AdminActor } from "../audit";
import { writeAudit } from "../audit";
import { connectorAdminRefusal, openCredentials } from "./channel-connectors";

const TELEGRAM_API = "https://api.telegram.org";
const SET_WEBHOOK_TIMEOUT_MS = 10_000;
const MAX_ERROR_CHARS = 160;

/**
 * Updates the bot has to receive for this product's Telegram channel: direct
 * messages plus the business-account surface. Telegram otherwise sends every
 * other update type to the same endpoint, most of which the parser ignores.
 */
const TELEGRAM_ALLOWED_UPDATES = [
  "message",
  "business_message",
  "edited_business_message",
  "deleted_business_messages",
] as const;

interface ConnectorSecretRow {
  id: string;
  channel: string;
  label: string;
  secret_sealed: string | null;
}

interface TelegramSetWebhookResponse {
  ok?: unknown;
  description?: unknown;
}

function telegramJson(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Call Telegram's `setWebhook`.
 *
 * The token is part of the path, so failures must never echo the request URL:
 * `description` comes from the response body or a fixed phrase, never from an
 * exception. A rejected `fetch` (DNS, TLS, offline) is an `ok: false` result,
 * not a thrown error, because the caller has to write a badge either way.
 */
export async function setTelegramWebhook(
  botToken: string,
  webhookUrl: string,
  secretToken?: string
): Promise<{ ok: boolean; description?: string }> {
  const payload: Record<string, unknown> = {
    url: webhookUrl,
    allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
  };
  if (secretToken !== undefined) payload.secret_token = secretToken;

  let response: Response;
  try {
    response = await fetch(`${TELEGRAM_API}/bot${botToken}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SET_WEBHOOK_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, description: "network error" };
  }

  let body: TelegramSetWebhookResponse | null = null;
  try {
    const parsed: unknown = await response.json();
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as TelegramSetWebhookResponse;
    }
  } catch {
    body = null;
  }

  const description =
    typeof body?.description === "string" && body.description !== ""
      ? body.description
      : undefined;

  if (body !== null && body.ok === true) {
    return description === undefined ? { ok: true } : { ok: true, description };
  }

  return {
    ok: false,
    description: description ?? `HTTP ${response.status}`,
  };
}

/**
 * `POST /v1/admin/connectors/:id/register-webhook`.
 *
 * Human-only, exactly like connector creation: a member may read the fleet but
 * may not spend a credential, and an agent or webhook turn may not either.
 */
export async function handleTelegramRegister(
  req: Request,
  env: Env,
  actor: AdminActor,
  id: string
): Promise<Response> {
  const refused = connectorAdminRefusal(actor);
  if (refused !== null) return refused;

  const row = await env.DB.prepare(
    `SELECT id, channel, label, secret_sealed FROM channel_connectors WHERE id = ?`
  )
    .bind(id)
    .first<ConnectorSecretRow>();
  if (row === null) return telegramJson({ error: "not_found" }, 404);
  if (row.channel !== "telegram") return telegramJson({ error: "not_telegram" }, 409);

  const credentials = await openCredentials(env, row.secret_sealed);
  if (credentials === null) {
    return telegramJson(
      {
        error: "connector_secret_unavailable",
        message: "the credential could not be opened",
      },
      503
    );
  }

  const botToken = credentials.botToken ?? "";
  if (botToken === "") {
    return telegramJson(
      {
        error: "telegram_bot_token_missing",
        message: "this connector has no bot token",
      },
      409
    );
  }

  const webhookUrl =
    new URL(req.url).origin +
    "/v1/channels/telegram/" +
    encodeURIComponent(id) +
    "/webhook";

  const result = await setTelegramWebhook(
    botToken,
    webhookUrl,
    credentials.secretToken ?? undefined
  );

  if (result.ok) {
    try {
      await env.DB.prepare(
        `UPDATE channel_connectors SET last_error = NULL WHERE id = ?`
      )
        .bind(id)
        .run();
    } catch {
      // The registration succeeded at Telegram; a badge write must not turn it
      // into a failure the operator would retry.
    }
  } else {
    const reason = `telegram setWebhook: ${result.description ?? "HTTP error"}`.slice(
      0,
      MAX_ERROR_CHARS
    );
    try {
      await env.DB.prepare(
        `UPDATE channel_connectors SET last_error = ? WHERE id = ?`
      )
        .bind(reason, id)
        .run();
    } catch {
      // Same reasoning: the outcome reported to the operator is the API result.
    }
  }

  await writeAudit(env, {
    action: "connector.webhook_registered",
    actor: { userId: actor.userId, label: actor.label },
    subject: id,
    detail: { id, channel: row.channel, ok: result.ok },
  });

  if (result.ok) {
    return telegramJson({
      ok: true,
      webhook_url: webhookUrl,
      ...(result.description === undefined ? {} : { description: result.description }),
    });
  }

  return telegramJson(
    {
      error: "telegram_rejected",
      message: result.description ?? "Telegram refused the webhook",
      webhook_url: webhookUrl,
    },
    502
  );
}
