import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const ADMIN = "postgres://schema_guard:schema_guard@127.0.0.1:54329/schema_guard";
const TEST = "postgres://schema_guard:schema_guard@127.0.0.1:54329/schema_guard_test";

/** Tests use their own database and their own runtime directory; the demo data is never touched. */
export default async function setup() {
  const admin = new pg.Client({ connectionString: ADMIN });
  try {
    await admin.connect();
  } catch {
    throw new Error("Postgres is not reachable on 127.0.0.1:54329. Run `docker compose up -d db` first.");
  }
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname='schema_guard_test'");
  if (!exists.rowCount) await admin.query("CREATE DATABASE schema_guard_test");
  await admin.end();
  fs.rmSync(path.resolve(".runtime-test"), { recursive: true, force: true });
  process.env.DATABASE_URL = TEST;
  process.env.SCHEMA_GUARD_RUNTIME_DIR = ".runtime-test";
  const { migrate } = await import("../scripts/migrate");
  await migrate(true);
  const { closePool } = await import("../src/lib/db");
  await closePool();
}
