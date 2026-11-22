import crypto from "node:crypto";
import type { AgentMode, CheckResult, FindingView, Outcome, Owner, RepairView, Timings } from "./api-types";
import { callAgent, roleLabel, type AgentCtx } from "./agents/call";
import { parseFinding, parseRepair, type Finding } from "./agents/schemas";
import { categoryForBatchProblems, classifyChanges, diffContracts, traceImpact, validateBatch, type BatchProblem, type Classification } from "./contracts";
import { cfg } from "./config";
import { q, q1, tx } from "./db";
import { baselineContract, baselineData, lineage, simTime, REFRESH_MIN } from "./fixtures";
import { applyRepair, createRepairWorktree, isAncestor, readMappings, removeWorktree, revisionDir, runPipelineAt, runPipelineRev, runRepoTests, setEnvBranch } from "./fixture-repo";
import { centsToDecimal, diffCentMaps } from "./money";
import { buildEffect, MUTATION_SPECS, type MutationEffect } from "./mutations";
import { applyOperations, assertionGate, OPERATION_DOCS, type RepairOperation } from "./repair-ops";
import { reconcile } from "./replay";
import { DEFAULT_TIMING, mutationsOf, normalizeEvents, OUTCOME_RANK, type PlanSansExpectation } from "./scenario";
import { scoreRun } from "./scorer";
import { activeContract, createEnvironment, getEnv, refreshAndPublish } from "./snapshot";
import { CAUSE_CATEGORIES, SOURCES, type CauseCategory, type Contract, type Row, type SourceId } from "./types";

const PLATFORM_OWNER: Owner = { team: "data-platform", name: "Data Platform", contact: "#data-platform" };
const OWNER_TEAMS = ["orders", "payments", "shipping", "data-platform"];

interface Signal {
  correlation: string;
  source: SourceId | "warehouse";
  outcome: Outcome | null;
  watcher_category: CauseCategory | "none";
  dashboards: string[];
  incident_id: string | null;
}

interface ProposalState {
  effect: MutationEffect;
  candidate: Contract;
  correlation: string;
  effective_min: number;
  status: "verified" | "pending_clarification" | "blocked" | "withdrawn" | "activated";
  candidate_rev: string | null;
  incident_id: string | null;
  had_repair: boolean;
  signal: Signal;
}

interface Item {
  at: number;
  seq: number;
  kind: "proposal" | "withdraw" | "other";
  fn: () => Promise<void>;
}

/** Thrown when the worker no longer holds the job lease; the run stops without committing further state. */
export class LeaseLost extends Error {}

export interface RunHooks {
  /** Called between steps; throw LeaseLost to stop. */
  checkpoint?: () => Promise<void>;
}

class Run {
  private items: Item[] = [];
  private seq = 0;
  private evidenceN = 0;
  private timelineN = 0;
  private now = 0;
  private stepStarted = Date.now();
  private signals: Signal[] = [];
  private proposals = new Map<SourceId, ProposalState>();
  private delivery = new Map<SourceId, { started: number | null; progress: number | null; applied: boolean; quarantined: boolean; warning_incident: string | null }>();
  private gateClosed = false;
  private published = false;
  private ignored = 0;
  private marks: { trigger?: number; alert?: number; diagnosis?: number; verified?: number; trigger_sim?: number; alert_sim?: number; diagnosis_sim?: number; verified_sim?: number; publish_sim?: number } = {};
  private toolMs = 0;
  private replayMs = 0;
  private data!: Record<SourceId, Row[]>;
  private agent!: AgentCtx;
  private snapshotBefore!: { id: string; revision: number; data_as_of: string; dashboards: Record<string, Record<string, string>> };
  private snapshotAfterId: string | null = null;
  private short: string;

  constructor(private runId: string, private envId: string, private plan: PlanSansExpectation, private mode: AgentMode, private faults: string[], private hooks: RunHooks) {
    this.short = runId.replace(/^run_/, "").slice(0, 8);
  }

  // ---------- small persistence helpers ----------

  private simAt(): Date {
    // Simulated clock: the scripted offset plus real time spent inside the current step.
    return new Date(simTime(this.now).getTime() + (Date.now() - this.stepStarted));
  }
  private simMin(): number {
    return Math.round((this.now + (Date.now() - this.stepStarted) / 60_000) * 100) / 100;
  }

  private async timeline(e: { actor: string; kind: string; title: string; detail?: string | null; incident_id?: string | null; evidence_ids?: string[]; tone?: "neutral" | "good" | "warn" | "bad"; data?: unknown }): Promise<void> {
    const key = `t${String(++this.timelineN).padStart(3, "0")}`;
    await q(
      `INSERT INTO timeline (run_id,key,sim_at,actor,kind,title,detail,incident_id,evidence_ids,tone,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (run_id,key) DO NOTHING`,
      [this.runId, key, this.simAt(), e.actor, e.kind, e.title, e.detail ?? null, e.incident_id ?? null, e.evidence_ids ?? [], e.tone ?? "neutral", e.data === undefined ? null : JSON.stringify(e.data)],
    );
  }

  private async evidence(kind: string, title: string, body: unknown, incidentId: string | null): Promise<{ id: string; kind: string; title: string; body: unknown }> {
    const id = `E-${this.short}-${String(++this.evidenceN).padStart(2, "0")}`;
    await q("INSERT INTO evidence (run_id,id,incident_id,kind,title,body) VALUES ($1,$2,$3,$4,$5,$6)", [this.runId, id, incidentId, kind, title, JSON.stringify(body)]);
    return { id, kind, title, body };
  }

  /** Persist an event envelope. A second delivery of the same logical event is stored as a duplicate and not processed. */
  private async emit(type: string, source: string, correlation: string, dedupKey: string, payload: unknown, note?: string): Promise<boolean> {
    const id = `evt_${crypto.randomBytes(8).toString("hex")}`;
    const at = this.simAt();
    const inserted = await q(
      `INSERT INTO events (id,version,type,source,event_time,received_at,run_id,correlation_id,dedup_key,status,note,payload)
       VALUES ($1,1,$2,$3,$4,$4,$5,$6,$7,'accepted',$8,$9) ON CONFLICT (run_id,dedup_key) WHERE status <> 'duplicate' DO NOTHING RETURNING id`,
      [id, type, source, at, this.runId, correlation, dedupKey, note ?? null, JSON.stringify(payload)],
    );
    if (inserted.length) return true;
    await q(`INSERT INTO events (id,version,type,source,event_time,received_at,run_id,correlation_id,dedup_key,status,note,payload) VALUES ($1,1,$2,$3,$4,$4,$5,$6,$7,'duplicate',$8,$9)`, [id, type, source, at, this.runId, correlation, dedupKey, "Duplicate of an event already processed", JSON.stringify(payload)]);
    return false;
  }

  private async freshness(label: "healthy" | "at_risk" | "delayed" = "healthy") {
    return { snapshot_revision: this.snapshotBefore.revision, data_as_of: this.snapshotBefore.data_as_of, label };
  }

  private async openIncident(i: { correlation: string; source: string; status: string; risk_kind: "future_change" | "current_data"; severity: string; title: string; what_breaks: string; watcher_category: string; assets: string[]; owner: Owner; next_action: string; evidence_ids: string[] }): Promise<string> {
    const id = `inc_${this.short}_${i.correlation.replace(/[^a-z0-9]+/gi, "_")}`;
    const history = [{ at: new Date().toISOString(), status: i.status, note: i.title }];
    await q(
      `INSERT INTO incidents (id,run_id,env_id,correlation_id,source,status,risk_kind,severity,title,what_breaks,watcher_category,affected_assets,owner,freshness,next_action,evidence_ids,history)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT (run_id,correlation_id) DO NOTHING`,
      [id, this.runId, this.envId, i.correlation, i.source, i.status, i.risk_kind, i.severity, i.title, i.what_breaks, i.watcher_category, i.assets, JSON.stringify(i.owner), JSON.stringify(await this.freshness()), i.next_action, i.evidence_ids, JSON.stringify(history)],
    );
    this.marks.alert ??= Date.now();
    this.marks.alert_sim ??= this.simMin();
    await this.timeline({ actor: "Watcher", kind: "alert", title: `Alert opened: ${i.title}`, detail: i.what_breaks, incident_id: id, evidence_ids: i.evidence_ids, tone: "warn" });
    return id;
  }

  /** Update the SAME incident as diagnosis and repair progress; every change is appended to its history. */
  private async updateIncident(id: string, patch: Record<string, unknown>, note: string): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [id];
    for (const [k, v] of Object.entries(patch)) {
      vals.push(["finding", "repair", "owner", "freshness"].includes(k) ? JSON.stringify(v) : v);
      sets.push(`${k}=$${vals.length}`);
    }
    vals.push(JSON.stringify([{ at: new Date().toISOString(), status: (patch.status as string) ?? "update", note }]));
    await q(`UPDATE incidents SET ${sets.join(",")}${sets.length ? "," : ""} history = history || $${vals.length}::jsonb, updated_at=now() WHERE id=$1`, vals);
  }

  private schedule(at: number, fn: () => Promise<void>, kind: Item["kind"] = "other"): void {
    this.items.push({ at, seq: this.seq++, kind, fn });
  }

  // ---------- main loop ----------

  async execute(): Promise<void> {
    const kind = (await q1<{ kind: string }>("SELECT kind FROM runs WHERE id=$1", [this.runId]))!.kind;
    // A retried job starts from a clean slate; completed agent turns are kept and reused.
    for (const t of ["events", "incidents", "evidence", "timeline"]) await q(`DELETE FROM ${t} WHERE run_id=$1`, [this.runId]);
    await q("DELETE FROM scores WHERE run_id=$1", [this.runId]);
    const env = await createEnvironment(this.envId, kind === "rehearsal" ? "Demo pipeline" : `Sandbox ${this.short}`, kind === "rehearsal" ? "main" : "sandbox", this.plan.starting_snapshot);
    const snap = (await q1<{ id: string; revision: number; data_as_of: Date; totals: { dashboards: Record<string, Record<string, string>> } }>("SELECT id, revision, data_as_of, totals FROM snapshots WHERE id=$1", [env.current_snapshot_id]))!;
    this.snapshotBefore = { id: snap.id, revision: snap.revision, data_as_of: new Date(snap.data_as_of).toISOString(), dashboards: snap.totals.dashboards };
    await q("UPDATE runs SET snapshot_before_id=$2 WHERE id=$1", [this.runId, snap.id]);
    this.data = baselineData(this.plan.starting_snapshot);
    this.agent = { runId: this.runId, mode: this.mode, faults: [...this.faults, ...(this.plan.faults ?? [])] };
    for (const s of SOURCES) this.delivery.set(s, { started: null, progress: null, applied: false, quarantined: false, warning_incident: null });

    const finance = Object.entries(snap.totals.dashboards.finance).filter(([k]) => k.startsWith("net_revenue_cents.")).map(([k, v]) => `${k.split(".")[1]} ${centsToDecimal(v)}`).join(", ");
    await this.timeline({ actor: "Schema Guard", kind: "info", title: `Starting from verified snapshot r${snap.revision}`, detail: `Finance net revenue ${finance}; data as of ${this.snapshotBefore.data_as_of}; mapping ${env.active_mapping_rev.slice(0, 7)}. Simulated clock starts at ${simTime(0).toISOString()}.`, tone: "good" });

    this.buildScript();
    while (this.items.length) {
      this.items.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const item = this.items.shift()!;
      if (this.gateClosed && item.kind === "other") continue;
      await this.hooks.checkpoint?.();
      this.now = item.at;
      this.stepStarted = Date.now();
      await item.fn();
    }
    await this.finish();
  }

  private buildScript(): void {
    const events = normalizeEvents(this.plan);
    const effects = mutationsOf(this.plan).map((m) => buildEffect(m, baselineContract(effectSource(m)), this.data[effectSource(m)]));
    for (const src of SOURCES) {
      const eff = effects.find((e) => e.source === src) ?? null;
      const mine = events.filter((e) => e.source === src);
      const proposal = mine.find((e) => e.type === "source.change.proposed");
      const withdrawn = mine.find((e) => e.type === "source.change.withdrawn");
      const find = (t: string) => mine.find((e) => e.type === t && (e.payload.batch ?? "cycle") === "cycle");
      const base = DEFAULT_TIMING[src];
      const effective = proposal ? proposal.offset_min + (proposal.payload.effective_in_min as number) : null;
      const defaults = eff?.mode === "delivery" ? { started: null, progress: null, arrived: null } : { ...base, arrived: effective !== null && !withdrawn && base.arrived <= effective ? effective + 15 : base.arrived };
      const started = find("source.export.started")?.offset_min ?? defaults.started;
      const progressEv = find("source.export.progress");
      const progress = progressEv?.offset_min ?? (eff?.mode === "delivery" ? null : defaults.progress);
      const arrived = find("source.batch.arrived")?.offset_min ?? defaults.arrived;

      if (eff && proposal && effective !== null) this.schedule(proposal.offset_min, () => this.onProposed(src, eff, effective), "proposal");
      if (withdrawn) this.schedule(withdrawn.offset_min, () => this.onWithdrawn(src, (withdrawn.payload.reason as string) ?? null), "withdraw");
      if (started !== null) this.schedule(started, () => this.onExportStarted(src));
      if (progress !== null) this.schedule(progress, () => this.onExportProgress(src, (progressEv?.payload.percent as number) ?? 60));
      if (arrived !== null) this.schedule(arrived, () => this.onBatchArrived(src, eff, "cycle"));
      const extras = mine.filter((e) => e.type === "source.batch.arrived" && e.payload.batch && e.payload.batch !== "cycle");
      for (const x of extras) this.schedule(x.offset_min, () => this.onBatchArrived(src, eff, x.payload.batch as "redelivery" | "stale"));
      if (eff?.mode === "extra_batch" && extras.length === 0 && arrived !== null) this.schedule(arrived + 25, () => this.onBatchArrived(src, eff, eff.extra!));

      const c = baselineContract(src);
      this.schedule(c.delivery.expected_start_min + c.delivery.grace_min, () => this.checkStarted(src, c));
      this.schedule(c.delivery.hard_deadline_min, () => this.checkDeadline(src, c));
    }
    this.schedule(REFRESH_MIN + 0.001, () => this.refresh());
  }

  // ---------- proposed contract change ----------

  private async onProposed(src: SourceId, eff: MutationEffect, effectiveMin: number): Promise<void> {
    const current = await activeContract(this.envId, src);
    const candidate = eff.candidateContract!;
    const correlation = `chg-${src}-v${candidate.version}`;
    const currentRows = this.data[src];
    const sample = { current: currentRows.slice(0, 3), proposed: (eff.rows ?? []).slice(0, 3) };
    const declaredUnits = Object.fromEntries(candidate.fields.filter((f) => f.unit !== null).map((f) => [f.name, f.unit]));
    const accepted = await this.emit("source.change.proposed", src, correlation, `change:${src}:v${candidate.version}`, {
      change_id: `CHG-${this.short}-${src}`,
      pull_request: { title: `Update ${src} feed contract to v${candidate.version}`, author: `${current.team}-bot`, state: "open" },
      source_team: current.team,
      owner: current.owner,
      current_version: current.version,
      proposed_version: candidate.version,
      intended_effective_at: simTime(effectiveMin).toISOString(),
      proposed_contract: candidate,
      representative_rows: sample,
      producer_declared_units: declaredUnits,
    });
    this.marks.trigger ??= Date.now();
    this.marks.trigger_sim ??= this.simMin();
    await this.timeline({ actor: `${current.owner.name} (producer)`, kind: "event", title: `Proposed ${src} contract v${candidate.version}, effective ${simTime(effectiveMin).toISOString().slice(11, 16)} UTC`, detail: `Pull request "Update ${src} feed contract to v${candidate.version}". Not active yet: Finance keeps reading snapshot r${this.snapshotBefore.revision}.`, tone: accepted ? "neutral" : "warn" });
    if (!accepted) return;
    await q("INSERT INTO contracts (env_id,source,version,status,body,run_id) VALUES ($1,$2,$3,'candidate',$4,$5) ON CONFLICT (env_id,source,version) DO UPDATE SET status='candidate', body=EXCLUDED.body", [this.envId, src, candidate.version, JSON.stringify(candidate), this.runId]);

    const changes = diffContracts(current, candidate);
    const cls = classifyChanges(current, candidate, changes, currentRows);
    const impact = cls.risk === "breaking" ? traceImpact(src, cls.affected_fields) : { assets: [] as string[], dashboards: [] as string[] };
    const signal: Signal = { correlation, source: src, outcome: null, watcher_category: cls.category, dashboards: impact.dashboards, incident_id: null };
    this.signals.push(signal);
    const state: ProposalState = { effect: eff, candidate, correlation, effective_min: effectiveMin, status: "blocked", candidate_rev: null, incident_id: null, had_repair: false, signal };
    this.proposals.set(src, state);

    const baseRev = (await getEnv(this.envId))!.active_mapping_rev;
    const candidateInput = { ...this.currentInput(), [src]: eff.rows! };

    if (cls.risk !== "breaking") {
      // Safe additive change: prove it with a replay under the unchanged mapping and move on. No investigation.
      const t0 = Date.now();
      const [b, c] = await Promise.all([runPipelineRev(baseRev, this.currentInput()), runPipelineRev(baseRev, candidateInput)]);
      const rep = reconcile(b, c);
      this.replayMs += Date.now() - t0;
      const sampleOk = validateBatch(candidate, eff.rows!).ok;
      await this.timeline({ actor: "Watcher", kind: "watcher", title: `${src} v${candidate.version} is additive: ${cls.summary}`, detail: `${changes.length} difference(s) against the active contract. No downstream field is touched, so no investigation is opened.`, tone: "good", data: { changes } });
      if (rep.passed && sampleOk) {
        await this.timeline({ actor: "Replay", kind: "replay", title: "Replay under the current mapping: totals unchanged", detail: `${rep.checks.length} checks passed on the same logical records.`, tone: "good", data: { checks: rep.checks } });
        state.status = "verified";
        this.schedule(effectiveMin, () => this.activate(src));
        return;
      }
      Object.assign(impact, traceImpact(src, []));
      signal.dashboards = impact.dashboards;
      await this.timeline({ actor: "Replay", kind: "replay", title: "Additive change did not replay cleanly; treating it as breaking", detail: rep.checks.find((x) => !x.passed)?.detail ?? "candidate sample violates the proposed contract", tone: "bad", data: { checks: rep.checks } });
    }

    // Breaking or semantic change: open a rehearsal before it can ship.
    const ev = [
      await this.evidence("current_contract", `Active ${src} contract v${current.version}`, current, null),
      await this.evidence("proposed_contract", `Proposed ${src} contract v${candidate.version}`, candidate, null),
      await this.evidence("contract_diff", "Structural differences between active and proposed contract", { changes }, null),
      await this.evidence("sample_rows", "Representative rows before and after", sample, null),
      await this.evidence("current_mapping", `Active downstream mapping for ${src}`, readMappings(await revisionDir(baseRev))[src], null),
      await this.evidence("lineage_impact", "Downstream assets from lineage", { changed_fields: cls.affected_fields, ...impact, edges: lineage().edges.filter((e) => impact.assets.includes(e.to)) }, null),
      await this.evidence("ownership", "Owner of the changing feed", current.owner, null),
    ];
    const sampleCheck = validateBatch(candidate, eff.rows!);
    if (!sampleCheck.ok) ev.push(await this.evidence("candidate_sample_check", "Proposed rows checked against the proposed contract", { problems: sampleCheck.problems }, null));
    ev.push(await this.evidence("feed_events", "Feed and job events so far in this cycle", await this.recentEvents(), null));
    const evIds = ev.map((e) => e.id);
    const labels = impact.dashboards.map(dashLabel).join(" and ") || "downstream models";
    await this.timeline({ actor: "Watcher", kind: "watcher", title: `Compared ${src} v${candidate.version} with active v${current.version}: ${changes.length} difference(s)`, detail: cls.summary, evidence_ids: [ev[2].id], tone: "warn", data: { changes } });
    await this.timeline({ actor: "Watcher", kind: "impact", title: `At risk before release: ${labels}`, detail: `Lineage traces ${cls.affected_fields.length ? cls.affected_fields.map((f) => `${src}.${f}`).join(", ") : `the ${src} feed`} to ${impact.assets.join(", ")}.`, evidence_ids: [ev[5].id], tone: "warn", data: impact });

    const incidentId = await this.openIncident({
      correlation, source: src, status: "at_risk", risk_kind: "future_change", severity: impact.dashboards.includes("dash.finance") ? "high" : "medium",
      title: `Proposed ${src} contract v${candidate.version} would break ${labels}`,
      what_breaks: `${cls.summary} If it shipped today, ${labels} would be wrong or fail to refresh. Current numbers are unaffected: the change is not active.`,
      watcher_category: cls.category, assets: impact.assets, owner: current.owner, next_action: "Investigating before release.", evidence_ids: evIds,
    });
    state.incident_id = incidentId;
    signal.incident_id = incidentId;
    await q("UPDATE evidence SET incident_id=$3 WHERE run_id=$1 AND id = ANY($2)", [this.runId, evIds, incidentId]);

    const finding = await this.investigate(incidentId, { type: "source.change.proposed", source: src, summary: `The ${src} team proposed contract v${candidate.version}, intended to take effect at ${simTime(effectiveMin).toISOString()}. It is not active yet.` }, ev, current.owner.team);
    await this.rehearseRepair(state, src, current, candidate, changes, cls, finding, baseRev, candidateInput);
  }

  private currentInput(): Record<SourceId, Row[]> {
    return { orders: this.data.orders, payments: this.data.payments, shipping: this.data.shipping };
  }

  private async recentEvents() {
    return (await q("SELECT type, source, event_time, status FROM events WHERE run_id=$1 ORDER BY event_time, id", [this.runId])).map((e) => ({ type: e.type, source: e.source, at: new Date(e.event_time).toISOString(), status: e.status }));
  }

  /** Ask the investigator for a structured finding. Its evidence IDs must exist for THIS run. */
  private async investigate(incidentId: string, trigger: { type: string; source: string; summary: string }, ev: { id: string; kind: string; title: string; body: unknown }[], ownerTeam: string): Promise<FindingView> {
    await this.updateIncident(incidentId, { status: "investigating" }, "Investigator started");
    const lin = lineage();
    const packet = { task: "investigate", trigger, evidence: ev, lineage_nodes: lin.nodes, owners: OWNER_TEAMS, cause_categories: CAUSE_CATEGORIES };
    const available = ev.map((e) => e.id);
    const res = await callAgent<Finding>(this.agent, { role: "investigator", purpose: `investigate:${incidentId}`, packet, parse: (t) => parseFinding(t, available, OWNER_TEAMS) });
    await this.noteAgentAttempts("investigator", incidentId, `investigate:${incidentId}`);
    let view: FindingView;
    if (res.ok) {
      const f = res.value;
      view = { source: "agent", valid: true, validation_errors: [], observed_facts: f.observed_facts, cause_status: f.cause_status, cause_category: f.cause_category, candidate_cause: f.candidate_cause, evidence_ids: f.evidence_ids, impacted_assets: f.impacted_assets, owner_team: f.owner, severity: f.severity, next_verification_step: f.next_verification_step ?? null };
      this.marks.diagnosis ??= Date.now();
      this.marks.diagnosis_sim ??= this.simMin();
      await this.updateIncident(incidentId, { status: "diagnosed", cause_status: f.cause_status, cause_category: f.cause_category, cause_text: f.candidate_cause, severity: f.severity, finding: view }, `Diagnosis (${f.cause_status}): ${f.candidate_cause}`);
      await this.timeline({ actor: `${roleLabel("investigator")}${res.mode === "fixture" ? " · Fixture mode" : ` · ${res.provider}/${res.model}`}`, kind: "agent", title: `Finding (${f.cause_status}): ${f.candidate_cause}`, detail: f.observed_facts.map((o) => `• ${o.statement} [${o.evidence_ids.join(", ")}]`).join("\n"), incident_id: incidentId, evidence_ids: f.evidence_ids, tone: "neutral", data: { impacted_assets: f.impacted_assets, owner: f.owner, cause_category: f.cause_category } });
    } else {
      view = { source: "deterministic_fallback", valid: false, validation_errors: [`${res.category}: ${res.message}`], observed_facts: [], cause_status: "unknown", cause_category: "unknown", candidate_cause: `No agent diagnosis (${res.category.replace(/_/g, " ")}). Deterministic checks below still decide what may publish.`, evidence_ids: [], impacted_assets: [], owner_team: ownerTeam, severity: "high", next_verification_step: "Re-run the investigation when the agent runtime is reachable." };
      await this.updateIncident(incidentId, { cause_status: "unknown", cause_category: "unknown", cause_text: view.candidate_cause, finding: view }, `Investigator unavailable: ${res.category}`);
      await this.timeline({ actor: roleLabel("investigator"), kind: "error", title: `No diagnosis from the investigator: ${res.category.replace(/_/g, " ")}`, detail: `${res.message}\nPublication stays under deterministic validation; nothing is activated on an agent's say-so or its absence.`, incident_id: incidentId, tone: "bad" });
    }
    return view;
  }

  /** Surface rejected or failed attempts (malformed output, foreign evidence IDs, provider errors) on the timeline. */
  private async noteAgentAttempts(role: "investigator" | "repair", incidentId: string, purpose: string): Promise<void> {
    const failed = await q<{ attempt: number; error_category: string; error_message: string; mode: string }>("SELECT attempt, error_category, error_message, mode FROM agent_runs WHERE run_id=$1 AND purpose=$2 AND status='error' ORDER BY id", [this.runId, purpose]);
    for (const f of failed)
      await this.timeline({ actor: roleLabel(role), kind: "error", title: `Attempt ${f.attempt} rejected: ${f.error_category.replace(/_/g, " ")}`, detail: f.error_message, incident_id: incidentId, tone: "warn" });
  }

  private async rehearseRepair(state: ProposalState, src: SourceId, current: Contract, candidate: Contract, changes: ReturnType<typeof diffContracts>, cls: Classification, finding: FindingView, baseRev: string, candidateInput: Record<SourceId, Row[]>): Promise<void> {
    const incidentId = state.incident_id!;
    const mappings = readMappings(await revisionDir(baseRev));
    const repair: RepairView = { decision: "not_attempted", operations: [], assumptions: [], expected_invariants: [], missing_facts: [], question_for_owner: null, gate: null, base_rev: baseRev, candidate_rev: null, branch: null, diff: null, repo_tests: null, replay: null, status: "pending" };
    const save = (note: string, patch: Record<string, unknown> = {}) => this.updateIncident(incidentId, { repair, ...patch }, note);
    const block = async (status: "pending_clarification" | "blocked", outcome: Outcome, next: string, title: string, detail: string) => {
      state.status = status;
      state.signal.outcome = outcome;
      repair.status = status === "pending_clarification" ? "blocked" : repair.status === "pending" ? "blocked" : repair.status;
      this.gateClosed = true;
      await q("UPDATE contracts SET status=$4 WHERE env_id=$1 AND source=$2 AND version=$3", [this.envId, src, candidate.version, status === "pending_clarification" ? "pending_clarification" : "rejected"]);
      await save(title, { status: status === "pending_clarification" ? "pending_clarification" : "blocked", has_verified_fix: false, next_action: next });
      await this.timeline({ actor: "Release gate", kind: "gate", title, detail, incident_id: incidentId, tone: "bad" });
    };

    const res = finding.valid || !this.agent.faults.includes("agent_unavailable")
      ? await callAgent(this.agent, { role: "repair", purpose: `repair:${incidentId}`, packet: { task: "repair", finding: { cause_status: finding.cause_status, cause_category: finding.cause_category, candidate_cause: finding.candidate_cause, evidence_ids: finding.evidence_ids }, source: src, current_contract: current, proposed_contract: candidate, contract_changes: changes, current_mapping: mappings[src], allowed_operations: OPERATION_DOCS, sample_rows: { current: this.data[src].slice(0, 3), proposed: state.effect.rows!.slice(0, 3) } }, parse: parseRepair })
      : ({ ok: false, category: "unavailable", message: "Agent runtime unreachable" } as const);
    await this.noteAgentAttempts("repair", incidentId, `repair:${incidentId}`);

    if (!res.ok) {
      // No proposal. Deterministic validation still runs and still decides.
      const t0 = Date.now();
      const [b, c] = await Promise.all([runPipelineRev(baseRev, this.currentInput()), runPipelineRev(baseRev, candidateInput)]);
      repair.replay = reconcile(b, c);
      this.replayMs += Date.now() - t0;
      repair.status = "failed";
      await this.timeline({ actor: roleLabel("repair"), kind: "error", title: `No repair proposal: ${res.category.replace(/_/g, " ")}`, detail: res.message, incident_id: incidentId, tone: "bad" });
      await this.timeline({ actor: "Replay", kind: "replay", title: `Deterministic check without a repair: ${repair.replay.passed ? "passes" : `fails at "${label(repair.replay)}"`}`, detail: repair.replay.checks.find((x) => !x.passed)?.detail ?? "candidate rows replay cleanly under the active mapping", incident_id: incidentId, tone: repair.replay.passed ? "good" : "bad", data: { checks: repair.replay.checks } });
      return block("blocked", "hold_previous_snapshot", "Agent runtime unavailable. The change stays behind the release gate; re-run the rehearsal when OpenClaw and the provider are reachable.", "Change held: no verified repair", `Without a repair the candidate fails "${label(repair.replay)}". Snapshot r${this.snapshotBefore.revision} remains the published version.`);
    }

    const p = res.value;
    Object.assign(repair, { decision: p.decision, operations: p.operations, assumptions: p.assumptions, expected_invariants: p.expected_invariants, missing_facts: p.missing_facts, question_for_owner: p.question_for_owner ?? null });
    const who = `${roleLabel("repair")}${res.mode === "fixture" ? " · Fixture mode" : ` · ${res.provider}/${res.model}`}`;

    if (p.decision !== "propose") {
      const ambiguous = p.decision === "need_contract_fact" || cls.category === "ambiguous_contract";
      await this.timeline({ actor: who, kind: "agent", title: ambiguous ? "Repair agent needs a contract fact from the owner" : "Repair agent: no safe mapping repair exists", detail: [...p.missing_facts.map((m) => `• ${m}`), p.question_for_owner ?? ""].filter(Boolean).join("\n"), incident_id: incidentId, tone: "warn" });
      if (ambiguous) {
        repair.gate = { passed: false, required: (p.missing_facts.length ? p.missing_facts : ["Declared unit and rename for the changed field"]).map((m) => ({ assertion: m, present: false, detail: "not declared in the proposed contract" })) };
        return block("pending_clarification", "block_pending_clarification", `${current.owner.name} (${current.owner.contact}) must confirm: ${p.question_for_owner ?? p.missing_facts.join("; ")}`, "Blocked pending clarification", "The proposed contract does not declare what the mapping would need to rely on. Matching sample values cannot establish an undocumented contract, so nothing is activated.");
      }
      repair.status = "blocked";
      return block("blocked", "hold_previous_snapshot", `${current.owner.name} (${current.owner.contact}) must revise the proposal: ${p.question_for_owner ?? "no downstream mapping can absorb this change"}`, "Change rejected: no safe repair", `Snapshot r${this.snapshotBefore.revision} remains published. ${p.question_for_owner ?? ""}`);
    }

    await this.timeline({ actor: who, kind: "agent", title: `Proposed repair: ${p.operations.map((o) => o.op).join(" + ")}`, detail: p.operations.map((o) => `• ${describeOp(o)}`).join("\n") + (p.assumptions.length ? `\nAssumes: ${p.assumptions.join(" ")}` : ""), incident_id: incidentId, tone: "neutral", data: { operations: p.operations } });

    // Apply in an isolated worktree of the fixture repository.
    const t0 = Date.now();
    const wt = await createRepairWorktree(`${this.short}-${src}`, baseRev);
    repair.branch = wt.branch;
    let repaired: ReturnType<typeof applyOperations>;
    try {
      repaired = applyOperations(mappings, p.operations, { [src]: candidate.version });
      const applied = await applyRepair(wt, p.operations, { candidateVersion: { [src]: candidate.version }, paymentsSample: src === "payments" ? state.effect.rows!.slice(0, 8) : undefined, message: `Repair ${src} mapping for contract v${candidate.version}\n\n${p.operations.map((o) => `- ${describeOp(o)}`).join("\n")}` });
      repair.candidate_rev = applied.candidate_rev;
      repair.diff = applied.diff;
    } catch (err) {
      this.toolMs += Date.now() - t0;
      repair.status = "failed";
      await removeWorktree(wt.dir);
      await this.timeline({ actor: "Repair worker", kind: "repair", title: "Repair could not be applied", detail: (err as Error).message, incident_id: incidentId, tone: "bad" });
      return block(cls.category === "ambiguous_contract" ? "pending_clarification" : "blocked", cls.category === "ambiguous_contract" ? "block_pending_clarification" : "hold_previous_snapshot", "Repair proposal was not applicable to the mapping. Needs a revised proposal or owner input.", "Change held: repair not applicable", (err as Error).message);
    }
    await this.timeline({ actor: "Repair worker", kind: "repair", title: `Applied on branch ${wt.branch} (${wt.base_rev.slice(0, 7)} → ${repair.candidate_rev!.slice(0, 7)})`, detail: "Isolated Git worktree of the fixture pipeline repository. Only mapping files and the payments sample may change.", incident_id: incidentId, tone: "neutral", data: { diff: repair.diff } });

    repair.gate = assertionGate(p.operations, repaired, { [src]: candidate });
    await this.timeline({ actor: "Release gate", kind: "gate", title: repair.gate.passed ? "Contract assertions present for every operation" : repair.gate.required.some((r) => !r.present && r.kind !== "contradicted") ? "Missing contract assertions" : "Repair contradicts the declared contract", detail: repair.gate.required.map((r) => `${r.present ? "✓" : "✗"} ${r.assertion} — ${r.detail}`).join("\n"), incident_id: incidentId, tone: repair.gate.passed ? "good" : "bad" });

    repair.repo_tests = await runRepoTests(wt.dir);
    this.toolMs += Date.now() - t0;
    await this.timeline({ actor: "Repair worker", kind: "repair", title: `Pipeline repository tests: ${repair.repo_tests.total - repair.repo_tests.failed}/${repair.repo_tests.total} pass`, detail: repair.repo_tests.passed ? null : repair.repo_tests.output_excerpt, incident_id: incidentId, tone: repair.repo_tests.passed ? "good" : "bad" });

    // Replay the same logical records: baseline rows on the baseline revision vs candidate rows on the repaired revision.
    const t1 = Date.now();
    const converts = p.operations.filter((o) => o.op === "convert_minor_units");
    const unitChange = changes.some((c) => c.kind === "unit_changed");
    const controlOps = p.operations.filter((o) => o.op !== "convert_minor_units");
    const [b, c, control] = await Promise.all([
      runPipelineRev(baseRev, this.currentInput()),
      runPipelineAt(wt.dir, candidateInput),
      unitChange && converts.length && controlOps.length ? runPipelineAt(wt.dir, candidateInput, { [src]: applyOperations(mappings, controlOps, { [src]: candidate.version })[src] }) : Promise.resolve(null),
    ]);
    repair.replay = reconcile(b, c, { control, controlLabel: "A mapping that keeps the old ×100 conversion", repoTests: repair.repo_tests });
    this.replayMs += Date.now() - t1;
    await removeWorktree(wt.dir);
    await this.timeline({ actor: "Replay", kind: "replay", title: repair.replay.passed ? `Replay passed: ${repair.replay.checks.length} checks on the same logical records` : `Replay failed at "${label(repair.replay)}"`, detail: repair.replay.checks.map((x) => `${x.passed ? "✓" : "✗"} ${x.label}: ${x.detail}`).join("\n"), incident_id: incidentId, tone: repair.replay.passed ? "good" : "bad", data: { checks: repair.replay.checks } });

    const undeclared = repair.gate.required.filter((r) => !r.present && r.kind !== "contradicted");
    if (undeclared.length) {
      repair.status = "blocked";
      return block("pending_clarification", "block_pending_clarification", `${current.owner.name} (${current.owner.contact}) must declare: ${undeclared.map((r) => r.assertion).join("; ")}`, "Blocked pending clarification", `${repair.replay.passed ? "The sample replay reconciles, but that" : "The replay fails and it also"} rests on facts the producer has not declared. Missing assertions block activation regardless of sample results.`);
    }
    if (!repair.replay.passed || !repair.gate.passed) {
      repair.status = "failed";
      const contradicted = repair.gate.required.find((r) => !r.present);
      const first = repair.replay.checks.find((x) => !x.passed) ?? { label: "Contract assertions", detail: contradicted!.detail };
      return block("blocked", "hold_previous_snapshot", `Repair rejected at "${first.label}". Needs a corrected mapping before ${src} v${candidate.version} can ship.`, `Repair rejected: first failed check is "${first.label}"`, `${first.detail}. Snapshot r${this.snapshotBefore.revision} stays published.`);
    }
    repair.status = "verified";
    state.status = "verified";
    state.candidate_rev = repair.candidate_rev;
    state.had_repair = true;
    this.marks.verified ??= Date.now();
    this.marks.verified_sim ??= this.simMin();
    await save("Repair verified by replay", { status: "repair_verified", has_verified_fix: true, next_action: `Verified repair ${repair.candidate_rev!.slice(0, 7)} will be activated together with ${src} v${candidate.version} at ${simTime(state.effective_min).toISOString().slice(11, 16)} UTC.` });
    this.schedule(state.effective_min, () => this.activate(src));
  }

  /** The producer's change takes effect. Activate exactly the contract version and mapping revision that were tested. */
  private async activate(src: SourceId): Promise<void> {
    const state = this.proposals.get(src)!;
    if (state.status !== "verified") return;
    const env = (await getEnv(this.envId))!;
    const rev = state.candidate_rev ?? env.active_mapping_rev;
    if (state.candidate_rev && !(await isAncestor(env.active_mapping_rev, state.candidate_rev))) {
      state.status = "blocked";
      state.signal.outcome = "hold_previous_snapshot";
      this.gateClosed = true;
      await this.timeline({ actor: "Release gate", kind: "gate", title: "Activation refused: mapping moved since the rehearsal", detail: `Tested ${state.candidate_rev.slice(0, 7)} is not based on the active ${env.active_mapping_rev.slice(0, 7)}; the repair must be rehearsed again.`, incident_id: state.incident_id, tone: "bad" });
      return;
    }
    const ok = await tx(async (db) => {
      const cand = await q1("SELECT 1 FROM contracts WHERE env_id=$1 AND source=$2 AND version=$3 AND status='candidate' FOR UPDATE", [this.envId, src, state.candidate.version], db);
      if (!cand) return false;
      await q("UPDATE contracts SET status='superseded' WHERE env_id=$1 AND source=$2 AND status='active'", [this.envId, src], db);
      await q("UPDATE contracts SET status='active' WHERE env_id=$1 AND source=$2 AND version=$3", [this.envId, src, state.candidate.version], db);
      await q("UPDATE environments SET active_contracts = jsonb_set(active_contracts, $2, $3::jsonb), active_mapping_rev=$4 WHERE id=$1", [this.envId, `{${src}}`, String(state.candidate.version), rev], db);
      return true;
    });
    if (!ok) return;
    await setEnvBranch(this.envId, rev);
    state.status = "activated";
    await this.timeline({ actor: "Release gate", kind: "activation", title: `Activated ${src} contract v${state.candidate.version}${state.candidate_rev ? ` with mapping ${rev.slice(0, 7)}` : ""}`, detail: state.candidate_rev ? `Mapping revision ${rev} is the exact commit the replay verified. It is stored with the environment, so the next refresh uses it even after a worker restart.` : "Mapping unchanged.", incident_id: state.incident_id, tone: "good", data: { contract_version: state.candidate.version, mapping_rev: rev } });
  }

  private async onWithdrawn(src: SourceId, reason: string | null): Promise<void> {
    const state = this.proposals.get(src);
    if (!state) return;
    await this.emit("source.change.withdrawn", src, state.correlation, `withdraw:${src}:v${state.candidate.version}`, { change_id: `CHG-${this.short}-${src}`, proposed_version: state.candidate.version, reason });
    await q("UPDATE contracts SET status='withdrawn' WHERE env_id=$1 AND source=$2 AND version=$3", [this.envId, src, state.candidate.version]);
    const wasBlocked = state.status === "blocked" || state.status === "pending_clarification";
    state.status = "withdrawn";
    state.signal.outcome = "withdrawn_no_change";
    if (wasBlocked && ![...this.proposals.values()].some((p) => p.status === "blocked" || p.status === "pending_clarification")) this.gateClosed = false;
    await this.timeline({ actor: "Producer", kind: "event", title: `${src} v${state.candidate.version} proposal withdrawn`, detail: `${reason ?? "No reason given"}. Nothing was activated; the active contract and mapping are unchanged.`, incident_id: state.incident_id, tone: "neutral" });
    if (state.incident_id) await this.updateIncident(state.incident_id, { status: "withdrawn", next_action: "None. The upstream change was withdrawn before its effective time." }, "Proposal withdrawn by the producer");
  }

  // ---------- delivery progress ----------

  private async onExportStarted(src: SourceId): Promise<void> {
    const d = this.delivery.get(src)!;
    d.started = this.now;
    await this.emit("source.export.started", src, `cycle-${src}`, `export-start:${src}`, { export_id: `${src}-2026-03-02`, cycle: "2026-03-02" });
    if (d.warning_incident) {
      const c = baselineContract(src);
      await this.updateIncident(d.warning_incident, { next_action: `Export running. Hard deadline ${simTime(c.delivery.hard_deadline_min).toISOString().slice(11, 16)} UTC.` }, `Export started ${Math.round(this.now - c.delivery.expected_start_min)} min after its expected start`);
      await this.timeline({ actor: `${src} export`, kind: "event", title: `${src} export started ${Math.round(this.now - c.delivery.expected_start_min)} min late`, detail: "Warning updated; still expected before the cutoff.", incident_id: d.warning_incident, tone: "warn" });
    }
  }

  private async onExportProgress(src: SourceId, percent: number): Promise<void> {
    const d = this.delivery.get(src)!;
    d.progress = percent;
    await this.emit("source.export.progress", src, `cycle-${src}`, `export-progress:${src}:${percent}`, { export_id: `${src}-2026-03-02`, percent });
    if (d.warning_incident) await this.updateIncident(d.warning_incident, {}, `Export progress ${percent}%`);
  }

  /** "A missing file emits no log": this timer is what notices that an export has not started. */
  private async checkStarted(src: SourceId, c: Contract): Promise<void> {
    const d = this.delivery.get(src)!;
    if (d.started !== null || d.applied) return;
    const impact = traceImpact(src, []);
    const correlation = `delivery-${src}`;
    await this.emit("source.delivery.at_risk", "schema-guard", correlation, `delivery-risk:${src}`, { source: src, rule: "export has not started by the warning time", expected_start_min: c.delivery.expected_start_min, grace_min: c.delivery.grace_min, hard_deadline_at: simTime(c.delivery.hard_deadline_min).toISOString() });
    this.marks.trigger ??= Date.now();
    this.marks.trigger_sim ??= this.simMin();
    const ev = await this.evidence("delivery_schedule", `${src} delivery schedule and observed progress`, { expected_start_min: c.delivery.expected_start_min, grace_min: c.delivery.grace_min, hard_deadline_min: c.delivery.hard_deadline_min, observed: { started: d.started, progress: d.progress } }, null);
    const signal: Signal = { correlation, source: src, outcome: null, watcher_category: "late_delivery", dashboards: impact.dashboards, incident_id: null };
    this.signals.push(signal);
    const labels = impact.dashboards.map(dashLabel).join(" and ");
    d.warning_incident = await this.openIncident({ correlation, source: src, status: "warning", risk_kind: "current_data", severity: "medium", title: `${src} export has not started by its warning time`, what_breaks: `${labels} may not refresh by the ${simTime(c.delivery.hard_deadline_min).toISOString().slice(11, 16)} UTC cutoff. This is a warning: published numbers are still current.`, watcher_category: "late_delivery", assets: impact.assets, owner: c.owner, next_action: `Waiting for the export. ${c.owner.name} (${c.owner.contact}) owns it.`, evidence_ids: [ev.id] });
    signal.incident_id = d.warning_incident;
    await q("UPDATE incidents SET cause_status='likely', cause_category='late_delivery', cause_text=$2 WHERE id=$1", [d.warning_incident, `Export expected by minute ${c.delivery.expected_start_min} (+${c.delivery.grace_min} grace) has not started.`]);
  }

  private async checkDeadline(src: SourceId, c: Contract): Promise<void> {
    const d = this.delivery.get(src)!;
    if (d.applied || d.quarantined) return;
    const impact = traceImpact(src, []);
    const labels = impact.dashboards.map(dashLabel).join(" and ");
    const note = `${src} batch did not arrive by the ${simTime(c.delivery.hard_deadline_min).toISOString().slice(11, 16)} UTC hard deadline`;
    if (!d.warning_incident) {
      const signal: Signal = { correlation: `delivery-${src}`, source: src, outcome: null, watcher_category: "missed_deadline", dashboards: impact.dashboards, incident_id: null };
      this.signals.push(signal);
      d.warning_incident = await this.openIncident({ correlation: `delivery-${src}`, source: src, status: "delayed", risk_kind: "current_data", severity: "high", title: note, what_breaks: `${labels} cannot refresh this cycle.`, watcher_category: "missed_deadline", assets: impact.assets, owner: c.owner, next_action: "", evidence_ids: [] });
      signal.incident_id = d.warning_incident;
    }
    const signal = this.signals.find((s) => s.incident_id === d.warning_incident)!;
    signal.watcher_category = "missed_deadline";
    signal.outcome = "delayed_previous_snapshot";
    await this.updateIncident(d.warning_incident, { status: "delayed", severity: "high", cause_status: "confirmed", cause_category: "missed_deadline", cause_text: note, watcher_category: "missed_deadline", freshness: await this.freshness("delayed"), next_action: `${c.owner.name} (${c.owner.contact}) to deliver the batch. ${labels} keeps showing snapshot r${this.snapshotBefore.revision}, labelled Delayed.` }, note);
    await this.timeline({ actor: "Watcher", kind: "alert", title: `Deadline missed: ${note}`, detail: `${labels} stays on snapshot r${this.snapshotBefore.revision} (data as of ${this.snapshotBefore.data_as_of}).`, incident_id: d.warning_incident, tone: "bad" });
  }

  // ---------- batch arrival and staging validation ----------

  private async onBatchArrived(src: SourceId, eff: MutationEffect | null, variant: "cycle" | "redelivery" | "stale"): Promise<void> {
    const d = this.delivery.get(src)!;
    const env = (await getEnv(this.envId))!;
    const proposal = this.proposals.get(src);
    const activated = proposal?.status === "activated";
    const stale = variant === "stale";
    const batchId = stale ? `${src}-2026-02-28` : `${src}-2026-03-02`;
    const seq = stale ? 0 : 2;
    const rows = stale ? this.data[src] : activated ? proposal!.effect.rows! : eff?.mode === "batch" ? eff.rows! : this.data[src];
    const version = env.active_contracts[src];
    const correlation = `cycle-${src}`;
    const accepted = await this.emit("source.batch.arrived", src, correlation, `batch:${src}:${batchId}`, { batch_id: batchId, seq, contract_version: version, row_count: rows.length });
    if (!accepted) {
      this.ignored++;
      await this.timeline({ actor: "Watcher", kind: "ignored", title: `Ignored repeat delivery of ${batchId}`, detail: "Same de-duplication key as a batch already applied. Recorded as a duplicate event; nothing was reprocessed.", tone: "neutral" });
      return;
    }
    const newest = await q1<{ seq: number }>("SELECT max(seq) AS seq FROM feed_batches WHERE env_id=$1 AND source=$2 AND status='applied'", [this.envId, src]);
    if (seq <= (newest?.seq ?? 0)) {
      this.ignored++;
      await q("INSERT INTO feed_batches (env_id,source,batch_id,seq,contract_version,rows,row_count,status,reason,run_id,received_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'ignored',$8,$9,$10) ON CONFLICT DO NOTHING", [this.envId, src, batchId, seq, version, JSON.stringify(rows), rows.length, `sequence ${seq} is older than applied sequence ${newest!.seq}`, this.runId, this.simAt()]);
      await q("UPDATE events SET status='ignored', note=$3 WHERE run_id=$1 AND dedup_key=$2 AND status='accepted'", [this.runId, `batch:${src}:${batchId}`, "Older than the batch already applied"]);
      await this.timeline({ actor: "Watcher", kind: "ignored", title: `Ignored out-of-order batch ${batchId}`, detail: `Sequence ${seq} arrived after sequence ${newest!.seq} was applied. Newer data stays in place.`, tone: "neutral" });
      return;
    }

    const contract = await activeContract(this.envId, src);
    const { problems } = validateBatch(contract, rows);
    if (src === "payments") {
      const orders = await q1<{ rows: Row[] }>("SELECT rows FROM feed_batches WHERE env_id=$1 AND source='orders' AND status='applied' ORDER BY seq DESC LIMIT 1", [this.envId]);
      const paid = new Set(rows.map((r) => r.order_id));
      const unpaid = (orders?.rows ?? []).filter((o) => !paid.has(o.order_id));
      if (orders && unpaid.length / orders.rows.length > 0.2) problems.push({ check: "orders_without_payments", detail: `${unpaid.length} of ${orders.rows.length} orders have no payment row at all (threshold 20%)`, count: unpaid.length, sample: unpaid.slice(0, 3).map((o) => ({ order_id: o.order_id })) });
    }
    const status = problems.length ? "quarantined" : "applied";
    await q("INSERT INTO feed_batches (env_id,source,batch_id,seq,contract_version,rows,row_count,status,reason,run_id,received_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [this.envId, src, batchId, seq, version, JSON.stringify(rows), rows.length, status, problems.map((p) => p.detail).join("; ") || null, this.runId, this.simAt()]);

    if (!problems.length) {
      d.applied = true;
      const late = this.now > contract.delivery.hard_deadline_min;
      await this.timeline({ actor: `${src} export`, kind: "event", title: `${src} batch ${batchId} arrived${late ? " after the cutoff" : ""} and passed staging validation`, detail: `${rows.length} rows under contract v${version}.${late ? " Too late for this cycle; it will be picked up by the next refresh." : ""}`, tone: late ? "warn" : "good" });
      if (d.warning_incident && !late) {
        const signal = this.signals.find((s) => s.incident_id === d.warning_incident)!;
        signal.outcome = "warn_and_recover";
        await this.updateIncident(d.warning_incident, { status: "recovered", next_action: "None. The batch arrived before the cutoff." }, "Batch arrived before the cutoff");
        await this.timeline({ actor: "Watcher", kind: "alert", title: `Recovered: ${src} arrived before the cutoff`, detail: null, incident_id: d.warning_incident, tone: "good" });
      }
      return;
    }
    d.quarantined = true;
    await this.failedCheck(src, contract.owner, problems, { batch_id: batchId, seq, row_count: rows.length, contract_version: version, sample_rows: rows.slice(0, 3) }, contract);
  }

  /** A deterministic check failed on arriving data or in the warehouse. Quarantine, alert, and ask for a diagnosis. */
  private async failedCheck(src: SourceId | "warehouse", owner: Owner, problems: BatchProblem[], batch: Record<string, unknown> | null, contract: Contract | null): Promise<void> {
    const correlation = `check-${src}`;
    const category = categoryForBatchProblems(problems);
    const impact = traceImpact(src, []);
    const labels = impact.dashboards.map(dashLabel).join(" and ");
    await this.emit("pipeline.check.failed", src === "warehouse" ? "schema-guard" : src, correlation, `check-failed:${src}`, { stage: src === "warehouse" ? "transformation" : "staging_validation", batch_id: batch?.batch_id ?? null, checks: problems.map((p) => ({ check: p.check, detail: p.detail, count: p.count })) });
    this.marks.trigger ??= Date.now();
    this.marks.trigger_sim ??= this.simMin();
    const ev = [
      ...(contract ? [await this.evidence("active_contract", `Active ${src} contract v${contract.version}`, contract, null)] : []),
      await this.evidence("failed_checks", "Deterministic checks that failed", { checks: problems }, null),
      ...(batch ? [await this.evidence("batch_metadata", "The arriving batch", batch, null)] : []),
      await this.evidence("lineage_impact", "Downstream assets from lineage", { ...impact, edges: lineage().edges.filter((e) => impact.assets.includes(e.to)) }, null),
      await this.evidence("ownership", "Owner", owner, null),
      await this.evidence("feed_events", "Feed and job events so far in this cycle", await this.recentEvents(), null),
    ];
    const signal: Signal = { correlation, source: src, outcome: "hold_previous_snapshot", watcher_category: category, dashboards: impact.dashboards, incident_id: null };
    this.signals.push(signal);
    const title = src === "warehouse" ? "Warehouse transformation failed after valid input" : `${src} batch failed staging validation and was quarantined`;
    const id = await this.openIncident({ correlation, source: src, status: "held", risk_kind: "current_data", severity: impact.dashboards.includes("dash.finance") ? "high" : "medium", title, what_breaks: `${problems[0].detail}. ${labels} cannot refresh from this input; snapshot r${this.snapshotBefore.revision} stays published.`, watcher_category: category, assets: impact.assets, owner, next_action: "Investigating.", evidence_ids: ev.map((e) => e.id) });
    signal.incident_id = id;
    await q("UPDATE evidence SET incident_id=$3 WHERE run_id=$1 AND id = ANY($2)", [this.runId, ev.map((e) => e.id), id]);
    await this.investigate(id, { type: "pipeline.check.failed", source: src, summary: title }, ev, owner.team);
    await this.updateIncident(id, { status: "held", freshness: await this.freshness("at_risk"), next_action: src === "warehouse" ? `${owner.name} (${owner.contact}) to fix the transformation or the offending row, then re-run the refresh.` : `${owner.name} (${owner.contact}) to redeliver a corrected batch. The quarantined batch will not be applied.` }, "Held: previous snapshot stays published");
  }

  // ---------- refresh and publish ----------

  private async refresh(): Promise<void> {
    const waiting = SOURCES.filter((s) => !this.delivery.get(s)!.applied);
    if (waiting.length) {
      const delayed = this.signals.some((s) => s.outcome === "delayed_previous_snapshot");
      await this.timeline({ actor: "Refresh", kind: "validation", title: `Refresh held: no valid ${waiting.join(", ")} batch for this cycle`, detail: `Snapshot r${this.snapshotBefore.revision} (data as of ${this.snapshotBefore.data_as_of}) stays published, labelled ${delayed ? "Delayed" : "At risk"}.`, tone: "bad" });
      return;
    }
    const t0 = Date.now();
    const r = await refreshAndPublish({ envId: this.envId, runId: this.runId, dataAsOf: simTime(REFRESH_MIN), expectedPrevRevision: this.snapshotBefore.revision });
    this.replayMs += Date.now() - t0;
    await this.emit("pipeline.validation.completed", "schema-guard", "refresh", "refresh-validation", { passed: r.first_failed_check === null, candidate_revision: r.revision, mapping_rev: r.mapping_rev, contract_versions: r.contract_versions, checks: r.checks.map((c) => ({ id: c.id, passed: c.passed })) });
    if (r.first_failed_check) {
      await this.timeline({ actor: "Refresh", kind: "validation", title: `Candidate snapshot r${r.revision} failed "${r.checks.find((c) => !c.passed)!.label}"`, detail: r.reason, tone: "bad", data: { checks: r.checks } });
      await this.failedCheck("warehouse", PLATFORM_OWNER, [{ check: "transformation", detail: r.reason ?? "transformation failed", count: 1, sample: [] }], null, null);
      return;
    }
    await this.timeline({ actor: "Refresh", kind: "validation", title: `Candidate snapshot r${r.revision} passed ${r.checks.length} deterministic checks`, detail: `Built with contracts ${SOURCES.map((s) => `${s} v${r.contract_versions[s]}`).join(", ")} and mapping ${r.mapping_rev.slice(0, 7)}.`, tone: "good", data: { checks: r.checks } });
    if (!r.published) {
      await this.timeline({ actor: "Refresh", kind: "publish", title: "Not published: a newer snapshot is already current", detail: r.reason, tone: "warn" });
      return;
    }
    this.published = true;
    this.snapshotAfterId = r.snapshot_id;
    this.marks.publish_sim = this.simMin();
    const flat = (x: Record<string, Record<string, string>>) => Object.fromEntries(Object.entries(x).flatMap(([a, m]) => Object.entries(m).map(([k, v]) => [`${a}.${k}`, v])));
    const drift = diffCentMaps(flat(this.snapshotBefore.dashboards), flat(r.dashboards!));
    const fin = Object.entries(r.dashboards!.finance).filter(([k]) => k.startsWith("net_revenue_cents.")).map(([k, v]) => `${k.split(".")[1]} ${centsToDecimal(v)}`).join(", ");
    const tested = [...this.proposals.values()].filter((p) => p.candidate_rev && p.status === "activated");
    const exact = tested.every((p) => p.candidate_rev === r.mapping_rev);
    await this.emit("snapshot.published", "schema-guard", "refresh", `published:r${r.revision}`, { revision: r.revision, data_as_of: simTime(REFRESH_MIN).toISOString(), mapping_rev: r.mapping_rev, contract_versions: r.contract_versions, finance_net_revenue: fin });
    await this.timeline({ actor: "Refresh", kind: "publish", title: `Published snapshot r${r.revision}: Finance net revenue ${fin}${drift.length ? "" : " (unchanged)"}`, detail: `${drift.length ? `${drift.length} metric(s) differ from r${this.snapshotBefore.revision}: ${drift.slice(0, 4).join(", ")}` : `All ${Object.keys(flat(r.dashboards!)).length} dashboard metrics equal r${this.snapshotBefore.revision} for the same logical records.`}${tested.length ? ` Mapping ${r.mapping_rev.slice(0, 7)} ${exact ? "is" : "is NOT"} the revision verified by the replay.` : ""}`, tone: drift.length || !exact ? "bad" : "good", data: { revision: r.revision, mapping_rev: r.mapping_rev, drift } });
    for (const p of this.proposals.values())
      if (p.status === "activated") {
        p.signal.outcome = p.had_repair ? "repair_and_publish" : "pass_and_publish";
        if (p.incident_id) await this.updateIncident(p.incident_id, { status: "resolved", next_action: "None. The change shipped with a verified repair and totals are unchanged." }, `Resolved: snapshot r${r.revision} published with unchanged totals`);
      }
  }

  private async finish(): Promise<void> {
    const outcomes: Outcome[] = this.signals.map((s) => s.outcome).filter((o): o is Outcome => o !== null);
    if (this.published && this.ignored > 0) outcomes.push("ignore_event");
    if (this.published) outcomes.push("pass_and_publish");
    if (!this.published && outcomes.length === 0) outcomes.push("hold_previous_snapshot");
    const outcome = outcomes.sort((a, b) => OUTCOME_RANK.indexOf(a) - OUTCOME_RANK.indexOf(b))[0];
    const delayed = outcome === "delayed_previous_snapshot";
    const publishStatus = this.published ? "published" : delayed ? "delayed" : "held";
    if (!this.published) {
      const why = delayed ? "A source missed its hard deadline." : outcome === "block_pending_clarification" ? "A proposed change is blocked pending clarification from its owner." : "A change or batch was held by deterministic checks.";
      await q("UPDATE environments SET health=$2, health_detail=$3 WHERE id=$1", [this.envId, delayed ? "delayed" : "at_risk", `${why} Snapshot r${this.snapshotBefore.revision} (data as of ${this.snapshotBefore.data_as_of}) is still the verified published version.`]);
      await this.timeline({ actor: "Schema Guard", kind: "publish", title: `No new snapshot published. r${this.snapshotBefore.revision} remains current`, detail: why, tone: "warn" });
    }
    const run = (await q1<{ created_at: Date; started_at: Date }>("SELECT created_at, started_at FROM runs WHERE id=$1", [this.runId]))!;
    const agentMs = (await q1<{ ms: string }>("SELECT coalesce(sum(elapsed_ms),0) AS ms FROM agent_runs WHERE run_id=$1", [this.runId]))!.ms;
    const since = (t?: number) => (t !== undefined && this.marks.trigger !== undefined ? Math.max(0, t - this.marks.trigger) : null);
    const simSince = (t?: number) => (t !== undefined && this.marks.trigger_sim !== undefined ? Math.round((t - this.marks.trigger_sim) * 100) / 100 : null);
    const timings: Timings = {
      queue_ms: new Date(run.started_at).getTime() - new Date(run.created_at).getTime(),
      alert_ms: since(this.marks.alert), diagnosis_ms: since(this.marks.diagnosis), verified_repair_ms: since(this.marks.verified),
      total_ms: Date.now() - new Date(run.started_at).getTime(), model_ms: Number(agentMs), tool_ms: this.toolMs, replay_ms: this.replayMs,
      sim: { alert_min: simSince(this.marks.alert_sim), diagnosis_min: simSince(this.marks.diagnosis_sim), verified_repair_min: simSince(this.marks.verified_sim), publish_min: simSince(this.marks.publish_sim) },
    };
    await q("UPDATE runs SET status='completed', outcome=$2, publish_status=$3, snapshot_after_id=$4, timings=$5, finished_at=now() WHERE id=$1", [this.runId, outcome, publishStatus, this.snapshotAfterId, JSON.stringify(timings)]);
    await scoreRun(this.runId, { outcome, published: this.published, signals: this.signals.map((s) => ({ watcher_category: s.watcher_category, dashboards: s.dashboards, incident_id: s.incident_id, outcome: s.outcome })) });
  }
}

const effectSource = (m: Parameters<typeof buildEffect>[0]): SourceId => ("source" in m ? m.source : MUTATION_SPECS[m.type].teams[0]);

const dashLabel = (id: string) => lineage().nodes.find((n) => n.id === id)?.label ?? id;
const label = (r: { checks: CheckResult[] }) => r.checks.find((c) => !c.passed)?.label ?? "none";

export function describeOp(o: RepairOperation): string {
  switch (o.op) {
    case "rename_field": return `${o.source}.${o.target}: read "${o.to}" instead of "${o.from}"`;
    case "convert_minor_units": return `${o.source}.${o.target}: source is already integer ${o.unit}; stop multiplying by 100`;
    case "update_field_mapping": return `${o.source}.${o.target}: map from "${o.from}" as ${o.as}`;
    case "update_keys": return `${o.source}: stage on key (${o.keys.join(", ")})`;
    case "set_refund_convention": return `payments: refund convention ${o.convention}`;
  }
}

/** Execute one queued run to completion. Safe to call again after a crash: it restarts from the baseline. */
export async function executeRun(runId: string, hooks: RunHooks = {}): Promise<void> {
  const run = await q1<{ env_id: string; plan_id: string; agent_mode: AgentMode; options: { fault?: string | null } }>("SELECT env_id, plan_id, agent_mode, options FROM runs WHERE id=$1", [runId]);
  if (!run) throw new Error(`unknown run ${runId}`);
  const plan = await q1<{ plan: PlanSansExpectation }>("SELECT plan FROM scenario_plans WHERE id=$1 AND status='accepted'", [run.plan_id]);
  if (!plan) throw new Error(`run ${runId} references a plan that is missing or was not accepted`);
  await q("UPDATE runs SET status='running', started_at=coalesce(started_at, now()), error=NULL WHERE id=$1", [runId]);
  await new Run(runId, run.env_id, plan.plan, run.agent_mode, run.options.fault ? [run.options.fault] : [], hooks).execute();
}
