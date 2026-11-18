import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../index";
import { isBlockedWebhookHost } from "../lib/flow-ir";
import { isAuthorizedWebhookUrl } from "../flow/dispatch";
import { enqueueOutboundCommand, persistOutboundMessage } from "../lib/commands";
import { getChannelPlugin } from "../channels";

export interface FlowWorkflowParams {
  deviceId?: string;
  flowId: string;
  flowVersion: number;
  localId: string;
  sender: string;
  body: string;
  pendingSteps: Array<{
    nodeId: string;
    type: string;
    data: Record<string, unknown>;
  }>;
}

export class FlowExecutionWorkflow extends WorkflowEntrypoint<Env, FlowWorkflowParams> {
  override async run(event: WorkflowEvent<FlowWorkflowParams>, step: WorkflowStep): Promise<void> {
    const { deviceId, flowId, localId, pendingSteps } = event.payload;
    for (let i = 0; i < pendingSteps.length; i++) {
      const item = pendingSteps[i];
      if (item.type === "delay") {
        const seconds = Math.min(Math.max(Number(item.data.seconds) || 1, 1), 300);
        await step.sleep(`delay-${i}-${item.nodeId}`, `${seconds} seconds`);
      } else if (item.type === "webhook") {
        await step.do(
          `webhook-${i}-${item.nodeId}`,
          { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
          async () => {
            const url = String(item.data.url || "");
            if (!url || isBlockedWebhookHost(url)) return;
            const authorized = await isAuthorizedWebhookUrl(this.env, url, flowId);
            if (!authorized) return;
            const res = await fetch(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "User-Agent": "DakFlare-Worker/7.0",
                "X-Dakflare-Device": deviceId || "edge",
                "X-Dakflare-Flow": flowId,
              },
              body: typeof item.data.body === "string" ? item.data.body : JSON.stringify(item.data.body ?? {}),
              redirect: "error",
              signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) throw new Error(`Webhook failed: ${res.status}`);
          }
        );
      } else if (item.type === "send_sms") {
        await step.do(`send-sms-${i}-${item.nodeId}`, async () => {
          const to = String(item.data.to || "");
          const body = String(item.data.body || "");
          if (!to || !body || !deviceId) return;
          if (deviceId.startsWith("channel:")) {
            const channelName = deviceId.slice("channel:".length);
            const plugin = getChannelPlugin(channelName);
            if (!plugin) return;
            const sent = await plugin.sendOutbound({ to, body }, this.env);
            if (!sent.success) {
              throw new Error(`Channel send failed: ${sent.errorCode ?? "unknown"}`);
            }
            await persistOutboundMessage(this.env, deviceId, crypto.randomUUID(), to, body, channelName);
            return;
          }
          const queued = await enqueueOutboundCommand(this.env, {
            deviceId,
            commandId: crypto.randomUUID(),
            to,
            body,
            priority: "normal",
            expiresAt: Date.now() + 86_400_000,
            idempotencyKey: `wf:${flowId}:${localId}:${i}:${item.nodeId}`.slice(0, 128),
          });
          if (!queued.ok) {
            throw new Error(`Failed to enqueue workflow SMS for ${deviceId}`);
          }
        });
      }
    }
  }
}
