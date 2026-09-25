import { QueueClient } from "@vercel/queue";
import { processJob, RetryLaterError } from "@/lib/services/worker";
import type { ModerationMessage } from "@/lib/queue";

export const maxDuration = 120;

const queue = new QueueClient({ region: process.env.VERCEL_REGION || "iad1" });

/**
 * Vercel Queues push consumer for the `image-moderation` topic (registered
 * in vercel.json). Returning acknowledges the message; throwing asks for
 * redelivery. Retry timing follows the job's own backoff so the queue and
 * the database agree on when the next attempt is due.
 */
export const POST = queue.handleCallback<ModerationMessage>(
  async (message, metadata) => {
    const started = Date.now();
    const result = await processJob(message.jobId);
    console.log(
      JSON.stringify({
        msg: "moderation job handled",
        jobId: message.jobId,
        delivery: metadata.deliveryCount,
        outcome: result.outcome,
        ms: Date.now() - started,
      }),
    );
  },
  {
    visibilityTimeoutSeconds: 180,
    retry: (error, metadata) => {
      if (metadata.deliveryCount > 12) return { acknowledge: true };
      if (error instanceof RetryLaterError) return { afterSeconds: Math.max(1, Math.min(300, error.afterSeconds)) };
      return { afterSeconds: Math.min(300, 2 ** metadata.deliveryCount * 2) };
    },
  },
);
