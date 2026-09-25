import { describe, expect, it } from "vitest";
import {
  evaluatePolicy,
  nsfwScore,
  parseThresholds,
  PolicyValidationError,
  validateScores,
  type Scores,
} from "@/lib/policy";

const safe: Scores = { drawing: 0.01, hentai: 0.001, neutral: 0.98, porn: 0.004, sexy: 0.005 };

const policy = {
  thresholds: parseThresholds({
    porn: { review: 0.35, reject: 0.8 },
    hentai: { review: 0.35, reject: 0.8 },
    sexy: { review: 0.5, reject: 0.92 },
  }),
};

describe("evaluatePolicy", () => {
  it("approves when no rule fires", () => {
    expect(evaluatePolicy(safe, policy)).toEqual({ decision: "approved", reasons: [] });
  });

  it("sends borderline scores to review", () => {
    const r = evaluatePolicy({ ...safe, sexy: 0.6, neutral: 0.4 }, policy);
    expect(r.decision).toBe("needs_review");
    expect(r.reasons).toEqual([{ category: "sexy", score: 0.6, threshold: 0.5, rule: "review" }]);
  });

  it("rejects at or above the reject threshold (inclusive)", () => {
    const r = evaluatePolicy({ ...safe, porn: 0.8 }, policy);
    expect(r.decision).toBe("rejected");
    expect(r.reasons[0]).toMatchObject({ category: "porn", rule: "reject", threshold: 0.8 });
  });

  it("review threshold is inclusive and just below it approves", () => {
    expect(evaluatePolicy({ ...safe, hentai: 0.35 }, policy).decision).toBe("needs_review");
    expect(evaluatePolicy({ ...safe, hentai: 0.3499 }, policy).decision).toBe("approved");
  });

  it("reject wins over review and lists every triggered rule, most severe first", () => {
    const r = evaluatePolicy({ ...safe, porn: 0.9, sexy: 0.55, hentai: 0.4 }, policy);
    expect(r.decision).toBe("rejected");
    expect(r.reasons.map((x) => [x.category, x.rule])).toEqual([
      ["porn", "reject"],
      ["sexy", "review"],
      ["hentai", "review"],
    ]);
  });

  it("ignores categories without rules", () => {
    expect(evaluatePolicy({ ...safe, drawing: 1, neutral: 0 }, policy).decision).toBe("approved");
  });

  it("a zero review threshold routes everything to review (demo policy)", () => {
    const demo = { thresholds: parseThresholds({ sexy: { review: 0, reject: 0.8 } }) };
    expect(evaluatePolicy({ ...safe, sexy: 0 }, demo).decision).toBe("needs_review");
    expect(evaluatePolicy({ ...safe, sexy: 0.85 }, demo).decision).toBe("rejected");
  });

  it("a policy with only a reject threshold never produces needs_review", () => {
    const p = { thresholds: parseThresholds({ porn: { reject: 0.5 } }) };
    expect(evaluatePolicy({ ...safe, porn: 0.49 }, p).decision).toBe("approved");
    expect(evaluatePolicy({ ...safe, porn: 0.5 }, p).decision).toBe("rejected");
  });
});

describe("parseThresholds", () => {
  it("rejects unknown categories", () => {
    expect(() => parseThresholds({ violence: { reject: 0.5 } })).toThrow(PolicyValidationError);
  });
  it("rejects out-of-range values", () => {
    expect(() => parseThresholds({ porn: { reject: 1.5 } })).toThrow(PolicyValidationError);
    expect(() => parseThresholds({ porn: { review: -0.1 } })).toThrow(PolicyValidationError);
    expect(() => parseThresholds({ porn: { review: Number.NaN } })).toThrow(PolicyValidationError);
  });
  it("rejects review above reject", () => {
    expect(() => parseThresholds({ porn: { review: 0.9, reject: 0.5 } })).toThrow(/must not exceed/);
  });
  it("rejects non-objects", () => {
    expect(() => parseThresholds(null)).toThrow(PolicyValidationError);
    expect(() => parseThresholds([])).toThrow(PolicyValidationError);
  });
});

describe("validateScores / nsfwScore", () => {
  it("requires every category in [0, 1]", () => {
    expect(() => validateScores({ ...safe, porn: 2 })).toThrow(PolicyValidationError);
    const missing: Partial<Scores> = { ...safe };
    delete missing.sexy;
    expect(() => validateScores(missing)).toThrow(/sexy/);
    expect(validateScores(safe)).toEqual(safe);
  });
  it("sums the explicit categories, capped at 1", () => {
    expect(nsfwScore(safe)).toBeCloseTo(0.01, 5);
    expect(nsfwScore({ ...safe, porn: 0.7, sexy: 0.6 })).toBe(1);
  });
});
