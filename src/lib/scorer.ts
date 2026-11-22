import type { Outcome, ScoreView } from "./api-types";
import { q, q1 } from "./db";
import type { Expectation } from "./types";

const PUBLISHES: Outcome[] = ["repair_and_publish", "pass_and_publish", "warn_and_recover", "ignore_event", "withdrawn_no_change"];

interface Observed {
  outcome: Outcome;
  published: boolean;
  signals: { watcher_category: string; dashboards: string[]; incident_id: string | null; outcome: Outcome | null }[];
}

/**
 * Deterministic scorer. It is the ONLY reader of scenario_expectations. It compares what the run
 * actually did with the saved answer key: cause, impacted dashboards, replay evidence and publish outcome.
 */
export async function scoreRun(runId: string, observed: Observed): Promise<ScoreView | null> {
  const row = await q1<{ expected: Expectation }>("SELECT e.expected FROM runs r JOIN scenario_expectations e ON e.plan_id = r.plan_id WHERE r.id=$1", [runId]);
  if (!row) return null;
  const expected = row.expected;
  const incidents = await q<{ id: string; finding: any; repair: any }>("SELECT id, finding, repair FROM incidents WHERE run_id=$1 ORDER BY opened_at, id", [runId]);
  // The signal that determined the outcome is the one whose diagnosis is scored.
  const primary = observed.signals.find((s) => s.outcome === observed.outcome) ?? observed.signals[0] ?? null;
  const incident = primary?.incident_id ? incidents.find((i) => i.id === primary.incident_id) : null;
  const finding = incident?.finding ?? null;
  const fromAgent = Boolean(finding?.valid && finding.source === "agent");
  const predictedCause: string = finding ? finding.cause_category : primary?.watcher_category ?? "none";
  const dashboards = [...new Set(observed.signals.flatMap((s) => {
    const f = incidents.find((i) => i.id === s.incident_id)?.finding;
    return f?.valid && f.source === "agent" ? (f.impacted_assets as string[]).filter((a) => a.startsWith("dash.")) : s.dashboards;
  }))].sort();
  const replayPassed = incidents.some((i) => i.repair?.replay?.passed === true && i.repair?.status === "verified");

  const items: ScoreView["items"] = [
    { field: "Outcome", expected: expected.outcome, actual: observed.outcome, match: expected.outcome === observed.outcome },
    { field: "Cause", expected: expected.cause_category, actual: predictedCause, match: expected.cause_category === predictedCause, note: finding ? (fromAgent ? "from the investigator's finding" : "investigator unavailable; fallback recorded as unknown") : "from the watcher's deterministic classification" },
    { field: "Impacted dashboards", expected: expected.impacted_dashboards.join(", ") || "none", actual: dashboards.join(", ") || "none", match: expected.impacted_dashboards.join() === dashboards.join() },
    { field: "Published a new snapshot", expected: PUBLISHES.includes(expected.outcome) ? "yes" : "no", actual: observed.published ? "yes" : "no", match: PUBLISHES.includes(expected.outcome) === observed.published },
  ];
  if (expected.outcome === "repair_and_publish") items.push({ field: "Repair verified by replay", expected: "yes", actual: replayPassed ? "yes" : "no", match: replayPassed });
  const verified = fromAgent && finding.cause_status !== "unknown" && (finding.evidence_ids as string[]).length > 0;
  if (finding) items.push({ field: "Diagnosis cites evidence", expected: expected.cause_category === "unknown" ? "n/a" : "yes", actual: verified ? "yes" : "no", match: expected.cause_category === "unknown" ? true : verified, note: "A diagnosis only counts as verified when it cites evidence available to the run." });
  const score: ScoreView = { matched: items.filter((i) => i.match).length, total: items.length, items, verified_diagnosis: verified };
  await q("INSERT INTO scores (run_id, body) VALUES ($1,$2) ON CONFLICT (run_id) DO UPDATE SET body=EXCLUDED.body", [runId, JSON.stringify(score)]);
  return score;
}
