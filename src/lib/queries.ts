import crypto from "node:crypto";
import type {
  AgentRunView, CatalogCase, EventView, EvidenceView, GeneratedPlan, GenerateResponse, IncidentView, Overview, RunDetail, RunSummary, ScenariosView, SnapshotView, SourceView, StartRunRequest, StartRunResponse, TimelineEntry, WorkerView,
} from "./api-types";
import { CATALOG, catalogPlanId } from "./catalog";
import { iso, q, q1, tx } from "./db";
import { lineage } from "./lineage-data";
import { enqueue } from "./queue";
import { SOURCES, type Contract } from "./types";

/** Read models and commands for the dashboard API. Nothing here touches OpenClaw, Git or the filesystem. */

/** A worker that has not written a heartbeat for this long is shown as offline. */
const HEARTBEAT_STALE_SECONDS = 15;

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function snapshotView(r: any): SnapshotView {
  return { id: String(r.id), revision: r.revision, status: r.status, data_as_of: iso(r.data_as_of)!, published_at: iso(r.published_at), contract_versions: r.contract_versions, mapping_rev: r.mapping_rev, finance_net_by_currency: r.totals.finance_net_by_currency ?? {}, dashboards: r.totals.dashboards ?? {}, run_id: r.run_id };
}
const getSnapshot = async (id: string | null): Promise<SnapshotView | null> => {
  if (!id) return null;
  const r = await q1("SELECT * FROM snapshots WHERE id=$1", [id]);
  return r ? snapshotView(r) : null;
};

export async function workerView(): Promise<WorkerView> {
  const hb = await q1<{ last_beat: Date; info: any; age: string }>("SELECT last_beat, info, extract(epoch from now() - last_beat) AS age FROM worker_heartbeat ORDER BY last_beat DESC LIMIT 1");
  if (!hb) return { online: false, last_heartbeat: null, seconds_since_heartbeat: null, agent_mode: null, model_ref: null, openclaw_version: null };
  const age = Math.round(Number(hb.age));
  return { online: age <= HEARTBEAT_STALE_SECONDS, last_heartbeat: iso(hb.last_beat), seconds_since_heartbeat: age, agent_mode: hb.info.agent_mode ?? null, model_ref: hb.info.model_ref ?? null, openclaw_version: hb.info.openclaw_version ?? null };
}

const RUN_SQL = `
  SELECT r.*, p.title AS plan_title, p.origin, p.case_no,
    (SELECT body FROM scores s WHERE s.run_id = r.id) AS score,
    EXISTS (SELECT 1 FROM agent_runs a WHERE a.run_id = r.id AND a.mode='fixture' AND a.status='ok') AS used_fixture,
    EXISTS (SELECT 1 FROM agent_runs a WHERE a.run_id = r.id AND a.mode='live' AND a.status='ok') AS used_live
  FROM runs r LEFT JOIN scenario_plans p ON p.id = r.plan_id`;

function runSummary(r: any): RunSummary {
  return { id: r.id, env_id: r.env_id, kind: r.kind, title: r.title, catalog_title: r.plan_title ?? null, case_no: r.case_no ?? null, status: r.status, outcome: r.outcome, agent_mode: r.agent_mode, used_fixture: r.used_fixture, used_live: r.used_live, created_at: iso(r.created_at)!, started_at: iso(r.started_at), finished_at: iso(r.finished_at), score: r.score ? { matched: r.score.matched, total: r.score.total } : null };
}

function incidentView(r: any): IncidentView {
  return { id: r.id, run_id: r.run_id, correlation_id: r.correlation_id, source: r.source, status: r.status, risk_kind: r.risk_kind, severity: r.severity, title: r.title, what_breaks: r.what_breaks, cause_status: r.cause_status, cause_category: r.cause_category, cause_text: r.cause_text, affected_assets: r.affected_assets, affected_dashboards: (r.affected_assets as string[]).filter((a) => a.startsWith("dash.")), owner: r.owner, freshness: r.freshness, has_verified_fix: r.has_verified_fix, next_action: r.next_action, evidence_ids: r.evidence_ids, opened_at: iso(r.opened_at)!, updated_at: iso(r.updated_at)!, history: r.history, finding: r.finding, repair: r.repair };
}

export async function getRunDetail(id: string): Promise<RunDetail | null> {
  const r = await q1(`${RUN_SQL} WHERE r.id=$1`, [id]);
  if (!r) return null;
  const env = await q1("SELECT * FROM environments WHERE id=$1", [r.env_id]);
  const [incidents, timeline, agents, evidence, events] = await Promise.all([
    q("SELECT * FROM incidents WHERE run_id=$1 ORDER BY opened_at, id", [id]),
    q("SELECT * FROM timeline WHERE run_id=$1 ORDER BY id", [id]),
    q("SELECT * FROM agent_runs WHERE run_id=$1 ORDER BY id", [id]),
    q("SELECT * FROM evidence WHERE run_id=$1 ORDER BY id", [id]),
    q("SELECT * FROM events WHERE run_id=$1 ORDER BY event_time, received_at, id", [id]),
  ]);
  return {
    run: runSummary(r),
    env: env ? { id: env.id, label: env.label, kind: env.kind, health: env.health, health_detail: env.health_detail } : { id: r.env_id, label: r.kind === "rehearsal" ? "Demo pipeline" : "Sandbox", kind: r.kind === "rehearsal" ? "main" : "sandbox", health: "healthy", health_detail: "" },
    snapshot_before: await getSnapshot(r.snapshot_before_id),
    snapshot_after: await getSnapshot(r.snapshot_after_id),
    snapshot_current: await getSnapshot(env?.current_snapshot_id ?? null),
    publish_status: r.status === "completed" ? r.publish_status : "pending",
    incidents: incidents.map(incidentView),
    timeline: timeline.map((t, i): TimelineEntry => ({ seq: i + 1, key: t.key, at: iso(t.at)!, sim_at: iso(t.sim_at)!, actor: t.actor, kind: t.kind, title: t.title, detail: t.detail, incident_id: t.incident_id, evidence_ids: t.evidence_ids, tone: t.tone, data: t.data })),
    agent_runs: agents.map((a): AgentRunView => ({ id: String(a.id), role: a.role, agent_id: a.agent_id, purpose: a.purpose, mode: a.mode, fallback_reason: a.fallback_reason, provider: a.provider, model: a.model, session_key: a.session_key, status: a.status, error_category: a.error_category, error_message: a.error_message, elapsed_ms: a.elapsed_ms, attempt: a.attempt, usage: a.usage, input_excerpt: a.input_excerpt, output_excerpt: a.output_excerpt, created_at: iso(a.created_at)! })),
    evidence: evidence.map((e): EvidenceView => ({ id: e.id, kind: e.kind, title: e.title, incident_id: e.incident_id, body: e.body })),
    events: events.map((e): EventView => ({ id: e.id, type: e.type, source: e.source, event_time: iso(e.event_time)!, received_at: iso(e.received_at)!, correlation_id: e.correlation_id, dedup_key: e.dedup_key, status: e.status, note: e.note, payload: e.payload })),
    timings: r.timings,
    score: r.score,
    error: r.error,
  };
}

export async function getOverview(): Promise<Overview> {
  const env = await q1("SELECT * FROM environments WHERE kind='main' AND current_snapshot_id IS NOT NULL ORDER BY created_at DESC LIMIT 1");
  if (!env) throw new HttpError(503, "No environment yet. Run `npm run db:migrate && npm run db:seed` on the worker host.");
  const lin = lineage();
  const contracts = await q<{ source: string; body: Contract }>("SELECT source, body FROM contracts WHERE env_id=$1 AND status='active'", [env.id]);
  const batches = await q("SELECT DISTINCT ON (source) source, batch_id, seq, row_count, status, received_at FROM feed_batches WHERE env_id=$1 ORDER BY source, received_at DESC, id DESC", [env.id]);
  const sources = SOURCES.map((s): SourceView => {
    const c = contracts.find((x) => x.source === s)!.body;
    const b = batches.find((x) => x.source === s);
    return { id: s, team: c.team, owner: c.owner, contract_version: c.version, field_count: c.fields.length, last_batch: b ? { batch_id: b.batch_id, seq: b.seq, row_count: b.row_count, status: b.status, received_at: iso(b.received_at)! } : null, delivery: { expected_start_min: c.delivery.expected_start_min, hard_deadline_min: c.delivery.hard_deadline_min, grace_min: c.delivery.grace_min }, feeds_dashboards: lin.dataset_impacts[s].filter((a) => a.startsWith("dash.")) };
  });
  const active = await q1<{ id: string }>("SELECT id FROM runs WHERE status IN ('queued','running') ORDER BY created_at LIMIT 1");
  const latestMain = await q1<{ id: string }>("SELECT id FROM runs WHERE kind='rehearsal' ORDER BY created_at DESC LIMIT 1");
  const recent = await q(`${RUN_SQL} ORDER BY r.created_at DESC LIMIT 12`);
  const mainRun = await q1<{ id: string }>("SELECT id FROM runs WHERE env_id=$1", [env.id]);
  const alerts = mainRun ? await q("SELECT * FROM incidents WHERE run_id=$1 ORDER BY opened_at, id", [mainRun.id]) : [];
  return {
    env: { id: env.id, label: env.label, health: env.health, health_detail: env.health_detail, at_baseline: !mainRun },
    snapshot: await getSnapshot(env.current_snapshot_id),
    sources,
    lineage: { nodes: lin.nodes, edges: lin.edges },
    worker: await workerView(),
    active_run_id: active?.id ?? null,
    latest_main_run: latestMain ? await getRunDetail(latestMain.id) : null,
    recent_runs: recent.map(runSummary),
    alerts: alerts.map(incidentView),
  };
}

export async function getScenarios(): Promise<ScenariosView> {
  // The newest scenario run of every plan, however many runs exist.
  const runs = new Map((await q(`${RUN_SQL} WHERE r.id IN (SELECT DISTINCT ON (plan_id) id FROM runs WHERE kind='scenario' ORDER BY plan_id, created_at DESC)`)).map((r) => [r.plan_id as string, runSummary(r)]));
  const last = (planId: string) => runs.get(planId) ?? null;
  const expected = new Map((await q<{ plan_id: string; expected: any }>("SELECT plan_id, expected FROM scenario_expectations WHERE plan_id LIKE 'catalog-%'")).map((e) => [e.plan_id, e.expected]));
  const catalog = CATALOG.map((c): CatalogCase => ({ case_no: c.case_no, plan_id: catalogPlanId(c.case_no), title: c.title, team: c.team, summary: `${c.summary} Expected: ${c.expected_result}`, expected_outcome: expected.get(catalogPlanId(c.case_no))?.outcome ?? c.plan.expected_outcome.outcome, quick: c.quick, last_run: last(catalogPlanId(c.case_no)) }));
  const plans = await q("SELECT p.*, a.mode AS a_mode, a.model AS a_model FROM scenario_plans p LEFT JOIN agent_runs a ON a.id = p.agent_run_id WHERE p.origin='agent' ORDER BY p.created_at DESC, p.id LIMIT 80");
  const generated = plans.map((p): GeneratedPlan => ({ id: p.id, batch_id: p.batch_id, author_role: p.author_role, agent_id: p.agent_id, team: p.team, seed: Number(p.seed), status: p.status, reasons: p.reasons, attempt: p.attempt, mode: p.a_mode ?? "fixture", model: p.a_model ?? null, title: p.title, mutation_summary: p.summary, event_count: p.plan?.events?.length ?? 0, created_at: iso(p.created_at)!, last_run: last(p.id) }));
  const job = await q1("SELECT * FROM jobs WHERE type='scenarios.generate' ORDER BY id DESC LIMIT 1");
  return { catalog, generated, generation: job ? { job_id: String(job.id), status: job.status, batch_id: job.payload.batch_id, seed: job.payload.seed, created_at: iso(job.created_at)!, error: job.status === "failed" ? (job.last_error ?? null) : null } : null, worker: await workerView() };
}

const FAULTS = ["bad_repair", "agent_unavailable", "malformed_output"];

/** Validate, persist a run and its job, and return immediately with the run ID. */
export async function startRun(body: StartRunRequest): Promise<StartRunResponse> {
  if (!body || (body.kind !== "rehearsal" && body.kind !== "scenario")) throw new HttpError(400, "kind must be 'rehearsal' or 'scenario'");
  if (body.fault != null && !FAULTS.includes(body.fault)) throw new HttpError(400, `fault must be one of ${FAULTS.join(", ")}`);
  const planId = body.kind === "rehearsal" ? catalogPlanId(1) : body.plan_id;
  if (typeof planId !== "string") throw new HttpError(400, "plan_id is required for a scenario run");
  const plan = await q1<{ status: string; plan: { starting_snapshot: string } }>("SELECT status, plan FROM scenario_plans WHERE id=$1", [planId]);
  if (!plan) throw new HttpError(404, `unknown plan ${planId}`);
  if (plan.status !== "accepted") throw new HttpError(409, "this plan was rejected by validation and cannot be replayed");
  const hex = crypto.randomBytes(6).toString("hex");
  const id = `run_${hex}`;
  const title = body.kind === "rehearsal" ? `Schema-change rehearsal R-${hex.slice(0, 4).toUpperCase()}` : `Scenario replay S-${hex.slice(0, 4).toUpperCase()}`;
  const hb = await workerView();
  // One transaction: a run without its job would sit in "queued" forever and block the rehearsal button.
  await tx(async (db) => {
    await q("INSERT INTO runs (id,env_id,kind,plan_id,title,options,agent_mode) VALUES ($1,$2,$3,$4,$5,$6,$7)", [id, `env_${hex}`, body.kind, planId, title, JSON.stringify({ fault: body.fault ?? null }), hb.agent_mode ?? "auto"], db);
    await enqueue("run.execute", { run_id: id }, { dedupKey: `run:${id}`, serialKey: `fixture:${plan.plan.starting_snapshot}` }, db);
  });
  return { run_id: id };
}

export async function startGeneration(body: { seed?: number }): Promise<GenerateResponse> {
  const seed = body?.seed ?? Math.floor(Date.now() / 1000) % 1_000_000;
  if (!Number.isInteger(seed) || seed < 0 || seed > 2_000_000_000) throw new HttpError(400, "seed must be a non-negative integer");
  // The lock makes "is one already going?" and "start one" a single step, so two clicks cannot start two batches.
  return tx(async (db) => {
    await q("SELECT pg_advisory_xact_lock(hashtext('scenarios.generate'))", [], db);
    const running = await q1<{ id: string; payload: any }>("SELECT id, payload FROM jobs WHERE type='scenarios.generate' AND status IN ('queued','running') LIMIT 1", [], db);
    if (running) return { job_id: String(running.id), batch_id: running.payload.batch_id };
    const batch_id = `batch_${crypto.randomBytes(4).toString("hex")}`;
    const job_id = await enqueue("scenarios.generate", { batch_id, seed }, { dedupKey: `generate:${batch_id}`, maxAttempts: 1 }, db);
    return { job_id: String(job_id), batch_id };
  });
}
