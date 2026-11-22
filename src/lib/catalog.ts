import type { Outcome } from "./api-types";
import type { ScenarioPlan } from "./scenario";

export interface CatalogEntry {
  case_no: number;
  title: string;
  summary: string;
  team: "orders" | "payments" | "shipping" | "platform";
  quick: boolean;
  /** What the owner should see happen, in one sentence. */
  expected_result: string;
  plan: ScenarioPlan;
}

type Ev = ScenarioPlan["events"][number];
const proposed = (source: Ev["source"], offset_min = 5, effective_in_min = 45): Ev => ({ offset_min, type: "source.change.proposed", source, payload: { effective_in_min } });
const ev = (offset_min: number, type: string, source: Ev["source"], payload: Record<string, unknown> = {}): Ev => ({ offset_min, type, source, payload });
const FIN_REV = ["dash.finance", "dash.revenue"] as const;
const REV_OPS = ["dash.operations", "dash.revenue"] as const;

const plan = (n: number, team: ScenarioPlan["team"], rest: Omit<ScenarioPlan, "scenario_id" | "team" | "seed" | "starting_snapshot"> & { starting_snapshot?: ScenarioPlan["starting_snapshot"] }): ScenarioPlan => ({
  scenario_id: `catalog-${String(n).padStart(2, "0")}`,
  team,
  seed: 1000 + n,
  starting_snapshot: "baseline_usd",
  ...rest,
});
const expect = (outcome: Outcome, cause_category: string, impacted_dashboards: readonly string[] = []) => ({ outcome, cause_category, impacted_dashboards: [...impacted_dashboards] }) as ScenarioPlan["expected_outcome"];

/**
 * The twenty deterministic regression scenarios. Each is the shared baseline fixture plus one row of
 * this table: a declared mutation, a few timed events and the expected result.
 */
export const CATALOG: CatalogEntry[] = [
  { case_no: 1, team: "payments", quick: true, title: "Payment field renamed and dollars changed to cents, declared", summary: "Payments proposes payment_amount (dollars) -> amount_cents (integer cents) and declares both the rename and the unit.", expected_result: "Repair automatically, verify by replay, publish with unchanged totals.",
    plan: plan(1, "payments", { events: [proposed("payments")], fixture_mutation: { type: "rename_amount_to_minor_units", new_name: "amount_cents", declare_unit: true, declare_rename: true }, expected_outcome: expect("repair_and_publish", "unit_and_name_change", FIN_REV) }) },
  { case_no: 2, team: "orders", quick: true, title: "Safe nullable Orders field added", summary: "Orders proposes a new nullable gift_note field.", expected_result: "Pass quickly without an investigation; publish.",
    plan: plan(2, "orders", { events: [proposed("orders")], fixture_mutation: { type: "add_nullable_field", source: "orders", name: "gift_note", field_type: "string" }, expected_outcome: expect("pass_and_publish", "additive_change") }) },
  { case_no: 3, team: "payments", quick: true, title: "Payment unit changed with ambiguous contract metadata", summary: "Payments proposes an integer `amount` field with no declared unit and no declared rename.", expected_result: "Block pending clarification from the owner, even if samples would reconcile.",
    plan: plan(3, "payments", { events: [proposed("payments")], fixture_mutation: { type: "rename_amount_to_minor_units", new_name: "amount", declare_unit: false, declare_rename: false }, expected_outcome: expect("block_pending_clarification", "ambiguous_contract", FIN_REV) }) },
  { case_no: 4, team: "orders", quick: false, title: "Required order ID removed", summary: "Orders proposes dropping order_id, the key every downstream join uses.", expected_result: "Reject the change; previous snapshot stays.",
    plan: plan(4, "orders", { events: [proposed("orders")], fixture_mutation: { type: "remove_order_id" }, expected_outcome: expect("hold_previous_snapshot", "required_key_removed", REV_OPS) }) },
  { case_no: 5, team: "orders", quick: false, title: "Nullable field becomes required with existing nulls", summary: "Orders proposes making customer_region required while current rows contain nulls.", expected_result: "Reject the change until the producer backfills; previous snapshot stays.",
    plan: plan(5, "orders", { events: [proposed("orders")], fixture_mutation: { type: "require_region" }, expected_outcome: expect("hold_previous_snapshot", "nullability_violation", REV_OPS) }) },
  { case_no: 6, team: "payments", quick: false, title: "Numeric payments silently become strings", summary: "The Payments batch arrives with amounts as strings and no proposal.", expected_result: "Quarantine the batch at staging; previous snapshot stays.",
    plan: plan(6, "payments", { events: [], fixture_mutation: { type: "stringify_amounts" }, expected_outcome: expect("hold_previous_snapshot", "type_drift", FIN_REV) }) },
  { case_no: 7, team: "payments", quick: false, title: "Refund sign convention changes", summary: "Payments declares refunds will be positive amounts marked by kind.", expected_result: "Repair automatically, verify by replay, publish with unchanged totals.",
    plan: plan(7, "payments", { events: [proposed("payments")], fixture_mutation: { type: "flip_refund_sign" }, expected_outcome: expect("repair_and_publish", "refund_convention_change", FIN_REV) }) },
  { case_no: 8, team: "payments", quick: false, title: "Currency field removed from a multicurrency sample", summary: "Payments proposes dropping currency while rows are in USD and EUR.", expected_result: "Reject the change; no mapping can recover the currency.",
    plan: plan(8, "payments", { starting_snapshot: "baseline_multicurrency", events: [proposed("payments")], fixture_mutation: { type: "drop_currency_field" }, expected_outcome: expect("hold_previous_snapshot", "currency_removed", FIN_REV) }) },
  { case_no: 9, team: "payments", quick: false, title: "Duplicate payment IDs arrive in one batch", summary: "Three payment IDs repeat inside the cycle batch.", expected_result: "Quarantine the batch; previous snapshot stays.",
    plan: plan(9, "payments", { events: [], fixture_mutation: { type: "duplicate_payments", count: 3 }, expected_outcome: expect("hold_previous_snapshot", "duplicate_ids", FIN_REV) }) },
  { case_no: 10, team: "payments", quick: false, title: "Already-applied batch delivered again", summary: "The Payments cycle batch is delivered twice.", expected_result: "Ignore the duplicate delivery; publish once.",
    plan: plan(10, "payments", { events: [ev(95, "source.batch.arrived", "payments", { batch: "redelivery" })], fixture_mutation: { type: "redeliver_batch", source: "payments" }, expected_outcome: expect("ignore_event", "none") }) },
  { case_no: 11, team: "payments", quick: false, title: "Old batch arrives after a newer batch", summary: "A previous-cycle Payments batch shows up after the current one was applied.", expected_result: "Ignore the stale batch; the newer data is published.",
    plan: plan(11, "payments", { events: [ev(100, "source.batch.arrived", "payments", { batch: "stale" })], fixture_mutation: { type: "stale_batch", source: "payments" }, expected_outcome: expect("ignore_event", "none") }) },
  { case_no: 12, team: "payments", quick: false, title: "Payment rows missing but the file is present", summary: "The Payments file arrives on time with six rows absent.", expected_result: "Quarantine the batch; previous snapshot stays.",
    plan: plan(12, "payments", { events: [], fixture_mutation: { type: "drop_payment_rows", count: 6 }, expected_outcome: expect("hold_previous_snapshot", "missing_rows", FIN_REV) }) },
  { case_no: 13, team: "orders", quick: false, title: "Orders volume falls outside the configured range", summary: "The Orders batch has 3 rows; the configured range is 8-30.", expected_result: "Quarantine the batch; previous snapshot stays.",
    plan: plan(13, "orders", { events: [], fixture_mutation: { type: "scale_order_volume", rows: 3 }, expected_outcome: expect("hold_previous_snapshot", "volume_anomaly", REV_OPS) }) },
  { case_no: 14, team: "shipping", quick: false, title: "Shipping export misses its progress time, arrives before cutoff", summary: "Shipping has not started by the warning time, then starts late and lands before the deadline.", expected_result: "Warn, update the warning as progress arrives, recover and publish.",
    plan: plan(14, "shipping", { events: [ev(95, "source.export.started", "shipping"), ev(120, "source.export.progress", "shipping", { percent: 60 }), ev(150, "source.batch.arrived", "shipping")], fixture_mutation: { type: "delay_export", source: "shipping" }, expected_outcome: expect("warn_and_recover", "late_delivery", ["dash.operations"]) }) },
  { case_no: 15, team: "shipping", quick: false, title: "Shipping export misses its hard deadline", summary: "Shipping starts very late and nothing arrives by the cutoff.", expected_result: "Mark Delayed; previous snapshot stays with its real as-of time.",
    plan: plan(15, "shipping", { events: [ev(160, "source.export.started", "shipping")], fixture_mutation: { type: "delay_export", source: "shipping" }, expected_outcome: expect("delayed_previous_snapshot", "missed_deadline", ["dash.operations"]) }) },
  { case_no: 16, team: "platform", quick: false, title: "Warehouse transformation fails after valid input", summary: "Every batch passes validation, but an order with quantity 0 breaks the unit-price transformation.", expected_result: "Hold publication; previous snapshot stays; owner is the data platform.",
    plan: plan(16, "orders", { events: [], fixture_mutation: { type: "zero_quantity_order" }, expected_outcome: expect("hold_previous_snapshot", "transform_failure", ["dash.finance", "dash.operations", "dash.revenue"]) }) },
  { case_no: 17, team: "shipping", quick: false, title: "Downstream join changes from one-to-one to one-to-many", summary: "Shipping declares a package-level grain with key (shipment_id, package_no).", expected_result: "Repair the staging key, verify the join still preserves order-level totals, publish.",
    plan: plan(17, "shipping", { events: [proposed("shipping")], fixture_mutation: { type: "split_into_packages" }, expected_outcome: expect("repair_and_publish", "key_cardinality_change", ["dash.operations"]) }) },
  { case_no: 18, team: "payments", quick: false, title: "Upstream change reverted after the warning", summary: "Payments proposes the cents change, then withdraws it before the effective time.", expected_result: "Close the incident as withdrawn; nothing is activated; publish as normal.",
    plan: plan(18, "payments", { events: [proposed("payments", 5, 110), ev(40, "source.change.withdrawn", "payments", { reason: "Rollout postponed" })], fixture_mutation: { type: "rename_amount_to_minor_units", new_name: "amount_cents", declare_unit: true, declare_rename: true }, expected_outcome: expect("withdrawn_no_change", "unit_and_name_change", FIN_REV) }) },
  { case_no: 19, team: "platform", quick: false, title: "Two independent changes in close succession", summary: "Payments proposes the cents change and, two minutes later, Orders proposes a nullable field.", expected_result: "Keep the two changes on separate incidents with separate evidence; repair one, pass the other, publish.",
    plan: plan(19, "payments", { events: [proposed("payments", 5, 45), proposed("orders", 7, 20)], fixture_mutation: [{ type: "rename_amount_to_minor_units", new_name: "amount_cents", declare_unit: true, declare_rename: true }, { type: "add_nullable_field", source: "orders", name: "gift_note", field_type: "string" }], expected_outcome: expect("repair_and_publish", "unit_and_name_change", FIN_REV) }) },
  { case_no: 20, team: "platform", quick: false, title: "OpenClaw or Cerebras unavailable during a rehearsal", summary: "The cents change is proposed while the agent runtime is down.", expected_result: "Deterministic validation still gates the change: nothing is activated and the previous snapshot stays.",
    plan: plan(20, "payments", { events: [proposed("payments")], fixture_mutation: { type: "rename_amount_to_minor_units", new_name: "amount_cents", declare_unit: true, declare_rename: true }, faults: ["agent_unavailable"], expected_outcome: expect("hold_previous_snapshot", "unknown", FIN_REV) }) },
];

export const catalogPlanId = (n: number) => `catalog-${String(n).padStart(2, "0")}`;
