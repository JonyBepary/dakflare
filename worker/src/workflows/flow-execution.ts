import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../index";

export interface FlowWorkflowParams {
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
    const { pendingSteps } = event.payload;
    for (const item of pendingSteps) {
      if (item.type === "delay") {
        const seconds = Math.min(Math.max(Number(item.data.seconds) || 1, 1), 300);
        await step.sleep(`delay-${item.nodeId}`, `${seconds} seconds`);
      } else if (item.type === "webhook") {
        await step.do(
          `webhook-${item.nodeId}`,
          { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } },
          async () => {
            const url = String(item.data.url || "");
            if (!url) return;
            const res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(item.data.body ?? {}),
            });
            if (!res.ok) throw new Error(`Webhook failed: ${res.status}`);
          }
        );
      }
    }
  }
}
