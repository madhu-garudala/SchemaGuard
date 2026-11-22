import { z } from "zod";
import { lineage } from "../fixtures";
import { RepairOperation } from "../repair-ops";
import { CAUSE_CATEGORIES } from "../types";

export const Finding = z.object({
  observed_facts: z.array(z.object({ statement: z.string().min(3).max(500), evidence_ids: z.array(z.string()).min(1).max(12) })).min(1).max(8),
  cause_status: z.enum(["confirmed", "likely", "unknown"]),
  cause_category: z.enum(Object.keys(CAUSE_CATEGORIES) as [string, ...string[]]),
  candidate_cause: z.string().min(3).max(800),
  evidence_ids: z.array(z.string()).min(1).max(20),
  impacted_assets: z.array(z.string()).max(12),
  owner: z.string().min(2).max(40),
  severity: z.enum(["low", "medium", "high", "critical"]),
  next_verification_step: z.string().max(400).nullable().optional(),
});
export type Finding = z.infer<typeof Finding>;

export const RepairProposal = z.object({
  decision: z.enum(["propose", "need_contract_fact", "no_safe_repair"]),
  operations: z.array(z.unknown()).max(6).default([]),
  assumptions: z.array(z.string().max(400)).max(8).default([]),
  expected_invariants: z.array(z.string().max(400)).max(8).default([]),
  missing_facts: z.array(z.string().max(400)).max(8).default([]),
  question_for_owner: z.string().max(600).nullable().optional(),
});
export type RepairProposal = Omit<z.infer<typeof RepairProposal>, "operations"> & { operations: RepairOperation[] };

export type Parsed<T> = { ok: true; value: T } | { ok: false; category: "malformed_output" | "invalid_evidence"; errors: string[] };

/** Pull the single JSON object out of a model reply (tolerates code fences and surrounding prose). */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("reply contains no JSON object");
  return JSON.parse(cleaned.slice(start, end + 1));
}

const issues = (e: z.ZodError) => e.issues.slice(0, 6).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);

/** Parse and validate an investigator reply against the evidence that was actually available to this run. */
export function parseFinding(text: string, availableEvidence: string[], owners: string[]): Parsed<Finding> {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (err) {
    return { ok: false, category: "malformed_output", errors: [(err as Error).message] };
  }
  const p = Finding.safeParse(raw);
  if (!p.success) return { ok: false, category: "malformed_output", errors: issues(p.error) };
  const f = p.data;
  const known = new Set(availableEvidence);
  const cited = [...new Set([...f.evidence_ids, ...f.observed_facts.flatMap((o) => o.evidence_ids)])];
  const foreign = cited.filter((id) => !known.has(id));
  if (foreign.length) return { ok: false, category: "invalid_evidence", errors: [`evidence IDs not available to this run: ${foreign.join(", ")}. Available: ${availableEvidence.join(", ")}`] };
  const nodes = new Set(lineage().nodes.map((n) => n.id));
  const badAssets = f.impacted_assets.filter((a) => !nodes.has(a));
  if (badAssets.length) return { ok: false, category: "malformed_output", errors: [`impacted_assets contains unknown lineage ids: ${badAssets.join(", ")}`] };
  if (!owners.includes(f.owner)) return { ok: false, category: "malformed_output", errors: [`owner must be one of: ${owners.join(", ")}`] };
  return { ok: true, value: f };
}

export function parseRepair(text: string): Parsed<RepairProposal> {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (err) {
    return { ok: false, category: "malformed_output", errors: [(err as Error).message] };
  }
  const p = RepairProposal.safeParse(raw);
  if (!p.success) return { ok: false, category: "malformed_output", errors: issues(p.error) };
  const ops: RepairOperation[] = [];
  const errors: string[] = [];
  p.data.operations.forEach((o, i) => {
    const r = RepairOperation.safeParse(o);
    if (r.success) ops.push(r.data);
    else errors.push(`operations[${i}]: ${r.error.issues[0].path.join(".") || "op"} ${r.error.issues[0].message}`);
  });
  if (errors.length) return { ok: false, category: "malformed_output", errors };
  if (p.data.decision === "propose" && ops.length === 0) return { ok: false, category: "malformed_output", errors: ["decision is 'propose' but operations is empty"] };
  if (p.data.decision !== "propose" && ops.length > 0) return { ok: false, category: "malformed_output", errors: [`decision is '${p.data.decision}' but operations were supplied`] };
  return { ok: true, value: { ...p.data, operations: ops } };
}
