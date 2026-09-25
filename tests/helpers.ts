import { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";

/** A fresh in-process Postgres (PGlite) with the real migrations applied. */
export async function createTestDb(): Promise<Db & { pg: PGlite; close: () => Promise<void> }> {
  const pg = new PGlite();
  const db: Db = {
    async query<T>(text: string, params: unknown[] = []) {
      const res = await pg.query(text, params as unknown[]);
      return res.rows as T[];
    },
  };
  await runMigrations((s) => db.query(s));
  return Object.assign(db, { pg, close: () => pg.close() });
}
