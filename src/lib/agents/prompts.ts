/**
 * Prompt text for live turns. Role rules live in the checked-in OpenClaw workspace templates
 * (openclaw/workspaces/<agent>/AGENTS.md); each turn's message carries the task packet and the
 * exact output shape. Nothing here ever includes credentials or the scenario answer key.
 */

const json = (v: unknown) => JSON.stringify(v, null, 1);

const FINDING_SHAPE = `{
 "observed_facts": [{"statement": "<one fact you can point to>", "evidence_ids": ["<id>"]}],
 "cause_status": "confirmed" | "likely" | "unknown",
 "cause_category": "<one key from cause_categories>",
 "candidate_cause": "<one or two sentences>",
 "evidence_ids": ["<every id you relied on>"],
 "impacted_assets": ["<lineage node ids that would be wrong or stale>"],
 "owner": "<team id that owns the source of the problem>",
 "severity": "low" | "medium" | "high" | "critical",
 "next_verification_step": "<what to check next, or null>"
}`;

export function investigatorPrompt(packet: Record<string, unknown>, correction?: string[]): string {
  return [
    "Investigate the trigger below using ONLY the evidence in this packet.",
    "Rules: cite evidence by its exact id; never invent an id; use cause_status \"confirmed\" only when the evidence states the cause outright, \"likely\" when it is the best supported inference, \"unknown\" otherwise. impacted_assets must be ids from lineage_nodes. owner must be one of owners.",
    "Reply with one JSON object and nothing else, in exactly this shape:",
    FINDING_SHAPE,
    correction?.length ? `Your previous reply was rejected: ${correction.join("; ")}. Fix that and reply again.` : "",
    "PACKET:",
    json(packet),
  ].filter(Boolean).join("\n\n");
}

const REPAIR_SHAPE = `{
 "decision": "propose" | "need_contract_fact" | "no_safe_repair",
 "operations": [ {"op": "...", ...} ],
 "assumptions": ["<anything you assumed>"],
 "expected_invariants": ["<what must stay equal when the same records are replayed>"],
 "missing_facts": ["<contract facts the owning team must confirm>"],
 "question_for_owner": "<one question, or null>"
}`;

export function repairPrompt(packet: Record<string, unknown>, correction?: string[]): string {
  return [
    "Propose a downstream mapping repair for the approved finding below.",
    "Rules: use only operations from allowed_operations with exactly the listed fields. A unit, key, rename or sign convention may be relied on ONLY if the proposed contract declares it; sample values that merely look like cents are not a declaration. If a needed fact is undeclared, choose \"need_contract_fact\", list the facts and leave operations empty. If no mapping change can make downstream correct (for example a required key or the currency is gone), choose \"no_safe_repair\" and leave operations empty. Do not write code or SQL.",
    "Reply with one JSON object and nothing else, in exactly this shape:",
    REPAIR_SHAPE,
    correction?.length ? `Your previous reply was rejected: ${correction.join("; ")}. Fix that and reply again.` : "",
    "PACKET:",
    json(packet),
  ].filter(Boolean).join("\n\n");
}

const PLAN_SHAPE = `{
 "scenario_id": "<lowercase-kebab id, 3-48 chars>",
 "team": "<your team>",
 "seed": <the seed you were given>,
 "starting_snapshot": "baseline_usd" | "baseline_multicurrency",
 "events": [ {"offset_min": <minutes after cycle start>, "type": "<supported event type>", "source": "<your team>", "payload": { ... }} ],
 "fixture_mutation": {"type": "<one allowed mutation>", ...its parameters },
 "expected_outcome": {"outcome": "<one of outcomes>", "cause_category": "<key from cause_categories, or \\"none\\">", "impacted_dashboards": ["dash.finance" | "dash.revenue" | "dash.operations"]}
}`;

export function authorPrompt(packet: Record<string, unknown>, correction?: string[]): string {
  return [
    "Author ONE replayable incident scenario for your team's feed. Use the seed to vary your choice so different seeds give different scenarios, and avoid repeating anything in already_covered.",
    "Rules: pick exactly one mutation from allowed_mutations and give exactly its parameters. Script only supported_events, only for your own feed. Follow timing_rules. expected_outcome must be what response_policy says this pipeline will do, and impacted_dashboards must follow impact_rules. Event payloads carry observable facts only: never put the cause or the expected outcome into an id, name or payload.",
    "Reply with one JSON object and nothing else, in exactly this shape:",
    PLAN_SHAPE,
    correction?.length ? `Your previous plan was rejected: ${correction.join("; ")}. Fix that and reply again.` : "",
    "PACKET:",
    json(packet),
  ].filter(Boolean).join("\n\n");
}

export const RESPONSE_POLICY = [
  "A proposal that only adds nullable fields is safe: outcome pass_and_publish, cause_category additive_change, no impacted dashboards.",
  "A proposal whose rename, unit, key or sign convention is fully declared by the producer gets an automatic mapping repair that is verified by replay: outcome repair_and_publish.",
  "A proposal that changes a money field without declaring the unit or the rename is never auto-repaired, even if samples look consistent: outcome block_pending_clarification, cause_category ambiguous_contract.",
  "A proposal that removes a key or the currency, or makes a field required while rows are null, has no safe mapping repair: outcome hold_previous_snapshot.",
  "A cycle batch that fails staging validation (wrong types, duplicate keys, missing rows, volume outside range) or breaks a transformation is quarantined: outcome hold_previous_snapshot.",
  "A re-delivered or stale batch is ignored: outcome ignore_event, cause_category none, no impacted dashboards.",
  "An export that starts after its warning time but lands by the hard deadline: outcome warn_and_recover, cause_category late_delivery. If nothing lands by the hard deadline: outcome delayed_previous_snapshot, cause_category missed_deadline.",
  "A proposal withdrawn before its effective time: outcome withdrawn_no_change, keeping the cause_category and dashboards of the proposal itself.",
];
