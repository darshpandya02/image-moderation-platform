import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** Executes a multi-statement SQL script. Neon's HTTP driver runs one statement per call. */
export type ScriptRunner = (sql: string) => Promise<void>;

export const MIGRATIONS_DIR = path.join(process.cwd(), "db", "migrations");

export function splitStatements(script: string): string[] {
  return script
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) =>
      s
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((s) => s.length > 0);
}

export async function runMigrations(
  exec: (statement: string) => Promise<unknown>,
  dir = MIGRATIONS_DIR,
): Promise<string[]> {
  await exec("CREATE SCHEMA IF NOT EXISTS image_moderation");
  await exec(
    `CREATE TABLE IF NOT EXISTS image_moderation.schema_migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    const rows = (await exec(
      `SELECT 1 FROM image_moderation.schema_migrations WHERE name = '${file.replace(/'/g, "''")}'`,
    )) as unknown[];
    if (Array.isArray(rows) && rows.length > 0) continue;
    const script = await readFile(path.join(dir, file), "utf8");
    for (const statement of splitStatements(script)) {
      await exec(statement);
    }
    await exec(`INSERT INTO image_moderation.schema_migrations (name) VALUES ('${file.replace(/'/g, "''")}')`);
    applied.push(file);
  }
  return applied;
}
