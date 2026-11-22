/**
 * DEV ONLY. Canned API responses used when a page is opened with ?mock=1 so the
 * UI can be checked without Postgres or the worker. Never imported otherwise.
 */
import type {
  AgentRunView,
  IncidentView,
  Overview,
  Owner,
  RunDetail,
  RunSummary,
  ScenariosView,
  SnapshotView,
  TimelineEntry,
  WorkerView,
} from "./api-types";

const payOwner: Owner = { team: "payments", name: "Payments Platform", contact: "#payments-data" };
const t = (min: number, sec = 0) => new Date(Date.UTC(2026, 2, 2, 6, min, sec)).toISOString();
const wall = (sec: number) => new Date(Date.UTC(2026, 10, 22, 17, 30, sec)).toISOString();

const before: SnapshotView = {
  id: "1",
  revision: 1,
  status: "published",
  data_as_of: "2026-03-01T23:59:59Z",
  published_at: wall(0),
  contract_versions: { orders: 1, payments: 1, shipping: 1 },
  mapping_rev: "3f9c2ab71d04e6c2a1b0",
  finance_net_by_currency: { USD: "184550" },
  dashboards: {
    finance: { gross_payments_cents: "197050", refunds_cents: "-12500", "net_revenue_cents.USD": "184550" },
    revenue: { orders_total_cents: "189900", paid_cents: "184550", outstanding_cents: "5350" },
    operations: { orders: "12", shipped_orders: "11", delivered_orders: "9" },
  },
  run_id: null,
};
const after: SnapshotView = {
  ...before,
  id: "2",
  revision: 2,
  data_as_of: "2026-03-02T09:00:00Z",
  published_at: wall(9),
  contract_versions: { orders: 1, payments: 2, shipping: 1 },
  mapping_rev: "a81e77c0b9d2f4e6a001",
  run_id: "run_7c1e42",
};

const worker: WorkerView = {
  online: true,
  last_heartbeat: wall(58),
  seconds_since_heartbeat: 1,
  agent_mode: "auto",
  model_ref: "cerebras/moonshotai-kimi-k3.1-pro-trial",
  openclaw_version: "2026.11.5",
};

const diff = `diff --git a/mappings/payments.json b/mappings/payments.json
index 4c1d2aa..9be07f3 100644
--- a/mappings/payments.json
+++ b/mappings/payments.json
@@ -1,12 +1,12 @@
 {
-  "version": 1,
-  "contract_version": 1,
+  "version": 2,
+  "contract_version": 2,
   "fields": {
     "payment_id": { "from": "payment_id" },
     "order_id": { "from": "order_id" },
-    "amount_cents": { "from": "payment_amount", "transform": "dollars_to_cents" },
+    "amount_cents": { "from": "amount_cents", "transform": "identity_cents" },
     "currency": { "from": "currency" }
   }
 }`;

const incident: IncidentView = {
  id: "inc_41b0",
  run_id: "run_7c1e42",
  correlation_id: "corr_9d21",
  source: "payments",
  status: "resolved",
  risk_kind: "future_change",
  severity: "high",
  title: "Payments proposes replacing payment_amount with amount_cents",
  what_breaks:
    "The payments mapping reads payment_amount as dollars and multiplies by 100. After the change that field is gone, and a rename alone would overstate Finance revenue 100 times.",
  cause_status: "confirmed",
  cause_category: "unit_and_name_change",
  cause_text: "Field renamed and unit changed from dollars to integer cents; both are declared by the producer.",
  affected_assets: ["stg.payments", "fact.payments", "fact.orders"],
  affected_dashboards: ["dash.finance", "dash.revenue"],
  owner: payOwner,
  freshness: { snapshot_revision: 1, data_as_of: before.data_as_of, label: "healthy" },
  has_verified_fix: true,
  next_action: "None. The tested mapping a81e77c is active and revision 2 is published.",
  evidence_ids: ["E-7c1e-01", "E-7c1e-02", "E-7c1e-04"],
  opened_at: wall(2),
  updated_at: wall(9),
  history: [
    { at: wall(2), status: "at_risk", note: "Breaking change detected in proposed contract v2" },
    { at: wall(5), status: "diagnosed", note: "Investigator confirmed unit and name change" },
    { at: wall(8), status: "repair_verified", note: "Replay matched 16 of 16 payments" },
    { at: wall(9), status: "resolved", note: "Activated at effective time, revision 2 published" },
  ],
  finding: {
    source: "agent",
    valid: true,
    validation_errors: [],
    observed_facts: [
      { statement: "payment_amount (decimal, dollars) is removed and amount_cents (integer, cents) is added.", evidence_ids: ["E-7c1e-01"] },
      { statement: "Sample row P-1003 changes from 12.34 to 1234 for the same payment.", evidence_ids: ["E-7c1e-02"] },
      { statement: "staging_payments feeds payment_facts and order_facts, which feed Finance and Revenue.", evidence_ids: ["E-7c1e-04"] },
    ],
    cause_status: "confirmed",
    cause_category: "unit_and_name_change",
    candidate_cause: "Declared rename with a unit change from dollars to minor units.",
    evidence_ids: ["E-7c1e-01", "E-7c1e-02", "E-7c1e-04"],
    impacted_assets: ["stg.payments", "fact.payments", "fact.orders", "dash.finance", "dash.revenue"],
    owner_team: "payments",
    severity: "high",
    next_verification_step: null,
  },
  repair: {
    decision: "propose",
    operations: [
      { op: "rename_field", source: "payments", target: "amount_cents", from: "payment_amount", to: "amount_cents" },
      { op: "convert_minor_units", source: "payments", target: "amount_cents", unit: "cents" },
    ],
    assumptions: ["amount_cents is an integer count of cents in the row's currency."],
    expected_invariants: ["Every payment normalizes to the same cents as before.", "Finance net revenue is unchanged."],
    missing_facts: [],
    question_for_owner: null,
    gate: {
      passed: true,
      required: [
        { assertion: "unit declared for amount_cents", present: true, detail: "unit: cents" },
        { assertion: "rename declared", present: true, detail: "renamed_from: payment_amount" },
      ],
    },
    base_rev: before.mapping_rev,
    candidate_rev: after.mapping_rev,
    branch: "repair/run_7c1e42-1",
    diff,
    repo_tests: { passed: true, total: 9, failed: 0, output_excerpt: "# tests 9\n# pass 9\n# fail 0" },
    replay: {
      passed: true,
      first_failed_check: null,
      checks: [
        { id: "candidate_rows_rejected", label: "No candidate rows rejected", passed: true, detail: "0 of 16 rejected" },
        { id: "row_count_match", label: "Row counts match", passed: true, detail: "16 = 16" },
        {
          id: "per_record_canonical_match",
          label: "Each payment normalizes to the same cents",
          passed: true,
          detail: "16 of 16 match",
          sample: [
            { payment_id: "P-1003", baseline_input: "12.34", candidate_input: "1234", baseline_cents: "1234", candidate_cents: "1234" },
            { payment_id: "P-1011", baseline_input: "-25.00", candidate_input: "-2500", baseline_cents: "-2500", candidate_cents: "-2500" },
          ],
        },
        { id: "join_grain", label: "Joins keep order grain", passed: true, detail: "12 order facts for 12 orders" },
        { id: "dashboard_totals_match", label: "Dashboard totals match", passed: true, detail: "Finance $1,845.50 = $1,845.50" },
        {
          id: "negative_control_fails",
          label: "Negative control is caught",
          passed: true,
          detail: "A mapping that keeps the old ×100 conversion fails as expected",
          sample: [{ payment_id: "P-1003", expected_cents: "1234", control_cents: "123400" }],
        },
      ],
    },
    status: "verified",
  },
};

const tl = (seq: number, sec: number, min: number, actor: string, kind: TimelineEntry["kind"], title: string, detail: string | null, tone: TimelineEntry["tone"], ev: string[] = []): TimelineEntry => ({
  seq,
  key: `k${seq}`,
  at: wall(sec),
  sim_at: t(min),
  actor,
  kind,
  title,
  detail,
  incident_id: "inc_41b0",
  evidence_ids: ev,
  tone,
  data: null,
});

const timeline: TimelineEntry[] = [
  tl(1, 2, 5, "Payments producer", "event", "Change proposed: payments contract v2", "Effective in 55 simulated minutes. Finance keeps reading revision 1.", "neutral", ["E-7c1e-01"]),
  tl(2, 2, 5, "Watcher", "watcher", "Breaking difference against contract v1", "payment_amount removed, amount_cents added, unit dollars → cents.", "warn", ["E-7c1e-01"]),
  tl(3, 2, 5, "Watcher", "impact", "Finance and Revenue dashboards are downstream", "Through staging_payments, payment_facts and order_facts.", "warn", ["E-7c1e-04"]),
  tl(4, 5, 5, "Investigator", "agent", "Cause confirmed: declared rename and unit change", "Three observed facts, all with evidence.", "neutral", ["E-7c1e-01", "E-7c1e-02", "E-7c1e-04"]),
  tl(5, 7, 5, "Repair agent", "agent", "Proposed 2 mapping operations", "rename_field, convert_minor_units", "neutral"),
  tl(6, 7, 5, "Repair worker", "repair", "Applied on branch repair/run_7c1e42-1", "1 file changed. Repository tests 9 of 9 passed.", "good"),
  tl(7, 8, 5, "Replay", "replay", "Replay passed: 16 of 16 payments match", "Negative control with the old ×100 conversion fails as expected.", "good"),
  tl(8, 9, 60, "Release gate", "activation", "Contract v2 and mapping a81e77c activated", "Exactly the tested revision.", "good"),
  tl(9, 9, 180, "Publisher", "publish", "Revision 2 published, Finance total unchanged", "$1,845.50 before and after.", "good"),
];

const agentRun = (id: string, role: string, agent_id: string, sec: number, mode: "live" | "fixture"): AgentRunView => ({
  id,
  role,
  agent_id,
  purpose: role === "investigator" ? "investigate inc_41b0" : "repair inc_41b0",
  mode,
  fallback_reason: mode === "fixture" ? "rate_limited" : null,
  provider: mode === "live" ? "cerebras" : null,
  model: mode === "live" ? "moonshotai-kimi-k3.1-pro-trial" : null,
  session_key: `run_7c1e42-${role}-1`,
  status: "ok",
  error_category: null,
  error_message: null,
  elapsed_ms: mode === "live" ? 1840 : 4,
  attempt: 1,
  usage: mode === "live" ? { input: 6120, output: 412, total: 6532 } : null,
  input_excerpt: '{\n  "task": "investigate",\n  "evidence": [{ "id": "E-7c1e-01", "kind": "contract_diff" }]\n}',
  output_excerpt: '{\n  "cause_status": "confirmed",\n  "cause_category": "unit_and_name_change"\n}',
  created_at: wall(sec),
});

const run: RunSummary = {
  id: "run_7c1e42",
  env_id: "main",
  kind: "rehearsal",
  title: "Rehearsal R-7c1e",
  catalog_title: "Payment field renamed and dollars changed to cents",
  case_no: 1,
  status: "completed",
  outcome: "repair_and_publish",
  agent_mode: "auto",
  used_fixture: true,
  used_live: true,
  created_at: wall(1),
  started_at: wall(2),
  finished_at: wall(9),
  score: { matched: 5, total: 5 },
};

export const mockRun: RunDetail = {
  run,
  env: { id: "main", label: "Main demo", kind: "main", health: "healthy", health_detail: "Revision 2 passed all validation checks." },
  snapshot_before: before,
  snapshot_after: after,
  snapshot_current: after,
  publish_status: "published",
  incidents: [incident],
  timeline,
  agent_runs: [agentRun("1", "investigator", "sg-investigator", 5, "live"), agentRun("2", "repair", "sg-repair", 7, "fixture")],
  evidence: [
    { id: "E-7c1e-01", kind: "contract_diff", title: "Contract v1 → v2 differences", incident_id: "inc_41b0", body: { removed: ["payment_amount"], added: ["amount_cents"], unit: { from: "dollars", to: "cents" } } },
    { id: "E-7c1e-02", kind: "sample_rows", title: "Representative old and new rows", incident_id: "inc_41b0", body: [{ payment_id: "P-1003", old: { payment_amount: 12.34 }, new: { amount_cents: 1234 } }] },
    { id: "E-7c1e-04", kind: "lineage", title: "Downstream of payments feed", incident_id: "inc_41b0", body: ["stg.payments", "fact.payments", "fact.orders", "dash.finance", "dash.revenue"] },
  ],
  events: [
    { id: "evt_01", type: "source.change.proposed", source: "payments", event_time: t(5), received_at: wall(2), correlation_id: "corr_9d21", dedup_key: "payments:proposal:v2", status: "accepted", note: null, payload: { version: 2, effective_at: t(60) } },
    { id: "evt_02", type: "source.batch.arrived", source: "payments", event_time: t(70), received_at: wall(9), correlation_id: "corr_9d21", dedup_key: "payments:batch:b2", status: "accepted", note: null, payload: { batch_id: "b2", row_count: 16 } },
    { id: "evt_03", type: "source.batch.arrived", source: "payments", event_time: t(72), received_at: wall(9), correlation_id: "corr_9d21", dedup_key: "payments:batch:b2", status: "duplicate", note: "Already applied", payload: { batch_id: "b2" } },
    { id: "evt_04", type: "snapshot.published", source: "pipeline", event_time: t(180), received_at: wall(9), correlation_id: "corr_9d21", dedup_key: "snapshot:2", status: "accepted", note: null, payload: { revision: 2 } },
  ],
  timings: {
    queue_ms: 310,
    alert_ms: 42,
    diagnosis_ms: 2950,
    verified_repair_ms: 6210,
    total_ms: 7480,
    model_ms: 1844,
    tool_ms: 1290,
    replay_ms: 640,
    sim: { alert_min: 0, diagnosis_min: 0, verified_repair_min: 0, publish_min: 175 },
  },
  score: {
    matched: 5,
    total: 5,
    verified_diagnosis: true,
    items: [
      { field: "cause", expected: "unit_and_name_change", actual: "unit_and_name_change", match: true },
      { field: "cause status", expected: "confirmed", actual: "confirmed", match: true },
      { field: "affected dashboards", expected: "finance, revenue", actual: "finance, revenue", match: true },
      { field: "test evidence", expected: "replay passed", actual: "replay passed", match: true },
      { field: "outcome", expected: "repair_and_publish", actual: "repair_and_publish", match: true },
    ],
  },
  error: null,
};

const heldRun: RunSummary = { ...run, id: "run_22aa90", env_id: "sbx_22aa90", kind: "scenario", title: "Scenario S-22aa", catalog_title: "Payment unit changed with ambiguous contract metadata", case_no: 3, outcome: "block_pending_clarification", used_live: false, score: { matched: 4, total: 5 } };

export const mockOverview: Overview = {
  env: { id: "main", label: "Main demo", health: "healthy", health_detail: "Revision 2 passed all validation checks.", at_baseline: false },
  snapshot: after,
  sources: [
    { id: "orders", team: "Orders", owner: { team: "orders", name: "Order Management", contact: "#orders-data" }, contract_version: 1, field_count: 8, last_batch: { batch_id: "ord-d2", seq: 2, row_count: 12, status: "applied", received_at: wall(9) }, delivery: { expected_start_min: 30, hard_deadline_min: 180, grace_min: 10 }, feeds_dashboards: ["dash.revenue", "dash.operations"] },
    { id: "payments", team: "Payments", owner: payOwner, contract_version: 2, field_count: 7, last_batch: { batch_id: "pay-d2", seq: 2, row_count: 16, status: "applied", received_at: wall(9) }, delivery: { expected_start_min: 30, hard_deadline_min: 180, grace_min: 10 }, feeds_dashboards: ["dash.finance", "dash.revenue"] },
    { id: "shipping", team: "Shipping", owner: { team: "shipping", name: "Fulfilment Systems", contact: "#shipping-data" }, contract_version: 1, field_count: 6, last_batch: { batch_id: "shp-d2", seq: 2, row_count: 13, status: "applied", received_at: wall(9) }, delivery: { expected_start_min: 30, hard_deadline_min: 180, grace_min: 10 }, feeds_dashboards: ["dash.operations"] },
  ],
  lineage: {
    nodes: [
      { id: "feed.orders", kind: "feed", label: "Orders feed", owner_team: "orders" },
      { id: "feed.payments", kind: "feed", label: "Payments feed", owner_team: "payments" },
      { id: "feed.shipping", kind: "feed", label: "Shipping feed", owner_team: "shipping" },
      { id: "stg.orders", kind: "staging", label: "Staging orders", owner_team: "data-platform" },
      { id: "stg.payments", kind: "staging", label: "Staging payments", owner_team: "data-platform" },
      { id: "stg.shipments", kind: "staging", label: "Staging shipments", owner_team: "data-platform" },
      { id: "fact.orders", kind: "fact", label: "Order facts", owner_team: "data-platform" },
      { id: "fact.payments", kind: "fact", label: "Payment facts", owner_team: "data-platform" },
      { id: "fact.fulfillment", kind: "fact", label: "Fulfillment facts", owner_team: "data-platform" },
      { id: "dash.revenue", kind: "dashboard", label: "Revenue", owner_team: "finance" },
      { id: "dash.finance", kind: "dashboard", label: "Finance", owner_team: "finance" },
      { id: "dash.operations", kind: "dashboard", label: "Operations", owner_team: "dash.operations" },
    ],
    edges: [
      { from: "feed.orders", to: "stg.orders", column: null, grain: "order", transform: null },
      { from: "feed.payments", to: "stg.payments", column: "payment_amount", grain: "payment", transform: "mappings/payments.json" },
      { from: "feed.shipping", to: "stg.shipments", column: null, grain: "shipment", transform: null },
      { from: "stg.orders", to: "fact.orders", column: null, grain: "order", transform: null },
      { from: "stg.payments", to: "fact.orders", column: "amount_cents", grain: "order (pre-aggregated)", transform: null },
      { from: "stg.payments", to: "fact.payments", column: "amount_cents", grain: "payment", transform: null },
      { from: "stg.shipments", to: "fact.fulfillment", column: null, grain: "order (pre-aggregated)", transform: null },
      { from: "fact.orders", to: "dash.revenue", column: null, grain: null, transform: null },
      { from: "fact.orders", to: "dash.operations", column: null, grain: null, transform: null },
      { from: "fact.payments", to: "dash.finance", column: null, grain: null, transform: null },
      { from: "fact.payments", to: "dash.revenue", column: null, grain: null, transform: null },
      { from: "fact.fulfillment", to: "dash.operations", column: null, grain: null, transform: null },
    ],
  },
  worker,
  active_run_id: null,
  latest_main_run: mockRun,
  recent_runs: [run, heldRun],
  alerts: [incident],
};

export const mockScenarios: ScenariosView = {
  catalog: [
    { case_no: 1, plan_id: "case-01", title: "Payment field renamed and dollars changed to cents", team: "payments", summary: "Declared rename plus unit change.", expected_outcome: "repair_and_publish", quick: true, last_run: run },
    { case_no: 2, plan_id: "case-02", title: "Safe nullable Orders field added", team: "orders", summary: "Additive, nullable.", expected_outcome: "pass_and_publish", quick: true, last_run: null },
    { case_no: 3, plan_id: "case-03", title: "Payment unit changed with ambiguous contract metadata", team: "payments", summary: "Unit not declared.", expected_outcome: "block_pending_clarification", quick: true, last_run: heldRun },
    { case_no: 15, plan_id: "case-15", title: "Shipping export misses its hard deadline", team: "shipping", summary: "No batch by cutoff.", expected_outcome: "delayed_previous_snapshot", quick: false, last_run: null },
  ],
  generated: [
    { id: "gen_a1", batch_id: "gb_01", author_role: "payments_author", agent_id: "sg-payments-author", team: "payments", seed: 4101, status: "accepted", reasons: [], attempt: 1, mode: "live", model: "moonshotai-kimi-k3.1-pro-trial", title: "Refund sign flipped, declared", mutation_summary: "flip_refund_sign (declared)", event_count: 4, created_at: wall(20), last_run: null },
    { id: "gen_a2", batch_id: "gb_01", author_role: "orders_author", agent_id: "sg-orders-author", team: "orders", seed: 4102, status: "invalid", reasons: ["fixture_mutation.type 'drop_table' is not a declared mutation for orders", "expected_outcome contradicts the declared mutation"], attempt: 1, mode: "fixture", model: null, title: null, mutation_summary: null, event_count: 0, created_at: wall(21), last_run: null },
  ],
  generation: { job_id: "job_77", status: "done", batch_id: "gb_01", seed: 4100, created_at: wall(19), error: null },
  worker,
};

export function mockResponse(url: string, method: string): unknown {
  if (method === "POST" && url.startsWith("/api/runs")) return { run_id: mockRun.run.id };
  if (method === "POST") return { job_id: "job_78", batch_id: "gb_02" };
  if (url.startsWith("/api/runs/")) return mockRun;
  if (url.startsWith("/api/scenarios")) return mockScenarios;
  return mockOverview;
}
