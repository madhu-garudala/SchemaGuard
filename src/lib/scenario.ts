import { z } from "zod";
import { baselineContract, REFRESH_MIN } from "./fixtures";
import { Mutation, MUTATION_SPECS, mutationSource, ruleExpectation, type RuleExpectation } from "./mutations";
import { CAUSE_CATEGORIES, OUTCOMES, SOURCES, type Expectation, type SourceId } from "./types";

/** Event types a scenario plan may script. pipeline.* and snapshot.* are emitted by the system itself. */
export const PLAN_EVENT_PAYLOADS = {
  "source.change.proposed": z.strictObject({ effective_in_min: z.number().int().min(10).max(170) }),
  "source.change.withdrawn": z.strictObject({ reason: z.string().max(200).optional() }),
  "source.export.started": z.strictObject({}),
  "source.export.progress": z.strictObject({ percent: z.number().int().min(1).max(99) }),
  "source.batch.arrived": z.strictObject({ batch: z.enum(["cycle", "redelivery", "stale"]).optional() }),
} as const;
export type PlanEventType = keyof typeof PLAN_EVENT_PAYLOADS;
export const SYSTEM_EVENT_TYPES = ["pipeline.check.failed", "pipeline.validation.completed", "snapshot.published", "source.delivery.at_risk"] as const;

const PlanEvent = z.strictObject({
  offset_min: z.number().int().min(0).max(300),
  type: z.string(),
  source: z.enum(["orders", "payments", "shipping"]).optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export const ScenarioPlan = z.strictObject({
  scenario_id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,48}$/),
  team: z.enum(["orders", "payments", "shipping"]),
  seed: z.number().int().min(0).max(2_147_483_647),
  starting_snapshot: z.enum(["baseline_usd", "baseline_multicurrency"]),
  events: z.array(PlanEvent).max(12),
  fixture_mutation: z.union([Mutation, z.array(Mutation).min(1).max(2)]),
  faults: z.array(z.enum(["agent_unavailable"])).max(1).optional(),
  expected_outcome: z.strictObject({
    outcome: z.enum(OUTCOMES as [string, ...string[]]),
    cause_category: z.enum(["none", ...Object.keys(CAUSE_CATEGORIES)] as [string, ...string[]]),
    impacted_dashboards: z.array(z.enum(["dash.finance", "dash.revenue", "dash.operations"])).max(3),
  }),
});
export type ScenarioPlan = z.infer<typeof ScenarioPlan>;
export type PlanSansExpectation = Omit<ScenarioPlan, "expected_outcome">;

export interface NormalizedEvent {
  offset_min: number;
  type: PlanEventType;
  source: SourceId;
  payload: Record<string, unknown>;
}

export const mutationsOf = (plan: Pick<ScenarioPlan, "fixture_mutation">): Mutation[] => (Array.isArray(plan.fixture_mutation) ? plan.fixture_mutation : [plan.fixture_mutation]);

/** Default export choreography for a normal cycle, in minutes after the cycle start. */
export const DEFAULT_TIMING: Record<SourceId, { started: number; progress: number; arrived: number }> = {
  orders: { started: 10, progress: 35, arrived: 60 },
  payments: { started: 15, progress: 40, arrived: 70 },
  shipping: { started: 25, progress: 55, arrived: 85 },
};

function timingFor(m: Mutation, events: NormalizedEvent[]) {
  const src = mutationSource(m);
  const c = baselineContract(src);
  const mine = events.filter((e) => e.source === src);
  const started = mine.find((e) => e.type === "source.export.started");
  const arrived = mine.find((e) => e.type === "source.batch.arrived" && (e.payload.batch ?? "cycle") === "cycle");
  const delay = m.type === "delay_export";
  return {
    late: delay ? !started || started.offset_min > c.delivery.expected_start_min + c.delivery.grace_min : false,
    arrivesBeforeCutoff: delay ? Boolean(arrived && arrived.offset_min <= c.delivery.hard_deadline_min) : true,
    withdrawn: mine.some((e) => e.type === "source.change.withdrawn"),
  };
}

export const OUTCOME_RANK = ["hold_previous_snapshot", "delayed_previous_snapshot", "block_pending_clarification", "repair_and_publish", "warn_and_recover", "withdrawn_no_change", "ignore_event", "pass_and_publish"];

/** The application's own expectation for a plan, derived only from declared mutations, events and faults. */
export function ruleExpectationForPlan(plan: PlanSansExpectation, events: NormalizedEvent[]): RuleExpectation {
  const each = mutationsOf(plan).map((m) => ({ m, e: ruleExpectation(m, timingFor(m, events)) }));
  const primary = [...each].sort((a, b) => OUTCOME_RANK.indexOf(a.e.outcome) - OUTCOME_RANK.indexOf(b.e.outcome))[0];
  const dashboards = [...new Set(each.flatMap((x) => x.e.impacted_dashboards))].sort();
  const outage = plan.faults?.includes("agent_unavailable");
  const needsAgent = each.some((x) => MUTATION_SPECS[x.m.type].mode === "proposal" && x.e.cause_category !== "additive_change" && !timingFor(x.m, events).withdrawn);
  if (outage && needsAgent) return { outcome: "hold_previous_snapshot", cause_category: "unknown", impacted_dashboards: dashboards };
  return { outcome: primary.e.outcome, cause_category: primary.e.cause_category, impacted_dashboards: dashboards };
}

export type PlanValidation =
  | { ok: true; plan: PlanSansExpectation; events: NormalizedEvent[]; expectation: Expectation }
  | { ok: false; reasons: string[] };

/**
 * Validate a scenario plan (from the catalog or from an author agent). Nothing is enqueued unless this passes.
 * `origin: "agent"` additionally restricts authors to their own team's feed and mutation list.
 */
export function validatePlan(raw: unknown, origin: "catalog" | "agent", expectedTeam?: SourceId): PlanValidation {
  const parsed = ScenarioPlan.safeParse(raw);
  if (!parsed.success) return { ok: false, reasons: parsed.error.issues.slice(0, 6).map((i) => `${i.path.join(".") || "plan"}: ${i.message}`) };
  const { expected_outcome, ...plan } = parsed.data;
  const reasons: string[] = [];
  if (expectedTeam && plan.team !== expectedTeam) reasons.push(`team must be "${expectedTeam}", got "${plan.team}"`);
  const mutations = mutationsOf(plan);
  if (origin === "agent" && mutations.length > 1) reasons.push("author plans carry exactly one fixture_mutation");
  for (const m of mutations) {
    const src = mutationSource(m);
    if (origin === "agent" && src !== plan.team) reasons.push(`mutation ${m.type} targets ${src}; the ${plan.team} author may only change the ${plan.team} feed`);
    if (!MUTATION_SPECS[m.type].teams.includes(src)) reasons.push(`mutation ${m.type} is not declared for ${src}`);
    if (m.type === "add_nullable_field" && baselineContract(m.source).fields.some((f) => f.name === m.name)) reasons.push(`field ${m.name} already exists on ${m.source}`);
    if (m.type === "rename_amount_to_minor_units" && baselineContract("payments").fields.some((f) => f.name === m.new_name)) reasons.push(`field ${m.new_name} already exists on payments`);
    if (m.type === "drop_currency_field" && plan.starting_snapshot !== "baseline_multicurrency") reasons.push("drop_currency_field requires starting_snapshot baseline_multicurrency");
  }
  if (new Set(mutations.map(mutationSource)).size !== mutations.length) reasons.push("two mutations may not target the same feed");

  const events: NormalizedEvent[] = [];
  for (const [i, e] of plan.events.entries()) {
    const schema = PLAN_EVENT_PAYLOADS[e.type as PlanEventType];
    if (!schema) {
      reasons.push(`events[${i}]: type "${e.type}" cannot be scripted (supported: ${Object.keys(PLAN_EVENT_PAYLOADS).join(", ")})`);
      continue;
    }
    const p = schema.safeParse(e.payload);
    if (!p.success) {
      reasons.push(`events[${i}] ${e.type}: ${p.error.issues[0].path.join(".") || "payload"} ${p.error.issues[0].message}`);
      continue;
    }
    const src = e.source ?? plan.team;
    if (origin === "agent" && src !== plan.team) reasons.push(`events[${i}]: source ${src} is outside the ${plan.team} author's scope`);
    events.push({ offset_min: e.offset_min, type: e.type as PlanEventType, source: src, payload: p.data as Record<string, unknown> });
  }
  events.sort((a, b) => a.offset_min - b.offset_min);

  for (const src of SOURCES) {
    const mine = events.filter((e) => e.source === src);
    const m = mutations.find((x) => mutationSource(x) === src);
    const proposals = mine.filter((e) => e.type === "source.change.proposed");
    const withdrawn = mine.filter((e) => e.type === "source.change.withdrawn");
    const mode = m ? MUTATION_SPECS[m.type].mode : null;
    if (mode === "proposal") {
      if (proposals.length !== 1) reasons.push(`${src}: a ${m!.type} plan needs exactly one source.change.proposed event (found ${proposals.length})`);
      else {
        const effective = proposals[0].offset_min + (proposals[0].payload.effective_in_min as number);
        if (effective > 150) reasons.push(`${src}: the change must take effect by minute 150 (proposed ${proposals[0].offset_min} + ${proposals[0].payload.effective_in_min})`);
        if (withdrawn.length > 1) reasons.push(`${src}: at most one withdrawal`);
        if (withdrawn[0] && (withdrawn[0].offset_min <= proposals[0].offset_min || withdrawn[0].offset_min >= effective)) reasons.push(`${src}: a withdrawal must fall after the proposal and before its effective time`);
        const arrival = mine.find((e) => e.type === "source.batch.arrived");
        if (arrival && !withdrawn[0] && arrival.offset_min <= effective) reasons.push(`${src}: the cycle batch must arrive after the change takes effect (minute ${effective})`);
      }
    } else if (proposals.length || withdrawn.length) reasons.push(`${src}: change events need a proposal-type fixture_mutation for that feed`);
    const order = ["source.export.started", "source.export.progress", "source.batch.arrived"];
    const exportEvents = mine.filter((e) => order.includes(e.type) && (e.payload.batch ?? "cycle") === "cycle");
    for (let i = 1; i < exportEvents.length; i++)
      if (order.indexOf(exportEvents[i].type) < order.indexOf(exportEvents[i - 1].type)) reasons.push(`${src}: export events are out of order (${exportEvents[i - 1].type} before ${exportEvents[i].type})`);
    if (mode === "delivery") {
      const started = mine.find((e) => e.type === "source.export.started");
      const c = baselineContract(src);
      if (started && started.offset_min <= c.delivery.expected_start_min + c.delivery.grace_min) reasons.push(`${src}: delay_export needs the export to start after minute ${c.delivery.expected_start_min + c.delivery.grace_min}, or not at all`);
      // A batch that lands before the warning time is not a delay: no warning would ever be raised.
      const arrived = exportEvents.find((e) => e.type === "source.batch.arrived");
      if (arrived && arrived.offset_min <= c.delivery.expected_start_min + c.delivery.grace_min) reasons.push(`${src}: delay_export needs the cycle batch to arrive after minute ${c.delivery.expected_start_min + c.delivery.grace_min}, or not at all`);
    }
    // The runner schedules one of each cycle event; a second one would be dropped silently.
    for (const t of order) if (exportEvents.filter((e) => e.type === t).length > 1) reasons.push(`${src}: more than one ${t} event for the cycle batch`);
    if (mode !== "delivery") {
      // Only delay_export may script a late or missing delivery; otherwise the expected outcome would ignore it.
      const d = baselineContract(src).delivery;
      const started = exportEvents.find((e) => e.type === "source.export.started");
      const arrived = exportEvents.find((e) => e.type === "source.batch.arrived");
      if (started && started.offset_min > d.expected_start_min + d.grace_min) reasons.push(`${src}: the export may not start after minute ${d.expected_start_min + d.grace_min} unless the mutation is delay_export`);
      if (arrived && arrived.offset_min > d.hard_deadline_min) reasons.push(`${src}: the cycle batch may not arrive after the hard deadline (minute ${d.hard_deadline_min}) unless the mutation is delay_export`);
    }
    const extras = mine.filter((e) => e.type === "source.batch.arrived" && e.payload.batch && e.payload.batch !== "cycle");
    if (extras.length && mode !== "extra_batch") reasons.push(`${src}: redelivery/stale batch events need a redeliver_batch or stale_batch mutation`);
    if (mode === "extra_batch") {
      const want = m!.type === "redeliver_batch" ? "redelivery" : "stale";
      const cycleAt = exportEvents.find((e) => e.type === "source.batch.arrived")?.offset_min ?? DEFAULT_TIMING[src].arrived;
      if (extras.length > 1) reasons.push(`${src}: at most one extra batch event`);
      for (const x of extras) {
        if (x.payload.batch !== want) reasons.push(`${src}: a ${m!.type} plan needs payload.batch "${want}" (found "${String(x.payload.batch)}")`);
        if (x.offset_min <= cycleAt) reasons.push(`${src}: the extra batch must arrive after the cycle batch (minute ${cycleAt})`);
      }
    }
  }
  if (reasons.length) return { ok: false, reasons };

  const rule = ruleExpectationForPlan(plan, events);
  const claimed = { ...expected_outcome, impacted_dashboards: [...expected_outcome.impacted_dashboards].sort() } as Expectation;
  if (claimed.outcome !== rule.outcome) return { ok: false, reasons: [`expected_outcome.outcome "${claimed.outcome}" contradicts the declared mutation and timing, which lead to "${rule.outcome}"`] };
  if (claimed.cause_category !== rule.cause_category) return { ok: false, reasons: [`expected_outcome.cause_category "${claimed.cause_category}" contradicts the declared mutation, which is "${rule.cause_category}"`] };
  if (claimed.impacted_dashboards.join() !== rule.impacted_dashboards.join()) return { ok: false, reasons: [`expected_outcome.impacted_dashboards [${claimed.impacted_dashboards.join(", ")}] does not match lineage for this mutation: [${rule.impacted_dashboards.join(", ")}]`] };
  return { ok: true, plan, events, expectation: claimed };
}

/** Typed events of an already-validated stored plan. */
export function normalizeEvents(plan: PlanSansExpectation): NormalizedEvent[] {
  return plan.events
    .map((e) => ({ offset_min: e.offset_min, type: e.type as PlanEventType, source: (e.source ?? plan.team) as SourceId, payload: e.payload as Record<string, unknown> }))
    .sort((a, b) => a.offset_min - b.offset_min);
}

export function describeMutations(plan: Pick<ScenarioPlan, "fixture_mutation">): string {
  return mutationsOf(plan)
    .map((m) => {
      const { type, ...params } = m;
      const p = Object.entries(params).map(([k, v]) => `${k}=${v}`).join(", ");
      return p ? `${type} (${p})` : type;
    })
    .join(" + ");
}

export { REFRESH_MIN };
