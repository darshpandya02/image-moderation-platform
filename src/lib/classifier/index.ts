import type { Scores } from "@/lib/policy";

export type Label = { label: string; probability: number };

export type Classification = {
  scores: Scores;
  labels: Label[];
  model: string;
  inferenceMs: number;
};

export interface Classifier {
  classify(image: Uint8Array): Promise<Classification>;
}

let override: Classifier | null = null;
let cached: Promise<Classifier> | null = null;

export async function getClassifier(): Promise<Classifier> {
  if (override) return override;
  if (!cached) {
    cached = import("./tf").then((m) => m.createTfClassifier());
    cached.catch(() => {
      cached = null;
    });
  }
  return cached;
}

export function setClassifier(c: Classifier | null) {
  override = c;
}
