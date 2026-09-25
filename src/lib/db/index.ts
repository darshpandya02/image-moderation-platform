import { neon } from "@neondatabase/serverless";

/**
 * Minimal database interface. Every write that must be atomic is expressed as
 * a single SQL statement (data-modifying CTEs), so a plain `query` is enough
 * and the same code runs on Neon's HTTP driver and on PGlite in tests.
 */
export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

export const SCHEMA = "image_moderation";

let override: Db | null = null;
let cached: Db | null = null;

export function neonDb(url: string): Db {
  const sql = neon(url);
  return {
    async query<T>(text: string, params: unknown[] = []) {
      return (await sql.query(text, params)) as T[];
    },
  };
}

export function getDb(): Db {
  if (override) return override;
  if (!cached) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    cached = neonDb(url);
  }
  return cached;
}

/** Used by tests to swap in an in-process Postgres. */
export function setDb(db: Db | null) {
  override = db;
}
