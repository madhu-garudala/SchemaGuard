import { lineage } from "./fixtures";
import type { CauseCategory, Contract, ContractField, Row, SourceId } from "./types";

export type ContractChange =
  | { kind: "field_added"; field: string; type: string; nullable: boolean; unit: string | null }
  | { kind: "field_removed"; field: string; was_key: boolean }
  | { kind: "field_renamed"; from: string; to: string; declared: true }
  | { kind: "type_changed"; field: string; from: string; to: string; previous_field: string }
  | { kind: "unit_changed"; field: string; from: string | null; to: string | null; previous_field: string }
  | { kind: "nullability_tightened"; field: string }
  | { kind: "nullability_loosened"; field: string }
  | { kind: "keys_changed"; from: string[]; to: string[] }
  | { kind: "semantic_changed"; key: string; from: string | null; to: string | null };

/** Join fields that downstream facts depend on even when they are not the feed's primary key. */
const JOIN_FIELDS = new Set(["order_id"]);

/** Structural comparison of a candidate contract against the current one. Runs before any candidate data. */
export function diffContracts(current: Contract, candidate: Contract): ContractChange[] {
  const changes: ContractChange[] = [];
  const cur = new Map(current.fields.map((f) => [f.name, f]));
  const cand = new Map(candidate.fields.map((f) => [f.name, f]));
  const renames = candidate.assertions?.renames ?? {};
  const renamedFrom = new Set<string>();

  const compare = (before: ContractField, after: ContractField) => {
    if (before.type !== after.type) changes.push({ kind: "type_changed", field: after.name, from: before.type, to: after.type, previous_field: before.name });
    if ((before.unit ?? null) !== (after.unit ?? null)) changes.push({ kind: "unit_changed", field: after.name, from: before.unit, to: after.unit, previous_field: before.name });
    if (before.nullable && !after.nullable) changes.push({ kind: "nullability_tightened", field: after.name });
    if (!before.nullable && after.nullable) changes.push({ kind: "nullability_loosened", field: after.name });
  };

  for (const [to, from] of Object.entries(renames)) {
    const before = cur.get(from);
    const after = cand.get(to);
    if (!before || !after || cand.has(from)) continue;
    renamedFrom.add(from);
    changes.push({ kind: "field_renamed", from, to, declared: true });
    compare(before, after);
  }
  for (const [name, f] of cand) {
    if (renames[name] && renamedFrom.has(renames[name])) continue;
    const before = cur.get(name);
    if (!before) changes.push({ kind: "field_added", field: name, type: f.type, nullable: f.nullable, unit: f.unit });
    else compare(before, f);
  }
  for (const name of cur.keys()) {
    if (cand.has(name) || renamedFrom.has(name)) continue;
    changes.push({ kind: "field_removed", field: name, was_key: current.keys.includes(name) || JOIN_FIELDS.has(name) });
  }
  if (current.keys.join("|") !== candidate.keys.join("|")) changes.push({ kind: "keys_changed", from: current.keys, to: candidate.keys });
  const semKeys = new Set([...Object.keys(current.semantics), ...Object.keys(candidate.semantics)]);
  for (const key of semKeys) {
    const from = current.semantics[key] ?? null;
    const to = candidate.semantics[key] ?? null;
    if (from !== to) changes.push({ kind: "semantic_changed", key, from, to });
  }
  return changes;
}

export interface Classification {
  risk: "none" | "safe_additive" | "breaking";
  category: CauseCategory;
  affected_fields: string[];
  summary: string;
}

const MONEY_TYPES = new Set(["decimal", "integer"]);

/** Deterministic watcher classification. It decides whether to open a rehearsal; it never decides the repair. */
export function classifyChanges(current: Contract, candidate: Contract, changes: ContractChange[], sampleRows: Row[] = []): Classification {
  if (changes.length === 0) return { risk: "none", category: "unknown", affected_fields: [], summary: "No contract differences." };
  const additive = changes.every((c) => (c.kind === "field_added" && c.nullable) || c.kind === "nullability_loosened");
  if (additive) {
    const names = changes.map((c) => ("field" in c ? c.field : "")).filter(Boolean);
    return { risk: "safe_additive", category: "additive_change", affected_fields: [], summary: `Adds nullable field(s) ${names.join(", ")}; existing fields unchanged.` };
  }
  const affected = new Set<string>();
  for (const c of changes) {
    if (c.kind === "field_removed") affected.add(c.field);
    if (c.kind === "field_renamed") affected.add(c.from);
    if (c.kind === "type_changed" || c.kind === "unit_changed") affected.add(c.previous_field);
    if (c.kind === "nullability_tightened") affected.add(c.field);
  }
  const has = <K extends ContractChange["kind"]>(k: K) => changes.find((c) => c.kind === k) as Extract<ContractChange, { kind: K }> | undefined;
  const currentMoney = new Set(current.fields.filter((f) => f.unit === "dollars" || f.unit === "cents").map((f) => f.name));
  const removedMoney = changes.find((c) => c.kind === "field_removed" && currentMoney.has(c.field));
  const addedMoney = changes.find((c) => c.kind === "field_added" && MONEY_TYPES.has(c.type) && !c.nullable && c.field !== "package_no");
  const unitToNull = changes.find((c) => c.kind === "unit_changed" && c.to === null);

  let category: CauseCategory = "unknown";
  let summary = "Breaking contract change.";
  if ((removedMoney && addedMoney) || unitToNull) {
    category = "ambiguous_contract";
    summary = "A money field changes but the producer has not declared the new unit or the rename.";
  } else if (has("field_renamed") && has("unit_changed")) {
    const r = has("field_renamed")!;
    const u = has("unit_changed")!;
    category = "unit_and_name_change";
    summary = `${r.from} is renamed to ${r.to} and its unit changes from ${u.from} to ${u.to}.`;
  } else if (changes.some((c) => c.kind === "field_removed" && c.field === (current.currency_policy.field ?? "currency"))) {
    category = "currency_removed";
    summary = "The currency field is removed.";
  } else if (changes.some((c) => c.kind === "field_removed" && c.was_key)) {
    category = "required_key_removed";
    const removed = changes.find((c): c is Extract<ContractChange, { kind: "field_removed" }> => c.kind === "field_removed" && c.was_key)!;
    summary = `Key field ${removed.field} is removed.`;
  } else if (has("semantic_changed")?.key === "refund_convention") {
    const s = has("semantic_changed")!;
    category = "refund_convention_change";
    summary = `Refund convention changes from ${s.from} to ${s.to}.`;
    affected.add("payment_amount");
    affected.add("kind");
  } else if (has("keys_changed")) {
    const k = has("keys_changed")!;
    category = "key_cardinality_change";
    summary = `Feed key changes from (${k.from.join(", ")}) to (${k.to.join(", ")}).`;
  } else if (has("nullability_tightened")) {
    const n = has("nullability_tightened")!;
    const nulls = sampleRows.filter((r) => r[n.field] === null || r[n.field] === undefined).length;
    category = "nullability_violation";
    affected.clear(); // rows would be rejected wholesale, so the impact is dataset-level
    summary = `${n.field} becomes required; ${nulls} of ${sampleRows.length} current rows are null.`;
  } else if (has("type_changed")) {
    category = "type_drift";
    summary = `Type of ${has("type_changed")!.field} changes.`;
  }
  return { risk: "breaking", category, affected_fields: [...affected], summary };
}

/** Downstream datasets and dashboards for a change, column-aware where the lineage records columns. */
export function traceImpact(source: SourceId | "warehouse", fields: string[]): { assets: string[]; dashboards: string[] } {
  const lin = lineage();
  const assets = new Set<string>();
  const known = fields.filter((f) => lin.column_impacts[`${source}.${f}`] !== undefined);
  if (fields.length === 0 || known.length !== fields.length) for (const a of lin.dataset_impacts[source] ?? []) assets.add(a);
  for (const f of known) for (const a of lin.column_impacts[`${source}.${f}`]) assets.add(a);
  const order = lin.nodes.map((n) => n.id);
  const sorted = [...assets].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return { assets: sorted, dashboards: sorted.filter((a) => a.startsWith("dash.")) };
}

export interface BatchProblem {
  check: "type_mismatch" | "missing_required" | "null_not_allowed" | "duplicate_keys" | "volume_out_of_range" | "orders_without_payments" | "contract_version_mismatch" | "transformation";
  detail: string;
  count: number;
  sample: Row[];
}

function typeOk(type: ContractField["type"], v: unknown): boolean {
  if (type === "string" || type === "timestamp") return typeof v === "string";
  if (type === "integer") return typeof v === "number" && Number.isSafeInteger(v);
  // decimal: a JSON number with at most two fractional digits
  return typeof v === "number" && Number.isFinite(v) && /^-?\d+(\.\d{1,2})?$/.test(String(v));
}

/** Staging validation of an arrived batch against the ACTIVE contract. */
export function validateBatch(contract: Contract, rows: Row[]): { ok: boolean; problems: BatchProblem[] } {
  const problems: BatchProblem[] = [];
  const push = (check: BatchProblem["check"], detail: string, bad: Row[]) => {
    if (bad.length) problems.push({ check, detail, count: bad.length, sample: bad.slice(0, 3) });
  };
  for (const f of contract.fields) {
    push("missing_required", `field ${f.name} is absent`, f.required ? rows.filter((r) => !(f.name in r)) : []);
    push("null_not_allowed", `field ${f.name} is null but the contract says non-nullable`, rows.filter((r) => f.name in r && r[f.name] === null && !f.nullable));
    const wrong = rows.filter((r) => f.name in r && r[f.name] !== null && !typeOk(f.type, r[f.name]));
    push("type_mismatch", `field ${f.name} should be ${f.type}; got ${wrong.length ? typeof wrong[0][f.name] : ""}`, wrong);
  }
  const seen = new Map<string, number>();
  for (const r of rows) {
    const k = contract.keys.map((key) => String(r[key])).join("|");
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const dupKeys = new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
  push("duplicate_keys", `key (${contract.keys.join(", ")}) repeats: ${[...dupKeys].slice(0, 4).join(", ")}`, rows.filter((r) => dupKeys.has(contract.keys.map((key) => String(r[key])).join("|"))));
  if (rows.length < contract.volume.min_rows || rows.length > contract.volume.max_rows)
    problems.push({ check: "volume_out_of_range", detail: `${rows.length} rows; configured range is ${contract.volume.min_rows}-${contract.volume.max_rows}`, count: rows.length, sample: [] });
  return { ok: problems.length === 0, problems };
}

export function categoryForBatchProblems(problems: { check: string }[]): CauseCategory {
  const has = (c: string) => problems.some((p) => p.check === c);
  if (has("type_mismatch")) return "type_drift";
  if (has("duplicate_keys")) return "duplicate_ids";
  if (has("orders_without_payments")) return "missing_rows";
  if (has("volume_out_of_range")) return "volume_anomaly";
  if (has("transformation")) return "transform_failure";
  if (has("missing_required")) return "required_key_removed";
  return "unknown";
}
