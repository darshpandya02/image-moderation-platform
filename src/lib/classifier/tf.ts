import { readFile } from "node:fs/promises";
import path from "node:path";
import * as tf from "@tensorflow/tfjs";
import { setWasmPaths } from "@tensorflow/tfjs-backend-wasm";
import * as mobilenet from "@tensorflow-models/mobilenet";
import { load as loadNsfw, type NSFWJS } from "nsfwjs/core";
import { MobileNetV2Model } from "nsfwjs/models/mobilenet_v2";
import sharp from "sharp";
import { CATEGORIES, type Category, type Scores } from "@/lib/policy";
import type { Classification, Classifier } from "./index";

/**
 * Two open-source models run in-process on the TensorFlow.js WebAssembly
 * backend (no native binaries, no external inference API):
 *
 *  - NSFWJS MobileNetV2 (224x224): five-way drawing / hentai / neutral / porn / sexy
 *  - MobileNetV2 1.0 ImageNet classifier (224x224): general-content label
 */
export const MODEL_ID = "nsfwjs-mobilenet_v2@4.4.0+mobilenet_v2_100_224-imagenet";

const INPUT_SIZE = 224;
const root = process.cwd();

const NSFW_CLASS_TO_CATEGORY: Record<string, Category> = {
  Drawing: "drawing",
  Hentai: "hentai",
  Neutral: "neutral",
  Porn: "porn",
  Sexy: "sexy",
};

async function initBackend() {
  if (tf.getBackend() === "wasm") return;
  setWasmPaths(path.join(root, "node_modules/@tensorflow/tfjs-backend-wasm/dist") + path.sep);
  try {
    await tf.setBackend("wasm");
  } catch {
    await tf.setBackend("cpu");
  }
  await tf.ready();
}

async function loadImagenet(): Promise<mobilenet.MobileNet> {
  const dir = path.join(root, "models", "mobilenet_v2_100_224");
  const manifest = JSON.parse(await readFile(path.join(dir, "model.json"), "utf8"));
  const paths: string[] = manifest.weightsManifest.flatMap((g: { paths: string[] }) => g.paths);
  const shards = await Promise.all(paths.map((p) => readFile(path.join(dir, p))));
  const all = Buffer.concat(shards);
  const handler = tf.io.fromMemory({
    modelTopology: manifest.modelTopology,
    weightSpecs: manifest.weightsManifest.flatMap((g: { weights: tf.io.WeightsManifestEntry[] }) => g.weights),
    weightData: all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength),
    format: manifest.format,
  });
  return mobilenet.load({ version: 2, alpha: 1.0, modelUrl: handler, inputRange: [0, 1] });
}

/** Decodes any supported format to a 224x224 RGB tensor. */
async function toTensor(image: Uint8Array): Promise<tf.Tensor3D> {
  const { data, info } = await sharp(image, { limitInputPixels: 40_000_000 })
    .rotate()
    .removeAlpha()
    .resize(INPUT_SIZE, INPUT_SIZE, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3], "int32");
}

export async function createTfClassifier(): Promise<Classifier> {
  await initBackend();
  const [nsfw, imagenet]: [NSFWJS, mobilenet.MobileNet] = await Promise.all([
    loadNsfw("MobileNetV2", { modelDefinitions: [MobileNetV2Model] }),
    loadImagenet(),
  ]);

  // TF.js keeps global state, so inferences are serialized within an instance.
  let chain: Promise<unknown> = Promise.resolve();

  async function run(image: Uint8Array): Promise<Classification> {
    const input = await toTensor(image);
    try {
      const started = performance.now();
      const nsfwPreds = await nsfw.classify(input, CATEGORIES.length);
      const labelPreds = await imagenet.classify(input, 3);
      const inferenceMs = Math.round(performance.now() - started);

      const scores = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Scores;
      for (const p of nsfwPreds) {
        const cat = NSFW_CLASS_TO_CATEGORY[p.className];
        if (cat) scores[cat] = Math.min(1, Math.max(0, p.probability));
      }
      return {
        scores,
        labels: labelPreds.map((p) => ({ label: p.className, probability: p.probability })),
        model: MODEL_ID,
        inferenceMs,
      };
    } finally {
      input.dispose();
    }
  }

  return {
    classify(image) {
      const next = chain.then(() => run(image));
      chain = next.catch(() => undefined);
      return next;
    },
  };
}
