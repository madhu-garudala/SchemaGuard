import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CATALOG } from "../src/lib/catalog";
import { closePool, q, q1 } from "../src/lib/db";
import { expectedBaseline } from "../src/lib/fixtures";
import { getOverview, HttpError, startRun } from "../src/lib/queries";
import { claim, complete, enqueue, heartbeat, requeueExpired } from "../src/lib/queue";
import { executeRun } from "../src/lib/runner";
import { createEnvironment, getEnv, publishCandidate, refreshAndPublish } from "../src/lib/snapshot";
import { generateScenarios } from "../src/lib/generate";
import { caseId, insertRun, resetDb, runPlan } from "./helpers";

beforeAll(resetDb);
afterAll(closePool);

describe("baseline", () => {
  it("publishes a verified snapshot that equals the independent expected output", async () => {
    for (const dataset of ["baseline_usd", "baseline_multicurrency"] as const) {
      const env = await createEnvironment(`t_${dataset}`, "t", "sandbox", dataset);
      const snap = await q1("SELECT * FROM snapshots WHERE id=$1", [env.current_snapshot_id]);
      expect(snap.status).toBe("published");
      expect(snap.revision).toBe(1);
      expect(snap.totals.dashboards).toEqual(expectedBaseline(dataset).dashboards);
    }
    expect((await q1("SELECT totals FROM snapshots WHERE env_id='t_baseline_usd'")).totals.finance_net_by_currency).toEqual({ USD: "159227" });
  });
});

describe("main rehearsal", () => {
  it("detects the change before release, repairs it with a real diff, verifies by replay and publishes unchanged totals", async () => {
    const d = await runPlan(caseId(1), { kind: "rehearsal" });
    expect(d.run.outcome).toBe("repair_and_publish");
    expect(d.publish_status).toBe("published");
    const inc = d.incidents[0];
    expect(inc.risk_kind).toBe("future_change");
    expect(inc.affected_dashboards).toEqual(["dash.finance", "dash.revenue"]);
    expect(inc.owner.team).toBe("payments");
    expect(inc.status).toBe("resolved");
    expect(inc.history.map((h) => h.status)).toEqual(expect.arrayContaining(["at_risk", "investigating", "diagnosed", "repair_verified", "resolved"]));
    const r = inc.repair!;
    expect(r.diff).toContain('-      "from": "payment_amount",');
    expect(r.diff).toContain('+      "as": "minor_units"');
    expect(r.gate!.passed).toBe(true);
    expect(r.repo_tests!.passed).toBe(true);
    expect(r.replay!.passed).toBe(true);
    expect(r.replay!.checks.map((c) => c.id)).toEqual(expect.arrayContaining(["per_payment_rows", "row_counts", "duplicate_ids", "rejected_rows", "foreign_keys", "join_grain", "currency_totals", "dashboard_totals", "negative_control", "repo_tests"]));
    // Negative control: keeping the old x100 conversion turns 1234 cents into 123400 and must be caught.
    const control = r.replay!.checks.find((c) => c.id === "negative_control")!;
    expect(control.passed).toBe(true);
    expect(control.sample).toEqual(expect.arrayContaining([{ payment_id: "P-5001", correct_cents: "12999", control_cents: "1299900" }]));
    // Same logical records, same numbers.
    expect(d.snapshot_before!.revision).toBe(1);
    expect(d.snapshot_after!.revision).toBe(2);
    expect(d.snapshot_after!.dashboards).toEqual(d.snapshot_before!.dashboards);
    expect(d.snapshot_after!.finance_net_by_currency).toEqual({ USD: "159227" });
    // The refresh used exactly the tested mapping revision and contract version, read back from the database.
    expect(d.snapshot_after!.mapping_rev).toBe(r.candidate_rev);
    expect(d.snapshot_after!.contract_versions.payments).toBe(2);
    const env = (await getEnv(d.env.id))!;
    expect(env.active_mapping_rev).toBe(r.candidate_rev);
    expect(env.active_contracts.payments).toBe(2);
    expect(d.timings!.alert_ms).not.toBeNull();
    expect(d.timings!.verified_repair_ms).not.toBeNull();
    expect(d.score!.matched).toBe(d.score!.total);
    // The alert came before the change was active.
    const kinds = d.timeline.map((t) => t.kind);
    expect(kinds.indexOf("alert")).toBeLessThan(kinds.indexOf("activation"));
    expect(d.events.map((e) => e.type)).toEqual(expect.arrayContaining(["source.change.proposed", "source.export.started", "source.export.progress", "source.batch.arrived", "pipeline.validation.completed", "snapshot.published"]));
  });

  it("12.34 dollars and 1234 cents normalize to the same canonical 1234 cents", async () => {
    const batches = await q("SELECT rows, contract_version FROM feed_batches WHERE source='payments' AND status='applied' AND env_id=(SELECT env_id FROM runs WHERE kind='rehearsal' ORDER BY created_at DESC LIMIT 1) ORDER BY seq");
    expect(batches[0].rows.find((r: any) => r.payment_id === "P-5009").payment_amount).toBe(12.34);
    expect(batches[1].rows.find((r: any) => r.payment_id === "P-5009").amount_cents).toBe(1234);
    expect(batches[1].contract_version).toBe(2);
  });

  it("blocks a mapping that keeps the old conversion, names the first failed check, and keeps the previous snapshot", async () => {
    const d = await runPlan(caseId(1), { kind: "rehearsal", fault: "bad_repair" });
    expect(d.run.outcome).toBe("hold_previous_snapshot");
    expect(d.publish_status).toBe("held");
    const r = d.incidents[0].repair!;
    expect(r.status).toBe("failed");
    expect(r.replay!.passed).toBe(false);
    expect(r.replay!.first_failed_check).toBe("per_payment_rows");
    expect(r.replay!.checks.find((c) => c.id === "per_payment_rows")!.sample![0]).toMatchObject({ payment_id: "P-5001", baseline_cents: "12999", candidate_cents: "1299900" });
    expect(d.snapshot_after).toBeNull();
    expect(d.snapshot_current!.id).toBe(d.snapshot_before!.id);
    expect(d.env.health).toBe("at_risk");
    expect(d.incidents[0].has_verified_fix).toBe(false);
    const env = (await getEnv(d.env.id))!;
    expect(env.active_contracts.payments).toBe(1);
    expect(env.active_mapping_rev).toBe(env.baseline_rev);
  });
});

describe("catalog", () => {
  it("additive change passes quickly with no investigation", async () => {
    const d = await runPlan(caseId(2));
    expect(d.run.outcome).toBe("pass_and_publish");
    expect(d.incidents).toHaveLength(0);
    expect(d.agent_runs).toHaveLength(0);
    expect(d.snapshot_after!.contract_versions.orders).toBe(2);
  });

  it("ambiguity is visible and blocks activation", async () => {
    const d = await runPlan(caseId(3));
    expect(d.run.outcome).toBe("block_pending_clarification");
    expect(d.incidents[0].status).toBe("pending_clarification");
    expect(d.incidents[0].next_action).toMatch(/Payments Platform/);
    expect(d.incidents[0].repair!.missing_facts.length).toBeGreaterThan(0);
    expect(d.snapshot_current!.revision).toBe(1);
    expect((await q1("SELECT status FROM contracts WHERE env_id=$1 AND source='payments' AND version=2", [d.env.id])).status).toBe("pending_clarification");
  });

  it("warns on a late export, updates the warning and recovers; marks Delayed when the deadline is missed", async () => {
    const late = await runPlan(caseId(14));
    expect(late.run.outcome).toBe("warn_and_recover");
    expect(late.events.some((e) => e.type === "source.delivery.at_risk")).toBe(true);
    expect(late.incidents[0].status).toBe("recovered");
    expect(late.incidents[0].history.some((h) => /started \d+ min after/.test(h.note))).toBe(true);
    expect(late.publish_status).toBe("published");

    const missed = await runPlan(caseId(15));
    expect(missed.run.outcome).toBe("delayed_previous_snapshot");
    expect(missed.publish_status).toBe("delayed");
    expect(missed.env.health).toBe("delayed");
    expect(missed.incidents[0].freshness.label).toBe("delayed");
    expect(missed.snapshot_current!.data_as_of).toBe(missed.snapshot_before!.data_as_of);
  });

  it("ignores duplicate and out-of-order batches", async () => {
    const dup = await runPlan(caseId(10));
    expect(dup.events.filter((e) => e.type === "source.batch.arrived" && e.source === "payments").map((e) => e.status).sort()).toEqual(["accepted", "duplicate"]);
    expect(dup.snapshot_after!.revision).toBe(2);
    const stale = await runPlan(caseId(11));
    expect(stale.events.find((e) => e.status === "ignored")!.note).toMatch(/Older/);
    expect((await q1("SELECT status FROM feed_batches WHERE env_id=$1 AND seq=0", [stale.env.id])).status).toBe("ignored");
    expect(stale.snapshot_after!.dashboards).toEqual(stale.snapshot_before!.dashboards);
  });

  it("keeps two close changes on separate incidents with separate evidence", async () => {
    const d = await runPlan(caseId(19));
    expect(d.incidents).toHaveLength(1);
    expect(new Set(d.events.filter((e) => e.type === "source.change.proposed").map((e) => e.correlation_id)).size).toBe(2);
    expect(d.snapshot_after!.contract_versions).toMatchObject({ payments: 2, orders: 2 });
    const cited = d.incidents[0].finding!.evidence_ids;
    const own = d.evidence.filter((e) => e.incident_id === d.incidents[0].id).map((e) => e.id);
    expect(cited.every((id) => own.includes(id))).toBe(true);
  });

  it("a blocked proposal that is later withdrawn lets the cycle finish normally", async () => {
    const { CATALOG } = await import("../src/lib/catalog");
    const { validatePlan } = await import("../src/lib/scenario");
    const base = CATALOG[3].plan; // required order ID removed: blocked at rehearsal
    const proposed = base.events.find((e) => e.type === "source.change.proposed")!;
    const planId = "t-blocked-withdrawn";
    const plan = { ...base, events: [...base.events, { offset_min: 20, type: "source.change.withdrawn", source: proposed.source, payload: {} }], expected_outcome: { ...base.expected_outcome, outcome: "withdrawn_no_change" } };
    const v = validatePlan(plan, "catalog");
    if (!v.ok) throw new Error(v.reasons.join("; "));
    const { expected_outcome, ...sans } = plan;
    await q("INSERT INTO scenario_plans (id,origin,author_role,agent_id,team,seed,status,title,summary,quick,plan) VALUES ($1,'agent','Test','-',$2,1,'accepted',$3,'',false,$4)", [planId, plan.team, "Blocked then withdrawn", JSON.stringify(sans)]);
    await q("INSERT INTO scenario_expectations (plan_id, expected) VALUES ($1,$2)", [planId, JSON.stringify(v.expectation)]);
    const d = await runPlan(planId);
    expect(d.run.outcome).toBe("withdrawn_no_change");
    expect(d.incidents.filter((i) => i.status === "delayed" || i.status === "warning")).toEqual([]);
    expect(d.publish_status).toBe("published");
  });

  it("holds the change when the agent runtime is down; deterministic validation still decides", async () => {
    const d = await runPlan(caseId(20));
    expect(d.run.outcome).toBe("hold_previous_snapshot");
    expect(d.agent_runs.every((a) => a.status === "error" && a.error_category === "unavailable")).toBe(true);
    expect(d.incidents[0].finding!.source).toBe("deterministic_fallback");
    expect(d.incidents[0].repair!.replay!.passed).toBe(false);
    expect(d.snapshot_current!.revision).toBe(1);
  });

  it.each(CATALOG.map((c) => [c.case_no, c.title, c.plan.expected_outcome.outcome] as const))("case %i: %s -> %s", async (n, _t, outcome) => {
    const d = await runPlan(caseId(n));
    expect(d.run.status).toBe("completed");
    expect(d.run.outcome).toBe(outcome);
    expect(d.score!.items.filter((i) => !i.match)).toEqual([]);
    if (d.publish_status !== "published") expect(d.snapshot_current!.id).toBe(d.snapshot_before!.id);
    else expect(d.snapshot_after!.dashboards).toEqual(d.snapshot_before!.dashboards);
  });
});

describe("agent output handling", () => {
  it("rejects evidence IDs from another run, keeps the failure, and accepts the corrected reply", async () => {
    const d = await runPlan(caseId(1), { fault: "wrong_evidence" });
    const inv = d.agent_runs.filter((a) => a.role === "Investigator");
    expect(inv[0]).toMatchObject({ status: "error", error_category: "invalid_evidence", attempt: 1 });
    expect(inv[0].error_message).toMatch(/E-00000000-99/);
    expect(inv[1]).toMatchObject({ status: "ok", attempt: 2 });
    expect(d.run.outcome).toBe("repair_and_publish");
    expect(d.timeline.some((t) => /rejected: invalid evidence/.test(t.title))).toBe(true);
  });

  it("surfaces malformed agent output separately and retries", async () => {
    const d = await runPlan(caseId(1), { fault: "malformed_output" });
    expect(d.agent_runs.filter((a) => a.error_category === "malformed_output").length).toBeGreaterThanOrEqual(1);
    expect(d.run.outcome).toBe("repair_and_publish");
  });

  it("records provenance for every agent turn and labels fixture mode", async () => {
    const d = await runPlan(caseId(7));
    expect(d.run.used_fixture).toBe(true);
    expect(d.run.used_live).toBe(false);
    for (const a of d.agent_runs) {
      expect(a.mode).toBe("fixture");
      expect(a.agent_id).toMatch(/^sg-/);
      expect(a.input_excerpt.length).toBeGreaterThan(50);
    }
    expect(d.timeline.filter((t) => t.kind === "agent").every((t) => t.actor.includes("Fixture mode"))).toBe(true);
    // The investigator never sees the answer key or the catalog title.
    const prompt = d.agent_runs[0].input_excerpt;
    expect(prompt).not.toMatch(/expected_outcome|repair_and_publish|Refund sign convention changes|catalog-07/);
  });
});

describe("queue", () => {
  it("re-queues work after a lease expires, rejects the stale holder, and finishes on restart", async () => {
    await q("DELETE FROM jobs");
    const runId = await insertRun(caseId(2));
    await enqueue("run.execute", { run_id: runId }, { dedupKey: `run:${runId}`, serialKey: "fixture:baseline_usd" });
    expect(await enqueue("run.execute", { run_id: runId }, { dedupKey: `run:${runId}` })).toBeDefined();
    expect((await q("SELECT 1 FROM jobs")).length).toBe(1); // de-duplicated by logical operation
    const first = (await claim(60))!;
    expect(first.attempt).toBe(1);
    expect(await claim(60)).toBeNull();
    // The worker dies mid-run: the run row is 'running' and the lease runs out.
    await q("UPDATE runs SET status='running', started_at=now() WHERE id=$1", [runId]);
    await q("UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id=$1", [first.id]);
    expect((await requeueExpired()).map((j) => j.id)).toEqual([first.id]);
    expect(await heartbeat(first, 60)).toBe(false);
    expect(await complete(first, {})).toBe(false);
    const second = (await claim(60))!;
    expect(second.attempt).toBe(2);
    expect(second.claim_token).not.toBe(first.claim_token);
    await executeRun(second.payload.run_id);
    expect(await complete(second, {})).toBe(true);
    expect((await q1("SELECT status, outcome FROM runs WHERE id=$1", [runId]))).toMatchObject({ status: "completed", outcome: "pass_and_publish" });
  });

  it("serializes runs that share a fixture", async () => {
    await q("DELETE FROM jobs");
    await enqueue("run.execute", { run_id: "a" }, { dedupKey: "a", serialKey: "fixture:x" });
    await enqueue("run.execute", { run_id: "b" }, { dedupKey: "b", serialKey: "fixture:x" });
    await enqueue("run.execute", { run_id: "c" }, { dedupKey: "c", serialKey: "fixture:y" });
    const one = (await claim(60))!;
    const two = (await claim(60))!;
    expect([one.payload.run_id, two.payload.run_id]).toEqual(["a", "c"]);
    expect(await claim(60)).toBeNull();
    await complete(one);
    expect((await claim(60))!.payload.run_id).toBe("b");
    await q("DELETE FROM jobs");
  });

  it("re-executing a run is idempotent and reuses completed agent turns", async () => {
    const id = await insertRun(caseId(1));
    await executeRun(id);
    const before = await q("SELECT id FROM agent_runs WHERE run_id=$1", [id]);
    await executeRun(id);
    const after = await q("SELECT id FROM agent_runs WHERE run_id=$1", [id]);
    expect(after.length).toBe(before.length);
    expect((await q1("SELECT outcome FROM runs WHERE id=$1", [id])).outcome).toBe("repair_and_publish");
    expect((await q("SELECT 1 FROM snapshots WHERE run_id=$1 AND status='published'", [id])).length).toBe(1);
  });
});

describe("publication guard", () => {
  it("a delayed or duplicated refresh cannot overwrite a newer snapshot", async () => {
    const env = await createEnvironment("t_guard", "t", "sandbox", "baseline_usd");
    const late = await refreshAndPublish({ envId: env.id, runId: null, dataAsOf: new Date(), expectedPrevRevision: 0 });
    expect(late.published).toBe(false);
    expect(late.reason).toMatch(/newer snapshot/);
    const ok = await refreshAndPublish({ envId: env.id, runId: null, dataAsOf: new Date(), expectedPrevRevision: 1 });
    expect(ok.published).toBe(true);
    expect(await publishCandidate(env.id, ok.snapshot_id, 1)).toBe(false); // already published
    expect((await getEnv(env.id))!.current_revision).toBe(2);
    expect((await q("SELECT 1 FROM snapshots WHERE env_id=$1 AND status='published'", [env.id])).length).toBe(2);
  });
});

describe("scenario authors", () => {
  it("generates plans in a bounded pool, keeps invalid drafts with reasons, and stores expectations privately", async () => {
    const res = await generateScenarios("batch_test", 300, 2, "fixture");
    expect(res.accepted).toBe(6);
    expect(res.invalid).toBeGreaterThanOrEqual(1);
    const plans = await q("SELECT * FROM scenario_plans WHERE batch_id='batch_test' ORDER BY created_at, id");
    const invalid = plans.filter((p) => p.status === "invalid");
    expect(invalid[0].reasons[0]).toMatch(/cannot be scripted/);
    const accepted = plans.filter((p) => p.status === "accepted");
    expect(new Set(accepted.map((p) => p.team))).toEqual(new Set(["orders", "payments", "shipping"]));
    for (const p of accepted) {
      expect(p.plan.expected_outcome).toBeUndefined();
      expect(await q1("SELECT 1 AS ok FROM scenario_expectations WHERE plan_id=$1", [p.id])).toEqual({ ok: 1 });
    }
    const d = await runPlan(accepted[0].id);
    expect(d.run.status).toBe("completed");
    expect(d.score!.items.filter((i) => !i.match)).toEqual([]);
    const authors = await q("SELECT DISTINCT agent_id FROM agent_runs WHERE batch_id='batch_test'");
    expect(authors.map((a) => a.agent_id).sort()).toEqual(["sg-orders-author", "sg-payments-author", "sg-shipping-author"]);
  });
});

describe("API commands", () => {
  it("validates requests, returns an ID promptly and refuses rejected plans", async () => {
    await expect(startRun({ kind: "nope" } as any)).rejects.toBeInstanceOf(HttpError);
    await expect(startRun({ kind: "scenario", plan_id: "missing" })).rejects.toMatchObject({ status: 404 });
    const bad = (await q1("SELECT id FROM scenario_plans WHERE status='invalid' LIMIT 1")).id;
    await expect(startRun({ kind: "scenario", plan_id: bad })).rejects.toMatchObject({ status: 409 });
    const { run_id } = await startRun({ kind: "rehearsal" });
    expect(run_id).toMatch(/^run_[0-9a-f]{12}$/);
    expect((await q1("SELECT status, serial_key FROM jobs WHERE dedup_key=$1", [`run:${run_id}`]))).toEqual({ status: "queued", serial_key: "fixture:baseline_usd" });
  });

  it("reports an offline worker in the overview", async () => {
    await createEnvironment("main", "Demo pipeline", "main", "baseline_usd");
    const o = await getOverview();
    expect(o.worker.online).toBe(false);
    expect(o.snapshot!.finance_net_by_currency).toEqual({ USD: "159227" });
    expect(o.sources.map((s) => s.id)).toEqual(["orders", "payments", "shipping"]);
    await q("INSERT INTO worker_heartbeat (id,last_beat,info) VALUES ('worker', now() - interval '5 minutes', '{}')");
    expect((await getOverview()).worker).toMatchObject({ online: false });
    await q("UPDATE worker_heartbeat SET last_beat=now()");
    expect((await getOverview()).worker.online).toBe(true);
  });
});
