/**
 * Offline evaluation of the classifier + default policy on labelled SFW data.
 *
 *   npx tsx scripts/eval.ts --picsum <dir> --imagenette <imagenette2-160/val> [--per-class 30]
 *
 * Data (downloaded separately, not committed):
 *  - Lorem Picsum: the first 200 photos of https://picsum.photos/v2/list
 *    (Unsplash photos) at 800x600. Ground truth: safe.
 *  - Imagenette v2 160px validation split (fast.ai), first N files per class,
 *    sorted by name. Ground truth: safe, plus the ImageNet class, which scores
 *    the general-content label.
 *
 * No unsafe images are used, so this measures false positives (safe content
 * flagged or rejected) and label accuracy, not recall on explicit content.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { IMAGENET_CLASSES } from "@tensorflow-models/mobilenet/dist/imagenet_classes";
import { createTfClassifier } from "../src/lib/classifier/tf";
import { CATEGORIES, evaluatePolicy, parseThresholds, type Category } from "../src/lib/policy";

const DEFAULT_POLICY = {
  thresholds: parseThresholds({
    porn: { review: 0.35, reject: 0.8 },
    hentai: { review: 0.35, reject: 0.8 },
    sexy: { review: 0.5, reject: 0.92 },
  }),
};

// Imagenette synset -> ImageNet-1k index.
const IMAGENETTE: Record<string, number> = {
  n01440764: 0, // tench
  n02102040: 217, // English springer
  n02979186: 482, // cassette player
  n03000684: 491, // chain saw
  n03028079: 497, // church
  n03394916: 566, // French horn
  n03417042: 569, // garbage truck
  n03425413: 571, // gas pump
  n03445777: 574, // golf ball
  n03888257: 701, // parachute
};

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const pct = (v: number[], p: number) => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
};

type Row = {
  set: string;
  file: string;
  truth?: string;
  top: Category;
  decision: string;
  reasons: string[];
  labels: string[];
  inferenceMs: number;
  totalMs: number;
};

async function main() {
  const picsum = arg("picsum");
  const imagenette = arg("imagenette");
  const perClass = Number(arg("per-class", "30"));
  const clf = await createTfClassifier();

  const items: { set: string; file: string; truth?: string }[] = [];
  if (picsum) {
    for (const f of (await readdir(picsum)).filter((f) => f.endsWith(".jpg")).sort((a, b) => parseInt(a) - parseInt(b))) {
      items.push({ set: "picsum", file: path.join(picsum, f) });
    }
  }
  if (imagenette) {
    for (const syn of Object.keys(IMAGENETTE)) {
      const files = (await readdir(path.join(imagenette, syn))).sort().slice(0, perClass);
      for (const f of files) items.push({ set: "imagenette", file: path.join(imagenette, syn, f), truth: syn });
    }
  }

  // Warm-up so model load and wasm compilation are not in the latency numbers.
  await clf.classify(await readFile(items[0]!.file));

  const rows: Row[] = [];
  for (const it of items) {
    const data = await readFile(it.file);
    const t0 = performance.now();
    const r = await clf.classify(data);
    const totalMs = performance.now() - t0;
    const top = CATEGORIES.reduce((a, b) => (r.scores[a] >= r.scores[b] ? a : b));
    const { decision, reasons } = evaluatePolicy(r.scores, DEFAULT_POLICY);
    rows.push({
      set: it.set,
      file: path.relative(process.cwd(), it.file).split(path.sep).slice(-2).join("/"),
      truth: it.truth,
      top,
      decision,
      reasons: reasons.map((x) => `${x.category}:${x.score.toFixed(3)}>=${x.rule}@${x.threshold}`),
      labels: r.labels.map((l) => l.label),
      inferenceMs: r.inferenceMs,
      totalMs: Math.round(totalMs),
    });
  }

  // The app keeps the top 3 ImageNet labels, so label accuracy is reported as top-1 and top-3.
  const summarize = (subset: Row[]) => {
    const n = subset.length;
    const count = (d: string) => subset.filter((r) => r.decision === d).length;
    const topDist = Object.fromEntries(CATEGORIES.map((c) => [c, subset.filter((r) => r.top === c).length]));
    return {
      n,
      approved: count("approved"),
      needs_review: count("needs_review"),
      rejected: count("rejected"),
      approvedRate: +(count("approved") / n).toFixed(4),
      falseRejectRate: +(count("rejected") / n).toFixed(4),
      flaggedRate: +((count("needs_review") + count("rejected")) / n).toFixed(4),
      argmaxSafe: +(subset.filter((r) => r.top === "neutral" || r.top === "drawing").length / n).toFixed(4),
      topCategory: topDist,
    };
  };

  const inet = rows.filter((r) => r.set === "imagenette");
  const labelAcc = inet.length
    ? {
        n: inet.length,
        top1: +(inet.filter((r) => r.labels[0] === IMAGENET_CLASSES[IMAGENETTE[r.truth!]!]).length / inet.length).toFixed(4),
        top3: +(inet.filter((r) => r.labels.includes(IMAGENET_CLASSES[IMAGENETTE[r.truth!]!]!)).length / inet.length).toFixed(4),
      }
    : null;

  const results = {
    measuredAt: new Date().toISOString(),
    machine: `${process.platform}-${process.arch}, node ${process.version}, tfjs wasm backend`,
    policy: "default",
    all: summarize(rows),
    picsum: summarize(rows.filter((r) => r.set === "picsum")),
    imagenette: summarize(inet),
    generalLabelAccuracy: labelAcc,
    latencyMs: {
      inferenceP50: pct(rows.map((r) => r.inferenceMs), 50),
      inferenceP95: pct(rows.map((r) => r.inferenceMs), 95),
      decodeAndInferP50: pct(rows.map((r) => r.totalMs), 50),
      decodeAndInferP95: pct(rows.map((r) => r.totalMs), 95),
    },
    flagged: rows.filter((r) => r.decision !== "approved").map((r) => ({ file: r.file, decision: r.decision, reasons: r.reasons, label: r.labels[0] })),
  };
  console.log(JSON.stringify({ ...results, flagged: results.flagged.length }, null, 2));
  await writeFile("bench/eval-results.json", JSON.stringify(results, null, 2) + "\n");
  await writeFile("bench/eval-predictions.json", JSON.stringify(rows, null, 1) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
