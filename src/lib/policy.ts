/**
 * Policy engine: turns classifier scores into a moderation decision.
 *
 * Each policy maps a category to optional `review` and `reject` thresholds.
 * A score at or above `reject` rejects the image, a score at or above `review`
 * sends it to a human. Reject always wins over review, and an image with no
 * triggered rule is approved. The engine is pure so it can be unit tested and
 * replayed against stored scores.
 */

export const CATEGORIES = ["drawing", "hentai", "neutral", "porn", "sexy"] as const;
export type Category = (typeof CATEGORIES)[number];

export type Scores = Record<Category, number>;

export type Threshold = { review?: number; reject?: number };
export type Thresholds = Partial<Record<Category, Threshold>>;

export type Policy = {
  id: string;
  name: string;
  version: number;
  thresholds: Thresholds;
};

export type Decision = "approved" | "rejected" | "needs_review";

export type Reason = {
  category: Category;
  score: number;
  threshold: number;
  rule: "review" | "reject";
};

export type PolicyResult = {
  decision: Decision;
  reasons: Reason[];
};

export class PolicyValidationError extends Error {}

function isUnitInterval(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
}

/** Validates an untrusted thresholds object (for example one read from the database). */
export function parseThresholds(input: unknown): Thresholds {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new PolicyValidationError("thresholds must be an object");
  }
  const out: Thresholds = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!(CATEGORIES as readonly string[]).includes(key)) {
      throw new PolicyValidationError(`unknown category "${key}"`);
    }
    if (typeof value !== "object" || value === null) {
      throw new PolicyValidationError(`threshold for "${key}" must be an object`);
    }
    const { review, reject } = value as Record<string, unknown>;
    if (review !== undefined && !isUnitInterval(review)) {
      throw new PolicyValidationError(`review threshold for "${key}" must be in [0, 1]`);
    }
    if (reject !== undefined && !isUnitInterval(reject)) {
      throw new PolicyValidationError(`reject threshold for "${key}" must be in [0, 1]`);
    }
    if (review !== undefined && reject !== undefined && review > reject) {
      throw new PolicyValidationError(`review threshold for "${key}" must not exceed reject threshold`);
    }
    out[key as Category] = {
      ...(review !== undefined ? { review: review as number } : {}),
      ...(reject !== undefined ? { reject: reject as number } : {}),
    };
  }
  return out;
}

export function validateScores(scores: Partial<Record<string, unknown>>): Scores {
  const out = {} as Scores;
  for (const c of CATEGORIES) {
    const v = scores[c];
    if (!isUnitInterval(v)) {
      throw new PolicyValidationError(`score for "${c}" must be a number in [0, 1]`);
    }
    out[c] = v;
  }
  return out;
}

export function evaluatePolicy(scores: Scores, policy: Pick<Policy, "thresholds">): PolicyResult {
  const rejects: Reason[] = [];
  const reviews: Reason[] = [];

  for (const category of CATEGORIES) {
    const rule = policy.thresholds[category];
    if (!rule) continue;
    const score = scores[category];
    if (rule.reject !== undefined && score >= rule.reject) {
      rejects.push({ category, score, threshold: rule.reject, rule: "reject" });
    } else if (rule.review !== undefined && score >= rule.review) {
      reviews.push({ category, score, threshold: rule.review, rule: "review" });
    }
  }

  const bySeverity = (a: Reason, b: Reason) => b.score - a.score;
  if (rejects.length > 0) {
    return { decision: "rejected", reasons: [...rejects.sort(bySeverity), ...reviews.sort(bySeverity)] };
  }
  if (reviews.length > 0) {
    return { decision: "needs_review", reasons: reviews.sort(bySeverity) };
  }
  return { decision: "approved", reasons: [] };
}

/** Collapses the five categories into the binary safe / nsfw view shown in the UI. */
export function nsfwScore(scores: Scores): number {
  return Math.min(1, scores.porn + scores.hentai + scores.sexy);
}
