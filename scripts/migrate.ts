import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../src/lib/config";
import { loadEnv } from "../src/lib/env";
import { closePool, pool, q } from "../src/lib/db";

/** Apply db/migrations/*.sql in order, once each. `--reset` drops everything first (local demo data only). */
export async function migrate(reset = false): Promise<string[]> {
  loadEnv();
  if (reset) await pool().query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await pool().query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const dir = path.join(ROOT, "db", "migrations");
  const done = new Set((await q<{ name: string }>("SELECT name FROM schema_migrations")).map((r) => r.name));
  const applied: string[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    const client = await pool().connect();
    try {
      await client.query("BEGIN");
      await client.query(fs.readFileSync(path.join(dir, file), "utf8"));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      applied.push(file);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  return applied;
}

if (process.argv[1]?.endsWith("migrate.ts")) {
  migrate(process.argv.includes("--reset"))
    .then((a) => console.log(a.length ? `Applied: ${a.join(", ")}` : "Database is up to date."))
    .catch((err) => {
      console.error(`Migration failed: ${err.message}`);
      process.exitCode = 1;
    })
    .finally(closePool);
}
