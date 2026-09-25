import { neon } from "@neondatabase/serverless";
import { runMigrations } from "../src/lib/db/migrate";

async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = neon(url);
  const applied = await runMigrations((s) => sql.query(s));
  console.log(applied.length ? `applied: ${applied.join(", ")}` : "schema up to date");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
