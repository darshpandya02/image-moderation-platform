import { getDb } from "@/lib/db";
import { getPublisher } from "@/lib/queue";
import type { Deps } from "@/lib/services/uploads";
import { getBlobStore } from "@/lib/storage";

export function appDeps(): Deps {
  return { db: getDb(), blob: getBlobStore(), publisher: getPublisher() };
}
