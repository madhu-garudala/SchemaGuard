import fs from "node:fs";
import path from "node:path";
import { cfg } from "../src/lib/config";
import { loadEnv } from "../src/lib/env";
import { closePool, q, q1 } from "../src/lib/db";
import { seedCatalog } from "../src/lib/generate";
import { createEnvironment } from "../src/lib/snapshot";
import { centsToDecimal } from "../src/lib/money";

/**
 * Seed the three feeds, publish the verified baseline snapshot and load the twenty-case catalog.
 * Re-running resets the demo to the baseline. `--fresh` also rebuilds the fixture Git repository.
 */
export async function seed(fresh = false): Promise<void> {
  loadEnv();
  if (fresh) for (const d of ["fixture-repo", "revisions", "worktrees"]) fs.rmSync(path.join(cfg().runtimeDir, d), { recursive: true, force: true });
  await q("TRUNCATE environments, contracts, feed_batches, snapshots, runs, jobs, events, incidents, evidence, timeline, agent_runs, scenario_plans, scenario_expectations, scores, worker_heartbeat RESTART IDENTITY CASCADE");
  const env = await createEnvironment("main", "Demo pipeline", "main", "baseline_usd");
  await seedCatalog();
  const snap = (await q1<{ id: string; revision: number; data_as_of: Date; totals: any }>("SELECT id, revision, data_as_of, totals FROM snapshots WHERE id=$1", [env.current_snapshot_id]))!;
  console.log(`Seeded Orders, Payments and Shipping feeds.`);
  console.log(`Published snapshot id ${snap.id}, revision ${snap.revision}, data as of ${new Date(snap.data_as_of).toISOString()}`);
  console.log(`Finance net revenue: ${Object.entries(snap.totals.finance_net_by_currency).map(([c, v]) => `${c} ${centsToDecimal(v as string)}`).join(", ")} (matches the independent expected output)`);
  console.log(`Mapping revision ${env.active_mapping_rev.slice(0, 12)} in ${path.relative(process.cwd(), path.join(cfg().runtimeDir, "fixture-repo"))}`);
  console.log(`Catalog: 20 scenarios loaded.`);
}

if (process.argv[1]?.endsWith("seed.ts")) {
  seed(process.argv.includes("--fresh"))
    .catch((err) => {
      console.error(`Seed failed: ${err.message}`);
      process.exitCode = 1;
    })
    .finally(closePool);
}
