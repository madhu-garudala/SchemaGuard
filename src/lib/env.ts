import fs from "node:fs";
import path from "node:path";

/**
 * Worker-host only. Loads .env.local then .env for plain Node processes (scripts, worker, tests).
 * Existing variables win. The dashboard never imports this: Next.js loads its own environment,
 * and on a hosted deployment the dashboard only needs DATABASE_URL.
 */
const ROOT = process.env.SCHEMA_GUARD_ROOT ?? process.cwd();
let loaded = false;
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  for (const name of [".env.local", ".env"]) {
    const file = path.join(ROOT, name);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || line.trim().startsWith("#")) continue;
      const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
      if (process.env[m[1]] === undefined) process.env[m[1]] = value;
    }
  }
}
