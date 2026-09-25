import { describe, expect, it } from "vitest";
import {
  backoffSeconds,
  IllegalTransitionError,
  isTerminal,
  JOB_STATUSES,
  publicStage,
  transition,
  type JobEvent,
  type JobStatus,
} from "@/lib/jobs/state";

const job = (status: JobStatus, attempts = 1, maxAttempts = 4) => ({ status, attempts, maxAttempts });

describe("job state machine", () => {
  it("follows the happy path queued -> processing -> completed", () => {
    expect(transition(job("queued", 0), "claim")).toBe("processing");
    expect(transition(job("processing"), "complete")).toBe("completed");
  });

  it("retries a failed attempt while attempts remain", () => {
    expect(transition(job("processing", 1), "fail")).toBe("retrying");
    expect(transition(job("retrying", 1), "claim")).toBe("processing");
    expect(transition(job("processing", 3), "fail")).toBe("retrying");
  });

  it("dead-letters when the last attempt fails", () => {
    expect(transition(job("processing", 4), "fail")).toBe("dead_letter");
    expect(transition(job("processing", 5), "fail")).toBe("dead_letter");
  });

  it("allows reclaiming an abandoned processing job", () => {
    expect(transition(job("processing"), "reclaim_expired")).toBe("processing");
  });

  it("terminal states accept no events", () => {
    const events: JobEvent[] = ["claim", "complete", "fail", "reclaim_expired"];
    for (const s of ["completed", "dead_letter"] as const) {
      expect(isTerminal(s)).toBe(true);
      for (const e of events) expect(() => transition(job(s), e)).toThrow(IllegalTransitionError);
    }
  });

  it("rejects every transition not in the table", () => {
    const legal = new Set([
      "queued:claim",
      "retrying:claim",
      "processing:complete",
      "processing:fail",
      "processing:reclaim_expired",
    ]);
    const events: JobEvent[] = ["claim", "complete", "fail", "reclaim_expired"];
    for (const s of JOB_STATUSES) {
      for (const e of events) {
        const key = `${s}:${e}`;
        if (legal.has(key)) expect(() => transition(job(s), e)).not.toThrow();
        else expect(() => transition(job(s), e), key).toThrow(IllegalTransitionError);
      }
    }
  });
});

describe("backoffSeconds", () => {
  it("grows exponentially and is capped", () => {
    const max = () => 0.999999;
    expect(backoffSeconds(1, { random: max })).toBe(2);
    expect(backoffSeconds(2, { random: max })).toBe(4);
    expect(backoffSeconds(3, { random: max })).toBe(8);
    expect(backoffSeconds(20, { random: max })).toBe(120);
  });
  it("uses full jitter but never returns less than one second", () => {
    expect(backoffSeconds(5, { random: () => 0 })).toBe(1);
    for (let i = 0; i < 100; i++) {
      const s = backoffSeconds(4);
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThanOrEqual(16);
    }
  });
});

describe("publicStage", () => {
  it("maps internal states to the three stages users see", () => {
    expect(publicStage("pending", "queued")).toBe("queued");
    expect(publicStage("pending", "retrying")).toBe("queued");
    expect(publicStage("pending", "processing")).toBe("processing");
    expect(publicStage("approved", "completed")).toBe("decided");
    expect(publicStage("needs_review", "completed")).toBe("decided");
    expect(publicStage("rejected", "completed")).toBe("decided");
    expect(publicStage("pending", "dead_letter")).toBe("failed");
    expect(publicStage("awaiting_upload", null)).toBe("uploading");
  });
});
