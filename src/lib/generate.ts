import crypto from "node:crypto";
import { callAgent, type AgentCtx } from "./agents/call";
import { RESPONSE_POLICY } from "./agents/prompts";
import { extractJson, type Parsed } from "./agents/schemas";
import { CATALOG, catalogPlanId } from "./catalog";
import { cfg, type RoleKey } from "./config";
import { q } from "./db";
import { baselineContract, baselineData, lineage } from "./fixtures";
import { MUTATION_SPECS, type MutationType } from "./mutations";
import { DEFAULT_TIMING, describeMutations, PLAN_EVENT_PAYLOADS, validatePlan, type PlanSansExpectation } from "./scenario";
import { CAUSE_CATEGORIES, OUTCOMES, SOURCES, type Expectation, type SourceId } from "./types";

/** Insert the twenty catalog plans. Expectations go to the private scorer table before anything can be enqueued. */
export async function seedCatalog(): Promise<void> {
  for (const c of CATALOG) {
    const v = validatePlan(c.plan, "catalog");
    if (!v.ok) throw new Error(`catalog case ${c.case_no} is invalid: ${v.reasons.join("; ")}`);
    const id = catalogPlanId(c.case_no);
    await q(
      `INSERT INTO scenario_plans (id,origin,case_no,author_role,agent_id,team,seed,status,title,summary,quick,plan) VALUES ($1,'catalog',$2,'Seed catalog','-',$3,$4,'accepted',$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, summary=EXCLUDED.summary, quick=EXCLUDED.quick, plan=EXCLUDED.plan, team=EXCLUDED.team`,
      [id, c.case_no, c.team, c.plan.seed, c.title, c.summary, c.quick, JSON.stringify(v.plan)],
    );
    await q("INSERT INTO scenario_expectations (plan_id, expected) VALUES ($1,$2) ON CONFLICT (plan_id) DO UPDATE SET expected=EXCLUDED.expected", [id, JSON.stringify(v.expectation)]);
  }
}

const EVENT_DOCS: Record<string, string> = {
  "source.change.proposed": "payload {effective_in_min: 10-170}. The producer announces a contract change that takes effect that many minutes later.",
  "source.change.withdrawn": "payload {reason?: string}. The producer withdraws its proposal.",
  "source.export.started": "payload {}. The feed's export job starts.",
  "source.export.progress": "payload {percent: 1-99}.",
  "source.batch.arrived": "payload {} for the cycle batch, or {batch: 'redelivery' | 'stale'} for an extra delivery.",
};

function authorPacket(team: SourceId, seed: number, covered: string[]) {
  const c = baselineContract(team);
  const data = baselineData("baseline_usd")[team];
  const lin = lineage();
  const allowed = (Object.keys(MUTATION_SPECS) as MutationType[]).filter((t) => MUTATION_SPECS[t].teams.includes(team));
  const warn = c.delivery.expected_start_min + c.delivery.grace_min;
  return {
    task: "author_scenario",
    team,
    seed,
    contract: c,
    baseline: { rows: data.length, sample_rows: data.slice(0, 2), notes: team === "payments" ? "Includes 2 refunds (negative amounts) and orders with several payments." : team === "orders" ? "customer_region is null on 2 rows." : "One order has two shipments." },
    starting_snapshots: { baseline_usd: "single currency (USD)", baseline_multicurrency: "USD and EUR rows" },
    timing_rules: [
      `The cycle runs from minute 0 to the refresh at minute ${c.delivery.hard_deadline_min}, which is also the hard delivery deadline.`,
      `On a normal day the ${team} export starts at minute ${DEFAULT_TIMING[team].started} and its batch arrives at minute ${DEFAULT_TIMING[team].arrived}. Leave export events out unless the scenario is about timing.`,
      "Proposal-type mutations need exactly one source.change.proposed event; offset_min + effective_in_min must be at most 150.",
      "A source.change.withdrawn event must fall strictly between the proposal and its effective time.",
      "Batch-type mutations need no events at all (events: []).",
      `delay_export: the export is late only if source.export.started is after minute ${warn} (or absent). Add source.batch.arrived at or before minute ${c.delivery.hard_deadline_min} to recover; leave it out to miss the deadline.`,
      "redeliver_batch / stale_batch: optionally one source.batch.arrived with payload.batch set, after the normal arrival.",
    ],
    allowed_mutations: allowed.map((t) => ({ type: t, kind: MUTATION_SPECS[t].mode, parameters: MUTATION_SPECS[t].params, effect: MUTATION_SPECS[t].summary })),
    supported_events: Object.keys(PLAN_EVENT_PAYLOADS).map((t) => ({ type: t, usage: EVENT_DOCS[t] })),
    response_policy: RESPONSE_POLICY,
    impact_rules: { whole_feed: lin.dataset_impacts[team].filter((a) => a.startsWith("dash.")), by_field: Object.fromEntries(Object.entries(lin.column_impacts).filter(([k]) => k.startsWith(`${team}.`)).map(([k, v]) => [k, v.filter((a) => a.startsWith("dash."))])), note: "Use by_field when one known field changes; otherwise whole_feed. List dashboards in alphabetical order. Additive changes and ignored deliveries impact none. A failed warehouse transformation impacts all three dashboards." },
    outcomes: OUTCOMES,
    cause_categories: CAUSE_CATEGORIES,
    already_covered: covered,
  };
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift()!);
  }));
}

/**
 * Ask each scenario-author agent for plans, in a bounded pool. Every reply is validated; rejected
 * drafts are kept with their reasons, and the author gets one chance to correct them.
 */
export async function generateScenarios(batchId: string, seed: number, perAuthor = 2, mode = cfg().agentMode): Promise<{ accepted: number; invalid: number; wall_ms: number }> {
  const started = Date.now();
  const tasks = SOURCES.flatMap((team, t) => Array.from({ length: perAuthor }, (_, i) => ({ team, seed: seed + t * 101 + i * 7 })));
  let accepted = 0;
  let invalid = 0;
  await pool(tasks, cfg().authorConcurrency, async ({ team, seed: s }) => {
    const role = `${team}_author` as RoleKey;
    const agentId = cfg().agents[role];
    const covered = (await q<{ summary: string }>("SELECT summary FROM scenario_plans WHERE origin='agent' AND team=$1 AND status='accepted' ORDER BY created_at DESC LIMIT 8", [team])).map((r) => r.summary);
    const ctx: AgentCtx = { runId: null, batchId, mode, faults: [] };
    const drafts: { text: string; reasons: string[] }[] = [];
    const parse = (text: string): Parsed<{ plan: PlanSansExpectation; expectation: Expectation; text: string }> => {
      let raw: unknown;
      try {
        raw = extractJson(text);
      } catch (err) {
        drafts.push({ text, reasons: [(err as Error).message] });
        return { ok: false, category: "malformed_output", errors: [(err as Error).message] };
      }
      const v = validatePlan(raw, "agent", team);
      if (!v.ok) {
        drafts.push({ text, reasons: v.reasons });
        return { ok: false, category: "malformed_output", errors: v.reasons };
      }
      if ((raw as { seed: number }).seed !== s) {
        drafts.push({ text, reasons: [`seed must be ${s}`] });
        return { ok: false, category: "malformed_output", errors: [`seed must be ${s}`] };
      }
      return { ok: true, value: { plan: v.plan, expectation: v.expectation, text } };
    };
    const res = await callAgent(ctx, { role, purpose: `author:${team}:${s}`, packet: authorPacket(team, s, covered), parse });
    const last = await q<{ mode: string; model: string | null; id: string }>("SELECT id, mode, model FROM agent_runs WHERE batch_id=$1 AND purpose=$2 ORDER BY id DESC LIMIT 1", [batchId, `author:${team}:${s}`]);
    const base = [batchId, `${team[0].toUpperCase()}${team.slice(1)} scenario author`, agentId, team, s];
    let attempt = 0;
    for (const d of drafts) {
      invalid++;
      await q("INSERT INTO scenario_plans (id,origin,batch_id,author_role,agent_id,team,seed,status,reasons,attempt,raw_output,agent_run_id) VALUES ($1,'agent',$2,$3,$4,$5,$6,'invalid',$7,$8,$9,$10)", [`gen_${crypto.randomBytes(6).toString("hex")}`, ...base, JSON.stringify(d.reasons), ++attempt, d.text.slice(0, 8000), last[0]?.id ?? null]);
    }
    if (res.ok) {
      accepted++;
      const id = `gen_${crypto.randomBytes(6).toString("hex")}`;
      await q("INSERT INTO scenario_plans (id,origin,batch_id,author_role,agent_id,team,seed,status,attempt,title,summary,plan,raw_output,agent_run_id) VALUES ($1,'agent',$2,$3,$4,$5,$6,'accepted',$7,$8,$9,$10,$11,$12)", [id, ...base, attempt + 1, `${team[0].toUpperCase()}${team.slice(1)} variant · seed ${s}`, describeMutations(res.value.plan), JSON.stringify(res.value.plan), res.value.text.slice(0, 8000), last[0]?.id ?? null]);
      await q("INSERT INTO scenario_expectations (plan_id, expected) VALUES ($1,$2)", [id, JSON.stringify(res.value.expectation)]);
    } else if (drafts.length === 0) {
      invalid++;
      await q("INSERT INTO scenario_plans (id,origin,batch_id,author_role,agent_id,team,seed,status,reasons,attempt,agent_run_id) VALUES ($1,'agent',$2,$3,$4,$5,$6,'invalid',$7,1,$8)", [`gen_${crypto.randomBytes(6).toString("hex")}`, ...base, JSON.stringify([`No plan returned: ${res.category.replace(/_/g, " ")} — ${res.message}`]), last[0]?.id ?? null]);
    }
  });
  return { accepted, invalid, wall_ms: Date.now() - started };
}
