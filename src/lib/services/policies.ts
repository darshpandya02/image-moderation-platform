import type { Db } from "@/lib/db";
import { parseThresholds, type Policy } from "@/lib/policy";

type PolicyRow = { id: string; name: string; description: string; thresholds: unknown; version: number; is_default: boolean };

export type PolicyWithMeta = Policy & { description: string; isDefault: boolean };

function toPolicy(r: PolicyRow): PolicyWithMeta {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    version: Number(r.version),
    isDefault: r.is_default,
    thresholds: parseThresholds(typeof r.thresholds === "string" ? JSON.parse(r.thresholds) : r.thresholds),
  };
}

export async function listPolicies(db: Db): Promise<PolicyWithMeta[]> {
  const rows = await db.query<PolicyRow>(
    `SELECT id, name, description, thresholds, version, is_default
       FROM image_moderation.policies ORDER BY is_default DESC, id`,
  );
  return rows.map(toPolicy);
}

export async function getPolicy(db: Db, id: string): Promise<PolicyWithMeta | null> {
  const rows = await db.query<PolicyRow>(
    `SELECT id, name, description, thresholds, version, is_default FROM image_moderation.policies WHERE id = $1`,
    [id],
  );
  return rows[0] ? toPolicy(rows[0]) : null;
}

export async function getDefaultPolicyId(db: Db): Promise<string> {
  const rows = await db.query<{ id: string }>(`SELECT id FROM image_moderation.policies WHERE is_default LIMIT 1`);
  return rows[0]?.id ?? "default";
}
