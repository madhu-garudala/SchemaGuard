import type { CheckResult } from "./api-types";
import { diffCentMaps, sameCents } from "./money";
import type { PipelineResult } from "./types";

export interface ReplayResult {
  passed: boolean;
  first_failed_check: string | null;
  checks: CheckResult[];
}

const flat = (d: Record<string, Record<string, string>>) => Object.fromEntries(Object.entries(d).flatMap(([dash, m]) => Object.entries(m).map(([k, v]) => [`${dash}.${k}`, v])));

/**
 * Reconcile a baseline replay against a candidate replay of the SAME logical records.
 * Order matters: per-record checks come before aggregates, because equal totals can hide wrong rows.
 */
export function reconcile(baseline: PipelineResult, candidate: PipelineResult, extra: { control?: PipelineResult | null; controlLabel?: string; repoTests?: { passed: boolean; total: number; failed: number } | null } = {}): ReplayResult {
  const checks: CheckResult[] = [];
  const add = (id: string, label: string, passed: boolean, detail: string, sample?: Record<string, unknown>[]) => checks.push({ id, label, passed, detail, ...(sample?.length ? { sample } : {}) });

  if (!baseline.ok) add("baseline_runs", "Baseline pipeline runs", false, `baseline failed at ${baseline.error.step}: ${baseline.error.message}`);
  if (!candidate.ok) add("candidate_runs", "Candidate pipeline runs", false, `candidate failed at ${candidate.error.step}: ${candidate.error.message}`);
  if (baseline.ok && candidate.ok) {
    const b = baseline.output;
    const c = candidate.output;
    add("candidate_runs", "Candidate pipeline runs", true, "all transformations completed");

    const rejected = Object.entries(c.staging).flatMap(([s, v]) => v.rejected.map((r) => ({ source: s, row: r.index, reason: r.reason })));
    add("rejected_rows", "No candidate rows rejected", rejected.length === 0, rejected.length ? `${rejected.length} candidate row(s) could not be normalized` : "0 rejected rows", rejected.slice(0, 4));

    const counts = (o: typeof b) => ({ orders: o.staging.orders.rows, payments: o.payment_facts.length, order_facts: o.order_facts.length });
    const bc = counts(b);
    const cc = counts(c);
    add("row_counts", "Row counts match", JSON.stringify(bc) === JSON.stringify(cc), `baseline ${JSON.stringify(bc)} vs candidate ${JSON.stringify(cc)}`);

    const dups = Object.entries(c.staging).flatMap(([s, v]) => v.duplicates.map((k) => ({ source: s, key: k })));
    add("duplicate_ids", "No duplicate IDs", dups.length === 0, dups.length ? `${dups.length} duplicate key(s) dropped in staging` : "no duplicate keys", dups.slice(0, 4));

    const cand = new Map(c.payment_facts.map((p) => [p.payment_id, p]));
    const wrong: Record<string, unknown>[] = [];
    for (const p of b.payment_facts) {
      const o = cand.get(p.payment_id);
      if (!o) wrong.push({ payment_id: p.payment_id, baseline_cents: p.amount_cents, candidate_cents: "(missing)" });
      else if (!sameCents(p.amount_cents, o.amount_cents) || p.currency !== o.currency || p.order_id !== o.order_id || p.kind !== o.kind)
        wrong.push({ payment_id: p.payment_id, baseline_cents: p.amount_cents, candidate_cents: o.amount_cents, baseline_currency: p.currency, candidate_currency: o.currency });
    }
    add("per_payment_rows", "Per-payment canonical rows match", wrong.length === 0, wrong.length ? `${wrong.length} of ${b.payment_facts.length} payments normalize differently` : `${b.payment_facts.length} payments normalize to identical cents, currency, order and kind`, wrong.slice(0, 4));

    const candOrders = new Map(c.order_facts.map((o) => [o.order_id, o]));
    const wrongOrders = b.order_facts
      .filter((o) => {
        const x = candOrders.get(o.order_id);
        return !x || !sameCents(o.order_total_cents, x.order_total_cents) || !sameCents(o.paid_cents, x.paid_cents) || o.shipped !== x.shipped || o.delivered !== x.delivered;
      })
      .map((o) => ({ order_id: o.order_id, baseline_paid_cents: o.paid_cents, candidate_paid_cents: candOrders.get(o.order_id)?.paid_cents ?? "(missing)" }));
    add("per_order_rows", "Per-order facts match", wrongOrders.length === 0, wrongOrders.length ? `${wrongOrders.length} order fact(s) differ` : `${b.order_facts.length} order facts identical`, wrongOrders.slice(0, 4));

    const fk = [...c.foreign_keys.payments_without_order, ...c.foreign_keys.shipments_without_order];
    add("foreign_keys", "Required foreign keys resolve", fk.length === 0, fk.length ? `${fk.length} row(s) reference a missing order: ${fk.slice(0, 4).join(", ")}` : "every payment and shipment references an order");

    const grainOk = c.grain.order_facts === c.grain.orders && diffCentMaps(c.grain.paid_by_order_facts, c.grain.paid_by_payment_facts).length === 0;
    add("join_grain", "Joins preserve grain and totals", grainOk, grainOk ? `${c.grain.order_facts} order facts for ${c.grain.orders} orders; paid total identical before and after the join` : `order facts ${c.grain.order_facts} vs orders ${c.grain.orders}; join totals ${JSON.stringify(c.grain.paid_by_order_facts)} vs ${JSON.stringify(c.grain.paid_by_payment_facts)}`);

    const cur = (o: typeof b) => Object.fromEntries(Object.entries(o.dashboards.finance).filter(([k]) => k.startsWith("net_revenue_cents.")));
    const curDiff = diffCentMaps(cur(b), cur(c));
    add("currency_totals", "Per-currency totals match", curDiff.length === 0, curDiff.length ? curDiff.map((k) => `${k}: ${cur(b)[k] ?? "-"} -> ${cur(c)[k] ?? "-"}`).join("; ") : Object.entries(cur(c)).map(([k, v]) => `${k} = ${v}`).join("; "));

    const dashDiff = diffCentMaps(flat(b.dashboards), flat(c.dashboards));
    add("dashboard_totals", "Dashboard totals match", dashDiff.length === 0, dashDiff.length ? `${dashDiff.length} metric(s) differ: ${dashDiff.slice(0, 4).map((k) => `${k} ${flat(b.dashboards)[k] ?? "-"} -> ${flat(c.dashboards)[k] ?? "-"}`).join("; ")}` : `${Object.keys(flat(c.dashboards)).length} Finance, Revenue and Operations metrics identical`);

    if (extra.control !== undefined && extra.control !== null) {
      // Negative control: a mapping that keeps the old conversion must be caught by the per-record check.
      const ctl = extra.control;
      let caught = !ctl.ok;
      let sample: Record<string, unknown>[] = [];
      if (ctl.ok) {
        const m = new Map(ctl.output.payment_facts.map((p) => [p.payment_id, p.amount_cents]));
        sample = b.payment_facts.filter((p) => m.get(p.payment_id) !== undefined && !sameCents(p.amount_cents, m.get(p.payment_id)!)).slice(0, 3).map((p) => ({ payment_id: p.payment_id, correct_cents: p.amount_cents, control_cents: m.get(p.payment_id) }));
        caught = sample.length > 0 || ctl.output.payment_facts.length !== b.payment_facts.length;
      }
      add("negative_control", "Negative control is caught", caught, caught ? `${extra.controlLabel ?? "control mapping"} is detected by the per-record comparison` : `${extra.controlLabel ?? "control mapping"} was NOT detected; the comparison is too weak to trust`, sample);
    }
  }
  if (extra.repoTests) add("repo_tests", "Pipeline repository tests pass", extra.repoTests.passed, `${extra.repoTests.total - extra.repoTests.failed}/${extra.repoTests.total} tests pass in the repair worktree`);
  const failed = checks.find((c) => !c.passed);
  return { passed: !failed, first_failed_check: failed?.id ?? null, checks };
}

/** Checks a single pipeline run must satisfy on its own before a snapshot may be published. */
export function validateRun(result: PipelineResult): ReplayResult {
  const checks: CheckResult[] = [];
  const add = (id: string, label: string, passed: boolean, detail: string) => checks.push({ id, label, passed, detail });
  if (!result.ok) add("transformation", "Transformations complete", false, `failed at ${result.error.step}: ${result.error.message}`);
  else {
    const o = result.output;
    add("transformation", "Transformations complete", true, "staging, facts and dashboards built");
    const rej = Object.values(o.staging).reduce((n, v) => n + v.rejected.length, 0);
    add("rejected_rows", "No rows rejected", rej === 0, `${rej} rejected`);
    const dup = Object.values(o.staging).reduce((n, v) => n + v.duplicates.length, 0);
    add("duplicate_ids", "No duplicate IDs", dup === 0, `${dup} duplicates`);
    const fk = o.foreign_keys.payments_without_order.length + o.foreign_keys.shipments_without_order.length;
    add("foreign_keys", "Required foreign keys resolve", fk === 0, `${fk} orphan rows`);
    const grainOk = o.grain.order_facts === o.grain.orders && diffCentMaps(o.grain.paid_by_order_facts, o.grain.paid_by_payment_facts).length === 0;
    add("join_grain", "Joins preserve grain and totals", grainOk, `${o.grain.order_facts} order facts for ${o.grain.orders} orders`);
  }
  const failed = checks.find((c) => !c.passed);
  return { passed: !failed, first_failed_check: failed?.id ?? null, checks };
}
