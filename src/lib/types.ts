import type { Outcome, Owner } from "./api-types";

export type SourceId = "orders" | "payments" | "shipping";
export const SOURCES: SourceId[] = ["orders", "payments", "shipping"];
export type Row = Record<string, unknown>;
export type Dataset = "baseline_usd" | "baseline_multicurrency";

export interface ContractField {
  name: string;
  type: "string" | "integer" | "decimal" | "timestamp";
  required: boolean;
  nullable: boolean;
  semantic: string;
  /** Producer-declared unit. null means the producer has not declared one. */
  unit: string | null;
}

export interface Contract {
  source: SourceId;
  team: string;
  version: number;
  owner: Owner;
  keys: string[];
  grain: string;
  currency_policy: { mode: "per_row" | "single" | "none"; field?: string; currency?: string };
  fields: ContractField[];
  /** Declared conventions, e.g. { refund_convention: "negative_amount" }. */
  semantics: Record<string, string>;
  delivery: { expected_start_min: number; expected_progress_min: number; hard_deadline_min: number; grace_min: number };
  volume: { min_rows: number; max_rows: number };
  /** Explicit producer assertions attached to a proposed version. */
  assertions?: { renames?: Record<string, string> };
}

export interface FieldMapping {
  from?: string;
  as?: string;
  const?: unknown;
}
export interface Mapping {
  mapping_version: number;
  source: SourceId;
  built_for_contract: number;
  keys: string[];
  refund_convention?: string;
  fields: Record<string, FieldMapping>;
}

export interface PipelineOutput {
  staging: Record<SourceId, { rows: number; rejected: { index: number; reason: string }[]; duplicates: string[] }>;
  payment_facts: { payment_id: string; order_id: string; amount_cents: string; currency: string; kind: string }[];
  order_facts: { order_id: string; currency: string; order_total_cents: string; paid_cents: string; payments: number; shipments: number; shipped: boolean; delivered: boolean }[];
  foreign_keys: { payments_without_order: string[]; shipments_without_order: string[] };
  grain: { orders: number; order_facts: number; paid_by_order_facts: Record<string, string>; paid_by_payment_facts: Record<string, string> };
  dashboards: Record<"finance" | "revenue" | "operations", Record<string, string>>;
}
export type PipelineResult = { ok: true; output: PipelineOutput } | { ok: false; error: { message: string; step: string } };

export const CAUSE_CATEGORIES = {
  unit_and_name_change: "A money field is renamed and its unit changes, and the producer declares both.",
  ambiguous_contract: "A field changes but the producer has not declared the unit, the rename, or the semantics needed to map it safely.",
  additive_change: "Only optional/nullable fields are added. Existing fields are untouched.",
  required_key_removed: "A key or join field that downstream models depend on is removed.",
  nullability_violation: "A field becomes required while existing rows still contain nulls.",
  type_drift: "Values arrive with a different type than the active contract declares, without a proposal.",
  refund_convention_change: "The sign convention for refunds changes.",
  currency_removed: "The currency field is removed while rows are in more than one currency.",
  duplicate_ids: "A batch contains repeated primary keys.",
  missing_rows: "A batch arrived but a material share of expected rows is absent.",
  volume_anomaly: "Row volume falls outside the configured range for the feed.",
  late_delivery: "An export missed its expected progress time but can still arrive before the cutoff.",
  missed_deadline: "An export did not arrive by the hard deadline.",
  transform_failure: "Input passed validation but a warehouse transformation failed.",
  key_cardinality_change: "The grain or key of a feed changes, altering join cardinality downstream.",
  unknown: "The evidence does not support a specific cause.",
} as const;
export type CauseCategory = keyof typeof CAUSE_CATEGORIES;

export interface Expectation {
  outcome: Outcome;
  cause_category: CauseCategory | "none";
  impacted_dashboards: string[];
}

export const OUTCOMES: Outcome[] = [
  "repair_and_publish",
  "pass_and_publish",
  "block_pending_clarification",
  "hold_previous_snapshot",
  "warn_and_recover",
  "delayed_previous_snapshot",
  "ignore_event",
  "withdrawn_no_change",
];
