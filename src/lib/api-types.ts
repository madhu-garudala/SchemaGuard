/**
 * Shapes returned by the dashboard API. The browser only ever sees these.
 * Money is always integer minor units serialized as a decimal string
 * ("184550" = $1,845.50). Timestamps are UTC ISO strings.
 */

export type AgentMode = "live" | "fixture" | "auto";

export type Outcome =
  | "repair_and_publish"
  | "pass_and_publish"
  | "block_pending_clarification"
  | "hold_previous_snapshot"
  | "warn_and_recover"
  | "delayed_previous_snapshot"
  | "ignore_event"
  | "withdrawn_no_change";

export type RunStatus = "queued" | "running" | "completed" | "failed";

/** Health of what is published now, kept separate from future change risk. */
export type EnvHealth = "healthy" | "at_risk" | "delayed";

export interface Owner {
  team: string;
  name: string;
  contact: string;
}

export interface SnapshotView {
  id: string;
  revision: number;
  status: "candidate" | "published" | "rejected";
  data_as_of: string;
  published_at: string | null;
  contract_versions: Record<string, number>;
  mapping_rev: string;
  /** Finance net revenue per currency in minor units, e.g. { USD: "184550" }. */
  finance_net_by_currency: Record<string, string>;
  /** All dashboard metrics in minor units or plain counts, as strings. */
  dashboards: Record<string, Record<string, string>>;
  run_id: string | null;
}

export interface SourceView {
  id: "orders" | "payments" | "shipping";
  team: string;
  owner: Owner;
  contract_version: number;
  field_count: number;
  last_batch: { batch_id: string; seq: number; row_count: number; status: string; received_at: string } | null;
  delivery: { expected_start_min: number; hard_deadline_min: number; grace_min: number };
  feeds_dashboards: string[];
}

export interface WorkerView {
  online: boolean;
  last_heartbeat: string | null;
  seconds_since_heartbeat: number | null;
  agent_mode: AgentMode | null;
  model_ref: string | null;
  openclaw_version: string | null;
}

export interface RunSummary {
  id: string;
  env_id: string;
  kind: "rehearsal" | "scenario";
  /** Neutral label, safe to show in a blind run. */
  title: string;
  /** Descriptive catalog name; owner-facing only, never sent to agents. */
  catalog_title: string | null;
  case_no: number | null;
  status: RunStatus;
  outcome: Outcome | null;
  agent_mode: AgentMode;
  /** True when at least one agent turn in this run used canned fixture output. */
  used_fixture: boolean;
  /** True when at least one agent turn completed live through OpenClaw. */
  used_live: boolean;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  score: { matched: number; total: number } | null;
}

export interface IncidentView {
  id: string;
  run_id: string;
  correlation_id: string;
  source: string;
  /** Lifecycle of the alert. The same incident row is updated as work progresses. */
  status:
    | "at_risk"
    | "investigating"
    | "diagnosed"
    | "repair_verified"
    | "resolved"
    | "blocked"
    | "pending_clarification"
    | "held"
    | "delayed"
    | "warning"
    | "recovered"
    | "withdrawn";
  /** "future_change" = proposed, not yet active. "current_data" = affects what is arriving now. */
  risk_kind: "future_change" | "current_data";
  severity: "low" | "medium" | "high" | "critical";
  title: string;
  what_breaks: string;
  cause_status: "confirmed" | "likely" | "unknown" | null;
  cause_category: string | null;
  cause_text: string | null;
  affected_assets: string[];
  affected_dashboards: string[];
  owner: Owner;
  freshness: { snapshot_revision: number; data_as_of: string; label: EnvHealth };
  has_verified_fix: boolean;
  next_action: string;
  evidence_ids: string[];
  opened_at: string;
  updated_at: string;
  history: { at: string; status: string; note: string }[];
  finding: FindingView | null;
  repair: RepairView | null;
}

export interface FindingView {
  source: "agent" | "deterministic_fallback";
  valid: boolean;
  validation_errors: string[];
  observed_facts: { statement: string; evidence_ids: string[] }[];
  cause_status: "confirmed" | "likely" | "unknown";
  cause_category: string;
  candidate_cause: string;
  evidence_ids: string[];
  impacted_assets: string[];
  owner_team: string;
  severity: string;
  next_verification_step: string | null;
}

export interface CheckResult {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
  /** Small before/after sample rows where useful. */
  sample?: Record<string, unknown>[];
}

export interface RepairView {
  decision: "propose" | "need_contract_fact" | "no_safe_repair" | "not_attempted";
  operations: { op: string; [k: string]: unknown }[];
  assumptions: string[];
  expected_invariants: string[];
  missing_facts: string[];
  question_for_owner: string | null;
  /** Contract-assertion gate. Missing assertions block activation even when samples match. */
  gate: { passed: boolean; required: { assertion: string; present: boolean; detail: string; kind?: "missing" | "contradicted" }[] } | null;
  base_rev: string | null;
  candidate_rev: string | null;
  branch: string | null;
  diff: string | null;
  repo_tests: { passed: boolean; total: number; failed: number; output_excerpt: string } | null;
  replay: { passed: boolean; first_failed_check: string | null; checks: CheckResult[] } | null;
  status: "verified" | "failed" | "blocked" | "not_needed" | "pending";
}

export interface TimelineEntry {
  seq: number;
  key: string;
  /** Wall-clock time the step was recorded. */
  at: string;
  /** Simulated clock time for the step. */
  sim_at: string;
  actor: string;
  kind:
    | "event"
    | "watcher"
    | "impact"
    | "agent"
    | "repair"
    | "replay"
    | "gate"
    | "activation"
    | "validation"
    | "publish"
    | "alert"
    | "ignored"
    | "error"
    | "info";
  title: string;
  detail: string | null;
  incident_id: string | null;
  evidence_ids: string[];
  tone: "neutral" | "good" | "warn" | "bad";
  data: Record<string, unknown> | null;
}

export interface AgentRunView {
  id: string;
  role: string;
  agent_id: string;
  purpose: string;
  mode: "live" | "fixture";
  /** Why a fixture response was used when live was requested, e.g. "rate_limited". */
  fallback_reason: string | null;
  provider: string | null;
  model: string | null;
  session_key: string | null;
  status: "ok" | "error";
  error_category:
    | "unauthorized"
    | "unavailable"
    | "rate_limited"
    | "timeout"
    | "malformed_output"
    | "provenance_mismatch"
    | "invalid_evidence"
    | null;
  error_message: string | null;
  elapsed_ms: number;
  attempt: number;
  usage: { input?: number; output?: number; total?: number } | null;
  input_excerpt: string;
  output_excerpt: string;
  created_at: string;
}

export interface EvidenceView {
  id: string;
  kind: string;
  title: string;
  incident_id: string | null;
  body: unknown;
}

export interface EventView {
  id: string;
  type: string;
  source: string;
  event_time: string;
  received_at: string;
  correlation_id: string;
  dedup_key: string;
  status: "accepted" | "duplicate" | "ignored";
  note: string | null;
  payload: unknown;
}

export interface Timings {
  /** All in milliseconds of wall-clock time; null when the phase did not happen. */
  queue_ms: number | null;
  alert_ms: number | null;
  diagnosis_ms: number | null;
  verified_repair_ms: number | null;
  total_ms: number | null;
  model_ms: number;
  tool_ms: number;
  replay_ms: number;
  /** Simulated minutes from the proposed change to each milestone. */
  sim: { alert_min: number | null; diagnosis_min: number | null; verified_repair_min: number | null; publish_min: number | null };
}

export interface ScoreView {
  matched: number;
  total: number;
  items: { field: string; expected: string; actual: string; match: boolean; note?: string }[];
  verified_diagnosis: boolean;
}

export interface RunDetail {
  run: RunSummary;
  env: { id: string; label: string; kind: "main" | "sandbox"; health: EnvHealth; health_detail: string };
  snapshot_before: SnapshotView | null;
  snapshot_after: SnapshotView | null;
  /** Current pointer for the run's environment (equals before when nothing was published). */
  snapshot_current: SnapshotView | null;
  publish_status: "published" | "held" | "delayed" | "pending" | "unchanged";
  incidents: IncidentView[];
  timeline: TimelineEntry[];
  agent_runs: AgentRunView[];
  evidence: EvidenceView[];
  events: EventView[];
  timings: Timings | null;
  score: ScoreView | null;
  error: string | null;
}

export interface Overview {
  env: { id: string; label: string; health: EnvHealth; health_detail: string; at_baseline: boolean };
  snapshot: SnapshotView | null;
  sources: SourceView[];
  lineage: { nodes: { id: string; kind: "feed" | "staging" | "fact" | "dashboard"; label: string; owner_team: string }[]; edges: { from: string; to: string; column: string | null; grain: string | null; transform: string | null }[] };
  worker: WorkerView;
  active_run_id: string | null;
  /** Most recent run on the main environment, for the first-screen story. */
  latest_main_run: RunDetail | null;
  recent_runs: RunSummary[];
  alerts: IncidentView[];
}

export interface CatalogCase {
  case_no: number;
  plan_id: string;
  title: string;
  team: "orders" | "payments" | "shipping" | "platform";
  summary: string;
  expected_outcome: Outcome;
  quick: boolean;
  last_run: RunSummary | null;
}

export interface GeneratedPlan {
  id: string;
  batch_id: string;
  author_role: string;
  agent_id: string;
  team: string;
  seed: number;
  status: "accepted" | "invalid";
  reasons: string[];
  attempt: number;
  mode: "live" | "fixture";
  model: string | null;
  title: string | null;
  mutation_summary: string | null;
  event_count: number;
  created_at: string;
  last_run: RunSummary | null;
}

export interface ScenariosView {
  catalog: CatalogCase[];
  generated: GeneratedPlan[];
  generation: { job_id: string; status: "queued" | "running" | "done" | "failed"; batch_id: string; seed: number; created_at: string; error: string | null } | null;
  worker: WorkerView;
}

/** POST /api/runs */
export interface StartRunRequest {
  kind: "rehearsal" | "scenario";
  plan_id?: string;
  /** Demo-only fault injection: a repair that keeps the old x100 conversion. */
  fault?: "bad_repair" | "agent_unavailable" | "malformed_output" | null;
}
export interface StartRunResponse {
  run_id: string;
}
/** POST /api/scenarios/generate */
export interface GenerateRequest {
  seed?: number;
}
export interface GenerateResponse {
  job_id: string;
  batch_id: string;
}

/**
 * Routes:
 *  GET  /api/overview            -> Overview
 *  GET  /api/runs/:id            -> RunDetail
 *  POST /api/runs                -> StartRunResponse   (body StartRunRequest)
 *  GET  /api/scenarios           -> ScenariosView
 *  POST /api/scenarios/generate  -> GenerateResponse   (body GenerateRequest)
 * Errors: { error: string } with a 4xx/5xx status.
 */
