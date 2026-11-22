import type { RoleKey } from "../config";
import { classifyChanges, categoryForBatchProblems, type ContractChange } from "../contracts";
import type { RepairOperation } from "../repair-ops";
import type { Contract, Mapping } from "../types";

/**
 * Fixture mode: deterministic stand-ins for the agents, used for repeatable tests and provider outages.
 * They read the same packet a live agent receives (never the scenario answer key) and return the same
 * JSON shapes, so everything downstream is exercised identically. Runs using them are labelled.
 */
export function fixtureTurn(role: RoleKey, packet: any, opts: { attempt: number; faults: string[] }): string {
  if (role === "investigator") return JSON.stringify(investigate(packet, opts));
  if (role === "repair") return JSON.stringify(repair(packet, opts));
  return JSON.stringify(author(packet, opts));
}

const body = (packet: any, kind: string) => packet.evidence.find((e: any) => e.kind === kind);
const ids = (packet: any, ...kinds: string[]) => packet.evidence.filter((e: any) => kinds.includes(e.kind)).map((e: any) => e.id);

function investigate(packet: any, opts: { faults: string[]; attempt: number }) {
  const diff = body(packet, "contract_diff");
  const impact = body(packet, "lineage_impact");
  const owner = body(packet, "ownership");
  const failed = body(packet, "failed_checks");
  const impacted: string[] = impact?.body.assets ?? [];
  let category = "unknown";
  let status: "confirmed" | "likely" | "unknown" = "unknown";
  let cause = "The evidence does not identify a specific cause.";
  const facts: { statement: string; evidence_ids: string[] }[] = [];
  let ownerTeam: string = owner?.body.team ?? packet.owners[0];
  if (diff) {
    const cls = classifyChanges(body(packet, "current_contract").body as Contract, body(packet, "proposed_contract").body as Contract, diff.body.changes as ContractChange[], body(packet, "sample_rows")?.body.current ?? []);
    category = cls.category;
    status = category === "ambiguous_contract" ? "likely" : category === "unknown" ? "unknown" : "confirmed";
    cause = cls.summary;
    facts.push({ statement: `The proposed contract differs from the active one: ${cls.summary}`, evidence_ids: [diff.id] });
    const sample = body(packet, "sample_rows");
    if (sample) facts.push({ statement: "Representative rows show how the same records are encoded before and after the change.", evidence_ids: [sample.id] });
    const mapping = body(packet, "current_mapping");
    if (mapping) facts.push({ statement: "The active downstream mapping still reads the current field names and units.", evidence_ids: [mapping.id] });
  } else if (failed) {
    category = categoryForBatchProblems(failed.body.checks);
    status = category === "unknown" ? "unknown" : "confirmed";
    cause = failed.body.checks.map((c: any) => c.detail).join("; ");
    facts.push({ statement: `Deterministic checks failed: ${cause}`, evidence_ids: [failed.id] });
    if (category === "transform_failure") ownerTeam = "data-platform";
  }
  if (impact) facts.push({ statement: `Lineage places ${impacted.filter((a) => a.startsWith("dash.")).join(", ") || "no dashboards"} downstream.`, evidence_ids: [impact.id] });
  const cited = opts.faults.includes("wrong_evidence") && opts.attempt === 1 ? ["E-00000000-99"] : [...new Set(facts.flatMap((f) => f.evidence_ids))];
  return {
    observed_facts: facts.length ? facts : [{ statement: "No decisive evidence.", evidence_ids: [packet.evidence[0].id] }],
    cause_status: status,
    cause_category: category,
    candidate_cause: cause,
    evidence_ids: cited,
    impacted_assets: impacted,
    owner: ownerTeam,
    severity: impacted.some((a) => a === "dash.finance") ? "high" : impacted.length ? "medium" : "low",
    next_verification_step: status === "confirmed" ? null : "Ask the owning team to confirm the contract facts that are not declared.",
  };
}

function repair(packet: any, opts: { faults: string[] }) {
  const changes: ContractChange[] = packet.contract_changes;
  const cand: Contract = packet.proposed_contract;
  const mapping: Mapping = packet.current_mapping;
  const src = packet.source;
  const ops: RepairOperation[] = [];
  const targetOf = (from: string) => Object.entries(mapping.fields).find(([, f]) => f.from === from)?.[0];
  const none = (decision: "need_contract_fact" | "no_safe_repair", missing: string[], question: string | null) => ({ decision, operations: [], assumptions: [], expected_invariants: [], missing_facts: missing, question_for_owner: question });

  const removed = changes.filter((c) => c.kind === "field_removed");
  const renamed = changes.filter((c) => c.kind === "field_renamed");
  const addedMoney = changes.filter((c) => c.kind === "field_added" && (c.type === "integer" || c.type === "decimal") && !c.nullable && c.field !== "package_no");
  if (removed.some((c) => c.kind === "field_removed" && mapping.fields[targetOf(c.field) ?? ""] && (mapping.fields[targetOf(c.field)!].as ?? "").match(/cents|minor/)) && addedMoney.length)
    return none("need_contract_fact", [`Does ${addedMoney[0].kind === "field_added" ? addedMoney[0].field : ""} replace the removed money field?`, "What unit is the new field in (dollars or cents)?"], "Please declare the unit of the new amount field and confirm it replaces payment_amount.");
  if (changes.some((c) => c.kind === "unit_changed" && c.to === null)) return none("need_contract_fact", ["Declared unit of the changed money field"], "Which unit is the field in?");
  if (removed.length) return none("no_safe_repair", [], `Downstream models require ${removed.map((c) => (c.kind === "field_removed" ? c.field : "")).join(", ")}; no mapping change can recreate it.`);
  if (changes.some((c) => c.kind === "nullability_tightened")) return none("no_safe_repair", [], "Existing rows violate the proposed non-null constraint; the producer must backfill before the change ships.");

  for (const c of renamed) if (c.kind === "field_renamed" && targetOf(c.from)) ops.push({ op: "rename_field", source: src, target: targetOf(c.from)!, from: c.from, to: c.to });
  if (!opts.faults.includes("bad_repair"))
    for (const c of changes) if (c.kind === "unit_changed" && c.to === "cents" && targetOf(c.previous_field)) ops.push({ op: "convert_minor_units", source: src, target: targetOf(c.previous_field)!, unit: "cents" });
  for (const c of changes) if (c.kind === "semantic_changed" && c.key === "refund_convention" && c.to) ops.push({ op: "set_refund_convention", source: "payments", convention: c.to as "positive_amount_with_kind" });
  const keys = changes.find((c) => c.kind === "keys_changed");
  if (keys?.kind === "keys_changed") {
    for (const k of keys.to) if (!mapping.fields[k]) ops.push({ op: "update_field_mapping", source: src, target: k, from: k, as: cand.fields.find((f) => f.name === k)?.type === "integer" ? "integer" : "string" });
    ops.push({ op: "update_keys", source: src, keys: keys.to });
  }
  if (!ops.length) return none("no_safe_repair", [], "No supported mapping operation addresses this change.");
  return {
    decision: "propose",
    operations: ops,
    assumptions: ["The proposed contract's declared units, keys and conventions are accurate.", "Candidate rows carry the same logical records as the current feed."],
    expected_invariants: ["Every record normalizes to the same canonical cents, currency and order as before.", "Row counts, per-currency totals and all dashboard totals are unchanged."],
    missing_facts: [],
    question_for_owner: null,
  };
}

/** Deterministic PRNG so the same seed always yields the same plan. */
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function author(packet: any, opts: { attempt: number; faults: string[] }) {
  const team: "orders" | "payments" | "shipping" = packet.team;
  const seed: number = packet.seed;
  const rnd = mulberry(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  const proposed = (eff: number) => [{ offset_min: 4 + Math.floor(rnd() * 8), type: "source.change.proposed", source: team, payload: { effective_in_min: eff } }];
  const D: Record<string, string[]> = { payments: ["dash.finance", "dash.revenue"], orders: ["dash.operations", "dash.revenue"], shipping: ["dash.operations"] };
  const word = pick(["note", "channel", "batch_tag", "priority", "origin_code", "promo_ref"]);
  const variants: Record<string, (() => any)[]> = {
    payments: [
      () => ({ m: { type: "rename_amount_to_minor_units", new_name: pick(["amount_minor", "settled_cents", "amount_cents"]), declare_unit: true, declare_rename: true }, ev: proposed(40 + Math.floor(rnd() * 30)), out: ["repair_and_publish", "unit_and_name_change", D.payments] }),
      () => ({ m: { type: "rename_amount_to_minor_units", new_name: pick(["amount", "value", "total"]), declare_unit: false, declare_rename: rnd() > 0.5 }, ev: proposed(45), out: ["block_pending_clarification", "ambiguous_contract", D.payments] }),
      () => ({ m: { type: "duplicate_payments", count: 1 + Math.floor(rnd() * 4) }, ev: [], out: ["hold_previous_snapshot", "duplicate_ids", D.payments] }),
      () => ({ m: { type: "flip_refund_sign" }, ev: proposed(50), out: ["repair_and_publish", "refund_convention_change", D.payments] }),
      () => ({ m: { type: "drop_payment_rows", count: 5 + Math.floor(rnd() * 4) }, ev: [], out: ["hold_previous_snapshot", "missing_rows", D.payments] }),
    ],
    orders: [
      () => ({ m: { type: "add_nullable_field", source: "orders", name: `order_${word}`, field_type: pick(["string", "integer"]) }, ev: proposed(30), out: ["pass_and_publish", "additive_change", []] }),
      () => ({ m: { type: "scale_order_volume", rows: pick([2, 5, 36, 48]) }, ev: [], out: ["hold_previous_snapshot", "volume_anomaly", D.orders] }),
      () => ({ m: { type: "require_region" }, ev: proposed(60), out: ["hold_previous_snapshot", "nullability_violation", D.orders] }),
      () => ({ m: { type: "remove_order_id" }, ev: proposed(45), out: ["hold_previous_snapshot", "required_key_removed", D.orders] }),
    ],
    shipping: [
      () => { const s = 50 + Math.floor(rnd() * 60); return { m: { type: "delay_export", source: "shipping" }, ev: [{ offset_min: s, type: "source.export.started", source: team, payload: {} }, { offset_min: s + 30, type: "source.batch.arrived", source: team, payload: {} }], out: ["warn_and_recover", "late_delivery", D.shipping] }; },
      () => ({ m: { type: "delay_export", source: "shipping" }, ev: [{ offset_min: 150 + Math.floor(rnd() * 20), type: "source.export.started", source: team, payload: {} }], out: ["delayed_previous_snapshot", "missed_deadline", D.shipping] }),
      () => ({ m: { type: "split_into_packages" }, ev: proposed(45), out: ["repair_and_publish", "key_cardinality_change", D.shipping] }),
      () => ({ m: { type: "add_nullable_field", source: "shipping", name: `ship_${word}`, field_type: "string" }, ev: proposed(35), out: ["pass_and_publish", "additive_change", []] }),
    ],
  };
  const v = variants[team][seed % variants[team].length]();
  const plan = {
    scenario_id: `${team}-variant-${seed}`,
    team,
    seed,
    starting_snapshot: "baseline_usd",
    events: v.ev,
    fixture_mutation: v.m,
    expected_outcome: { outcome: v.out[0], cause_category: v.out[1], impacted_dashboards: v.out[2] },
  };
  // Every third seed the first draft makes a typical authoring mistake, so the rejection-and-rerun path is visible.
  if (opts.attempt === 1 && seed % 3 === 0) plan.events = [...plan.events, { offset_min: 170, type: "snapshot.published", source: team, payload: {} }];
  return plan;
}
