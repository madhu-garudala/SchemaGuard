import { z } from "zod";
import type { Contract, Mapping } from "./types";

const source = z.enum(["orders", "payments", "shipping"]);
const ident = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/);

/** The only operations a repair may contain. Anything else is rejected before it touches a file. */
export const RepairOperation = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("rename_field"), source, target: ident, from: ident, to: ident }),
  z.strictObject({ op: z.literal("convert_minor_units"), source, target: ident, unit: z.literal("cents") }),
  z.strictObject({ op: z.literal("update_field_mapping"), source, target: ident, from: ident, as: z.enum(["string", "optional_string", "integer", "dollars_to_cents", "minor_units"]) }),
  z.strictObject({ op: z.literal("update_keys"), source, keys: z.array(ident).min(1).max(4) }),
  z.strictObject({ op: z.literal("set_refund_convention"), source: z.literal("payments"), convention: z.enum(["negative_amount", "positive_amount_with_kind"]) }),
]);
export type RepairOperation = z.infer<typeof RepairOperation>;

export const OPERATION_DOCS = [
  { op: "rename_field", fields: "source, target, from, to", meaning: "Canonical field `target` now reads source field `to` instead of `from`. Requires the producer to declare the rename." },
  { op: "convert_minor_units", fields: "source, target, unit:'cents'", meaning: "The source value for `target` is already integer cents, so stop multiplying by 100. Requires the producer to declare unit=cents on that field." },
  { op: "update_field_mapping", fields: "source, target, from, as", meaning: "Add or replace one field mapping. `as` is one of string | optional_string | integer | dollars_to_cents | minor_units. Money casts require a declared unit." },
  { op: "update_keys", fields: "source, keys[]", meaning: "Change the de-duplication key of the staged feed. Requires the candidate contract to declare exactly these keys; every key must be a mapped field." },
  { op: "set_refund_convention", fields: "source:'payments', convention", meaning: "negative_amount | positive_amount_with_kind. Requires the producer to declare the convention." },
];

/** Pure application of operations to mapping documents. Throws on anything inconsistent. */
export function applyOperations(mappings: Record<string, Mapping>, ops: RepairOperation[], candidateVersion: Record<string, number> = {}): Record<string, Mapping> {
  const out: Record<string, Mapping> = structuredClone(mappings);
  for (const op of ops) {
    const m = out[op.source];
    if (!m) throw new Error(`no mapping for source ${op.source}`);
    switch (op.op) {
      case "rename_field": {
        const f = m.fields[op.target];
        if (!f) throw new Error(`rename_field: ${op.source}.${op.target} is not a mapped field`);
        if (f.from !== op.from) throw new Error(`rename_field: ${op.target} reads "${f.from}", not "${op.from}"`);
        f.from = op.to;
        break;
      }
      case "convert_minor_units": {
        const f = m.fields[op.target];
        if (!f) throw new Error(`convert_minor_units: ${op.source}.${op.target} is not a mapped field`);
        f.as = "minor_units";
        break;
      }
      case "update_field_mapping":
        m.fields[op.target] = { from: op.from, as: op.as };
        break;
      case "update_keys":
        for (const k of op.keys) if (!m.fields[k]) throw new Error(`update_keys: "${k}" is not a mapped field`);
        m.keys = op.keys;
        break;
      case "set_refund_convention":
        m.refund_convention = op.convention;
        break;
    }
  }
  for (const s of new Set(ops.map((o) => o.source))) {
    out[s].mapping_version += 1;
    if (candidateVersion[s]) out[s].built_for_contract = candidateVersion[s];
  }
  return out;
}

export interface GateItem {
  assertion: string;
  present: boolean;
  detail: string;
  /** "missing" = the producer has not declared it. "contradicted" = the producer declared something else. */
  kind?: "missing" | "contradicted";
}

const MONEY_CAST_UNIT: Record<string, string> = { dollars_to_cents: "dollars", minor_units: "cents" };

/**
 * Contract-assertion gate. Sample rows that happen to reconcile cannot establish an undocumented
 * contract: every unit, key, rename and semantic the repair relies on must be declared by the producer.
 */
export function assertionGate(ops: RepairOperation[], repaired: Record<string, Mapping>, candidates: Record<string, Contract>, base: Record<string, Mapping>): { passed: boolean; required: GateItem[] } {
  const required: GateItem[] = [];
  const add = (assertion: string, present: boolean, detail: string, kind: GateItem["kind"] = "missing") => required.push({ assertion, present, detail, ...(present ? {} : { kind }) });
  for (const op of ops) {
    const c = candidates[op.source];
    if (!c) {
      add(`${op.source}: candidate contract`, false, `no proposed contract for ${op.source}`);
      continue;
    }
    if (op.op === "rename_field") {
      const declared = c.assertions?.renames?.[op.to] === op.from;
      add(`${op.source}: rename ${op.from} -> ${op.to} declared`, declared, declared ? "producer lists the rename in contract assertions" : "the proposal does not state that the new field replaces the old one");
    }
    if (op.op === "update_keys") {
      const same = c.keys.join("|") === op.keys.join("|");
      add(`${op.source}: key (${op.keys.join(", ")}) declared`, same, same ? "matches the keys in the proposed contract" : `proposed contract declares (${c.keys.join(", ")})`);
    }
    if (op.op === "set_refund_convention") {
      const same = c.semantics.refund_convention === op.convention;
      add(`payments: refund convention ${op.convention} declared`, same, same ? "declared in contract semantics" : `contract declares ${c.semantics.refund_convention ?? "nothing"}`);
    }
  }
  // Whatever operation produced it: a canonical field that now reads a different source field, because the
  // old one is gone, relies on the producer saying the new field replaces the old one.
  for (const [src, c] of Object.entries(candidates)) {
    for (const [target, f] of Object.entries(repaired[src]?.fields ?? {})) {
      const before = base[src]?.fields[target]?.from;
      if (!before || !f.from || before === f.from || c.fields.some((x) => x.name === before)) continue;
      const assertion = `${src}: rename ${before} -> ${f.from} declared`;
      if (required.some((r) => r.assertion === assertion)) continue;
      const declared = c.assertions?.renames?.[f.from] === before;
      add(assertion, declared, declared ? "producer lists the rename in contract assertions" : `${target} now reads ${f.from} instead of the removed ${before}, but the proposal does not state that one replaces the other`);
    }
  }
  // Every money cast in a touched mapping must agree with a unit the producer declared.
  for (const [src, c] of Object.entries(candidates)) {
    const m = repaired[src];
    if (!m) continue;
    for (const [target, f] of Object.entries(m.fields)) {
      const unit = f.as ? MONEY_CAST_UNIT[f.as] : undefined;
      if (!unit || !f.from) continue;
      const field = c.fields.find((x) => x.name === f.from);
      if (!field) add(`${src}: source field ${f.from} exists`, false, `mapping for ${target} reads ${f.from}, which the proposed contract does not define`);
      else if (field.unit === null) add(`${src}: unit of ${f.from} declared`, false, `the proposed contract gives no unit for ${f.from}; ${unit} is only an inference from samples`);
      else add(`${src}: unit of ${f.from} is ${unit}`, field.unit === unit, field.unit === unit ? `producer declares ${f.from} in ${field.unit}` : `producer declares ${field.unit}, mapping assumes ${unit}`, "contradicted");
    }
    for (const [target, f] of Object.entries(m.fields)) {
      if (f.from && f.as !== "optional_string" && !MONEY_CAST_UNIT[f.as ?? ""] && !c.fields.some((x) => x.name === f.from))
        add(`${src}: source field ${f.from} exists`, false, `mapping for ${target} reads ${f.from}, which the proposed contract does not define`);
    }
  }
  return { passed: required.every((r) => r.present), required };
}
