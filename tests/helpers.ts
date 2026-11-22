import crypto from "node:crypto";
import { q } from "../src/lib/db";
import { seedCatalog } from "../src/lib/generate";
import { getRunDetail } from "../src/lib/queries";
import { executeRun } from "../src/lib/runner";
import type { RunDetail } from "../src/lib/api-types";

export async function resetDb(): Promise<void> {
  await q("TRUNCATE environments, contracts, feed_batches, snapshots, runs, jobs, events, incidents, evidence, timeline, agent_runs, scenario_plans, scenario_expectations, scores, worker_heartbeat RESTART IDENTITY CASCADE");
  await seedCatalog();
}

export async function insertRun(planId: string, opts: { kind?: "rehearsal" | "scenario"; fault?: string | null } = {}): Promise<string> {
  const hex = crypto.randomBytes(6).toString("hex");
  const id = `run_${hex}`;
  await q("INSERT INTO runs (id,env_id,kind,plan_id,title,options,agent_mode) VALUES ($1,$2,$3,$4,$5,$6,'fixture')", [id, `env_${hex}`, opts.kind ?? "scenario", planId, `Test run ${hex}`, JSON.stringify({ fault: opts.fault ?? null, agent_mode: "fixture" })]);
  return id;
}

/** Execute a run in-process (no worker), in fixture mode, and return what the API would show. */
export async function runPlan(planId: string, opts: { kind?: "rehearsal" | "scenario"; fault?: string | null } = {}): Promise<RunDetail> {
  const id = await insertRun(planId, opts);
  await executeRun(id);
  return (await getRunDetail(id))!;
}

export const caseId = (n: number) => `catalog-${String(n).padStart(2, "0")}`;
