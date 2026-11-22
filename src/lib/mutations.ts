import { z } from "zod";
import type { Outcome } from "./api-types";
import { traceImpact } from "./contracts";
import type { CauseCategory, Contract, Row, SourceId } from "./types";

const ident = z.string().regex(/^[a-z][a-z0-9_]{1,30}$/);
const source = z.enum(["orders", "payments", "shipping"]);

/**
 * Every fixture mutation the runner knows how to apply. A scenario plan can only name one of these
 * with validated parameters; free-form mutations are rejected.
 */
export const Mutation = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("rename_amount_to_minor_units"), new_name: ident, declare_unit: z.boolean(), declare_rename: z.boolean() }),
  z.strictObject({ type: z.literal("add_nullable_field"), source, name: ident, field_type: z.enum(["string", "integer"]) }),
  z.strictObject({ type: z.literal("remove_order_id") }),
  z.strictObject({ type: z.literal("require_region") }),
  z.strictObject({ type: z.literal("stringify_amounts") }),
  z.strictObject({ type: z.literal("flip_refund_sign") }),
  z.strictObject({ type: z.literal("drop_currency_field") }),
  z.strictObject({ type: z.literal("duplicate_payments"), count: z.number().int().min(1).max(4) }),
  z.strictObject({ type: z.literal("drop_payment_rows"), count: z.number().int().min(5).max(8) }),
  z.strictObject({ type: z.literal("redeliver_batch"), source }),
  z.strictObject({ type: z.literal("stale_batch"), source }),
  z.strictObject({ type: z.literal("scale_order_volume"), rows: z.number().int().min(0).max(80).refine((n) => n < 8 || n > 30, "rows must fall outside the configured 8-30 range") }),
  z.strictObject({ type: z.literal("delay_export"), source }),
  z.strictObject({ type: z.literal("zero_quantity_order") }),
  z.strictObject({ type: z.literal("split_into_packages") }),
]);
export type Mutation = z.infer<typeof Mutation>;
export type MutationType = Mutation["type"];

export type MutationMode = "proposal" | "batch" | "extra_batch" | "delivery";

interface Spec {
  teams: SourceId[];
  mode: MutationMode;
  params: string;
  summary: string;
}

export const MUTATION_SPECS: Record<MutationType, Spec> = {
  rename_amount_to_minor_units: { teams: ["payments"], mode: "proposal", params: "new_name (snake_case), declare_unit (bool), declare_rename (bool)", summary: "Propose renaming payment_amount and switching it from decimal dollars to integer minor units. The two flags control whether the producer declares the unit and the rename." },
  add_nullable_field: { teams: ["orders", "payments", "shipping"], mode: "proposal", params: "source, name (snake_case, must not already exist), field_type ('string'|'integer')", summary: "Propose adding one nullable field." },
  remove_order_id: { teams: ["orders"], mode: "proposal", params: "(none)", summary: "Propose removing the required order_id key from the Orders feed." },
  require_region: { teams: ["orders"], mode: "proposal", params: "(none)", summary: "Propose making nullable customer_region required while current rows still contain nulls." },
  stringify_amounts: { teams: ["payments"], mode: "batch", params: "(none)", summary: "The cycle batch arrives with payment_amount as strings instead of numbers, with no proposal." },
  flip_refund_sign: { teams: ["payments"], mode: "proposal", params: "(none)", summary: "Propose (and declare) that refunds become positive amounts identified by kind='refund'." },
  drop_currency_field: { teams: ["payments"], mode: "proposal", params: "(none)", summary: "Propose removing the currency field." },
  duplicate_payments: { teams: ["payments"], mode: "batch", params: "count (1-4)", summary: "The cycle batch repeats `count` payment IDs." },
  drop_payment_rows: { teams: ["payments"], mode: "batch", params: "count (5-8)", summary: "The cycle batch file arrives but `count` payment rows are absent." },
  redeliver_batch: { teams: ["orders", "payments", "shipping"], mode: "extra_batch", params: "source", summary: "The already-applied cycle batch is delivered a second time." },
  stale_batch: { teams: ["orders", "payments", "shipping"], mode: "extra_batch", params: "source", summary: "An older batch arrives after the newer cycle batch was applied." },
  scale_order_volume: { teams: ["orders"], mode: "batch", params: "rows (0-7 or 31-80)", summary: "The Orders cycle batch has `rows` rows, outside the configured 8-30 range." },
  delay_export: { teams: ["orders", "payments", "shipping"], mode: "delivery", params: "source", summary: "The export runs late. Timing comes from the plan's source.export.started / source.batch.arrived events; omit an event to make it never happen." },
  zero_quantity_order: { teams: ["orders"], mode: "batch", params: "(none)", summary: "A contract-valid order row has quantity 0, which makes a warehouse transformation fail." },
  split_into_packages: { teams: ["shipping"], mode: "proposal", params: "(none)", summary: "Propose changing the Shipping grain from one row per shipment to one row per package, declaring the new key." },
};

export const mutationSource = (m: Mutation): SourceId => {
  if ("source" in m) return m.source;
  return MUTATION_SPECS[m.type].teams[0];
};

export interface MutationEffect {
  source: SourceId;
  mode: MutationMode;
  /** Proposed next contract version (proposal mode). */
  candidateContract?: Contract;
  /** Rows the source's cycle batch carries: the same logical records, encoded as the mutation dictates. */
  rows?: Row[];
  extra?: "redelivery" | "stale";
}

const clone = <T>(v: T): T => structuredClone(v);
/** 12.34 dollars -> 1234 cents without floating point multiplication. */
function toCents(v: unknown): number {
  const [whole, frac = ""] = String(v).replace("-", "").split(".");
  const n = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return String(v).startsWith("-") ? -n : n;
}

export function buildEffect(m: Mutation, current: Contract, baseRows: Row[]): MutationEffect {
  const src = mutationSource(m);
  const mode = MUTATION_SPECS[m.type].mode;
  const next = (): Contract => ({ ...clone(current), version: current.version + 1 });
  switch (m.type) {
    case "rename_amount_to_minor_units": {
      const c = next();
      c.fields = c.fields.map((f) => (f.name === "payment_amount" ? { ...f, name: m.new_name, type: "integer", unit: m.declare_unit ? "cents" : null, semantic: m.declare_unit ? "Amount moved in integer minor units; refunds are negative" : "Amount moved" } : f));
      if (m.declare_rename) c.assertions = { renames: { [m.new_name]: "payment_amount" } };
      const rows = baseRows.map((r) => {
        const { payment_amount, ...rest } = r;
        const out: Row = {};
        for (const k of Object.keys(r)) out[k === "payment_amount" ? m.new_name : k] = k === "payment_amount" ? toCents(payment_amount) : rest[k];
        return out;
      });
      return { source: src, mode, candidateContract: c, rows };
    }
    case "add_nullable_field": {
      const c = next();
      c.fields.push({ name: m.name, type: m.field_type, required: false, nullable: true, semantic: "Optional attribute added by the producer", unit: null });
      const rows = baseRows.map((r, i) => ({ ...r, [m.name]: i % 3 === 0 ? null : m.field_type === "integer" ? i + 1 : `v${i + 1}` }));
      return { source: src, mode, candidateContract: c, rows };
    }
    case "remove_order_id": {
      const c = next();
      c.fields = c.fields.filter((f) => f.name !== "order_id");
      c.keys = [];
      return { source: src, mode, candidateContract: c, rows: baseRows.map(({ order_id: _drop, ...rest }) => rest) };
    }
    case "require_region": {
      const c = next();
      c.fields = c.fields.map((f) => (f.name === "customer_region" ? { ...f, nullable: false } : f));
      return { source: src, mode, candidateContract: c, rows: clone(baseRows) };
    }
    case "flip_refund_sign": {
      const c = next();
      c.semantics = { ...c.semantics, refund_convention: "positive_amount_with_kind" };
      c.fields = c.fields.map((f) => (f.name === "payment_amount" ? { ...f, semantic: "Amount moved, always positive; refunds are identified by kind" } : f));
      const rows = baseRows.map((r) => (r.kind === "refund" ? { ...r, payment_amount: Math.abs(r.payment_amount as number) } : { ...r }));
      return { source: src, mode, candidateContract: c, rows };
    }
    case "drop_currency_field": {
      const c = next();
      c.fields = c.fields.filter((f) => f.name !== "currency");
      return { source: src, mode, candidateContract: c, rows: baseRows.map(({ currency: _drop, ...rest }) => rest) };
    }
    case "split_into_packages": {
      const c = next();
      c.fields.push({ name: "package_no", type: "integer", required: true, nullable: false, semantic: "Package sequence within the shipment, starting at 1", unit: null });
      c.keys = ["shipment_id", "package_no"];
      c.grain = "one row per package; a shipment can have several";
      const rows = baseRows.flatMap((r, i) => (i < 3 ? [{ ...r, package_no: 1 }, { ...r, package_no: 2 }] : [{ ...r, package_no: 1 }]));
      return { source: src, mode, candidateContract: c, rows };
    }
    case "stringify_amounts":
      return { source: src, mode, rows: baseRows.map((r) => ({ ...r, payment_amount: (r.payment_amount as number).toFixed(2) })) };
    case "duplicate_payments":
      return { source: src, mode, rows: [...clone(baseRows), ...clone(baseRows.slice(0, m.count))] };
    case "drop_payment_rows":
      return { source: src, mode, rows: clone(baseRows.slice(0, baseRows.length - m.count)) };
    case "scale_order_volume": {
      const rows = clone(baseRows.slice(0, m.rows));
      for (let i = rows.length; i < m.rows; i++) rows.push({ ...clone(baseRows[i % baseRows.length]), order_id: `O-${2001 + i}` });
      return { source: src, mode, rows };
    }
    case "zero_quantity_order":
      return { source: src, mode, rows: baseRows.map((r, i) => (i === 4 ? { ...r, quantity: 0 } : { ...r })) };
    case "redeliver_batch":
      return { source: src, mode, extra: "redelivery" };
    case "stale_batch":
      return { source: src, mode, extra: "stale" };
    case "delay_export":
      return { source: src, mode };
  }
}

export interface RuleExpectation {
  outcome: Outcome;
  cause_category: CauseCategory | "none";
  impacted_dashboards: string[];
}

const dash = (source: SourceId | "warehouse", fields: string[] = []) => traceImpact(source, fields).dashboards;

/**
 * What the application's own rules say a mutation must lead to. Used to reject scenario plans whose
 * claimed expected outcome contradicts the mutation they declare. `timing` is only read for delay_export.
 */
export function ruleExpectation(m: Mutation, timing: { late: boolean; arrivesBeforeCutoff: boolean; withdrawn: boolean }): RuleExpectation {
  const src = mutationSource(m);
  const base = ((): RuleExpectation => {
    switch (m.type) {
      case "rename_amount_to_minor_units":
        return m.declare_unit && m.declare_rename
          ? { outcome: "repair_and_publish", cause_category: "unit_and_name_change", impacted_dashboards: dash("payments", ["payment_amount"]) }
          : { outcome: "block_pending_clarification", cause_category: "ambiguous_contract", impacted_dashboards: dash("payments", ["payment_amount"]) };
      case "add_nullable_field":
        return { outcome: "pass_and_publish", cause_category: "additive_change", impacted_dashboards: [] };
      case "remove_order_id":
        return { outcome: "hold_previous_snapshot", cause_category: "required_key_removed", impacted_dashboards: dash("orders", ["order_id"]) };
      case "require_region":
        return { outcome: "hold_previous_snapshot", cause_category: "nullability_violation", impacted_dashboards: dash("orders") };
      case "flip_refund_sign":
        return { outcome: "repair_and_publish", cause_category: "refund_convention_change", impacted_dashboards: dash("payments", ["payment_amount", "kind"]) };
      case "drop_currency_field":
        return { outcome: "hold_previous_snapshot", cause_category: "currency_removed", impacted_dashboards: dash("payments", ["currency"]) };
      case "split_into_packages":
        return { outcome: "repair_and_publish", cause_category: "key_cardinality_change", impacted_dashboards: dash("shipping") };
      case "stringify_amounts":
        return { outcome: "hold_previous_snapshot", cause_category: "type_drift", impacted_dashboards: dash("payments") };
      case "duplicate_payments":
        return { outcome: "hold_previous_snapshot", cause_category: "duplicate_ids", impacted_dashboards: dash("payments") };
      case "drop_payment_rows":
        return { outcome: "hold_previous_snapshot", cause_category: "missing_rows", impacted_dashboards: dash("payments") };
      case "scale_order_volume":
        return { outcome: "hold_previous_snapshot", cause_category: "volume_anomaly", impacted_dashboards: dash("orders") };
      case "zero_quantity_order":
        return { outcome: "hold_previous_snapshot", cause_category: "transform_failure", impacted_dashboards: dash("warehouse") };
      case "redeliver_batch":
      case "stale_batch":
        return { outcome: "ignore_event", cause_category: "none", impacted_dashboards: [] };
      case "delay_export":
        if (!timing.arrivesBeforeCutoff) return { outcome: "delayed_previous_snapshot", cause_category: "missed_deadline", impacted_dashboards: dash(src) };
        if (timing.late) return { outcome: "warn_and_recover", cause_category: "late_delivery", impacted_dashboards: dash(src) };
        return { outcome: "pass_and_publish", cause_category: "none", impacted_dashboards: [] };
    }
  })();
  if (timing.withdrawn && MUTATION_SPECS[m.type].mode === "proposal") return { ...base, outcome: "withdrawn_no_change" };
  return base;
}
