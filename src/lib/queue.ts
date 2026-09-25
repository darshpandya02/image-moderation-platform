import { QueueClient } from "@vercel/queue";

export const MODERATION_TOPIC = "image-moderation";

export type ModerationMessage = { jobId: string };

export interface Publisher {
  publish(message: ModerationMessage, idempotencyKey: string): Promise<void>;
}

let client: QueueClient | null = null;
function queueClient(): QueueClient {
  if (!client) client = new QueueClient({ region: process.env.VERCEL_REGION || "iad1" });
  return client;
}

/** Vercel Queues: durable topic, at-least-once push delivery to /api/queues/moderation. */
export const vercelQueuePublisher: Publisher = {
  async publish(message, idempotencyKey) {
    await queueClient().send(MODERATION_TOPIC, message, {
      idempotencyKey,
      retentionSeconds: 24 * 60 * 60,
    });
  },
};

/**
 * Local development without Vercel Queues: runs the worker in the same
 * process on the next tick. Job state still lives in Postgres, so the same
 * claim / retry / dead-letter rules apply.
 */
export const inlinePublisher: Publisher = {
  async publish(message) {
    setTimeout(() => {
      void import("@/lib/services/worker").then((w) => w.processJob(message.jobId)).catch((err) => {
        console.error("inline worker failed", err);
      });
    }, 0);
  },
};

let override: Publisher | null = null;

export function getPublisher(): Publisher {
  if (override) return override;
  return process.env.QUEUE_DRIVER === "inline" ? inlinePublisher : vercelQueuePublisher;
}

export function setPublisher(p: Publisher | null) {
  override = p;
}
