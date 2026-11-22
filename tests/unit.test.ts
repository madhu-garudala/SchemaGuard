import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentError, classifyProviderText, liveTurn } from "../src/lib/agents/openclaw";
import { callAgent, resetBreaker } from "../src/lib/agents/call";
import { extractJson, parseFinding, parseRepair } from "../src/lib/agents/schemas";
import { CATALOG } from "../src/lib/catalog";
import { authorPacket } from "../src/lib/generate";
import { redact } from "../src/lib/config";
import { classifyChanges, diffContracts, traceImpact, validateBatch } from "../src/lib/contracts";
import { closePool } from "../src/lib/db";
import { baselineContract, baselineData } from "../src/lib/fixtures";
import { ensureFixtureRepo, readMappings, revisionDir, runPipelineAt } from "../src/lib/fixture-repo";
import { cents, centsToDecimal, diffCentMaps, sameCents } from "../src/lib/money";
import { buildEffect } from "../src/lib/mutations";
import { applyOperations, assertionGate, RepairOperation } from "../src/lib/repair-ops";
import { reconcile } from "../src/lib/replay";
import { validatePlan } from "../src/lib/scenario";

afterAll(closePool);

describe("money", () => {
  it("stays in integer minor units", () => {
    expect(cents("1234")).toBe(1234n);
    expect(centsToDecimal("159227")).toBe("1592.27");
    expect(centsToDecimal("-3505")).toBe("-35.05");
    expect(sameCents("1234", 1234n)).toBe(true);
    expect(() => cents("12.34")).toThrow();
    expect(() => cents(0.1 + 0.2)).toThrow();
    expect(diffCentMaps({ a: "1", b: "2" }, { a: "1", b: "3", c: "0" })).toEqual(["b", "c"]);
  });
});

describe("contract comparison", () => {
  const current = baselineContract("payments");
  const rows = baselineData("baseline_usd").payments;
  const effect = (m: any) => buildEffect(m, current, rows);

  it("classifies the declared rename-and-unit change and traces column-level impact", () => {
    const cand = effect({ type: "rename_amount_to_minor_units", new_name: "amount_cents", declare_unit: true, declare_rename: true }).candidateContract!;
    const changes = diffContracts(current, cand);
    expect(changes.map((c) => c.kind).sort()).toEqual(["field_renamed", "type_changed", "unit_changed"]);
    const cls = classifyChanges(current, cand, changes, rows);
    expect(cls).toMatchObject({ risk: "breaking", category: "unit_and_name_change", affected_fields: ["payment_amount"] });
    expect(traceImpact("payments", cls.affected_fields).dashboards).toEqual(["dash.finance", "dash.revenue"]);
    expect(traceImpact("shipping", []).dashboards).toEqual(["dash.operations"]);
  });

  it("treats an undeclared unit or rename as ambiguous, and nullable additions as safe", () => {
    const amb = effect({ type: "rename_amount_to_minor_units", new_name: "amount", declare_unit: false, declare_rename: false }).candidateContract!;
    expect(classifyChanges(current, amb, diffContracts(current, amb), rows).category).toBe("ambiguous_contract");
    const add = effect({ type: "add_nullable_field", source: "payments", name: "memo", field_type: "string" }).candidateContract!;
    expect(classifyChanges(current, add, diffContracts(current, add), rows)).toMatchObject({ risk: "safe_additive", category: "additive_change" });
  });

  it("validates batches against the active contract", () => {
    expect(validateBatch(current, rows).ok).toBe(true);
    expect(validateBatch(current, effect({ type: "stringify_amounts" }).rows!).problems[0].check).toBe("type_mismatch");
    expect(validateBatch(current, effect({ type: "duplicate_payments", count: 2 }).rows!).problems.map((p) => p.check)).toContain("duplicate_keys");
    const orders = baselineContract("orders");
    expect(validateBatch(orders, baselineData("baseline_usd").orders.slice(0, 3)).problems[0].check).toBe("volume_out_of_range");
    expect(validateBatch({ ...orders, fields: orders.fields.map((f) => ({ ...f, nullable: false })) }, baselineData("baseline_usd").orders).problems[0].check).toBe("null_not_allowed");
  });

  it("treats a newly required field as breaking, and ignores a second rename onto the same field", () => {
    const optional = current.fields.find((f) => !f.required) ?? current.fields[current.fields.length - 1];
    const added = { ...current, version: 2, fields: [...current.fields, { name: "memo", type: "string" as const, required: true, nullable: true, semantic: "note", unit: null }] };
    expect(classifyChanges(current, added, diffContracts(current, added), rows).risk).not.toBe("safe_additive");
    const loosened = { ...current, fields: current.fields.map((f) => (f.name === optional.name ? { ...f, required: false } : f)) };
    const tightened = { ...loosened, version: 2, fields: loosened.fields.map((f) => (f.name === optional.name ? { ...f, required: true } : f)) };
    expect(diffContracts(loosened, tightened)).toEqual([{ kind: "nullability_tightened", field: optional.name }]);
    const twice = { ...current, version: 2, fields: [...current.fields.filter((f) => f.name !== "payment_amount"), { ...current.fields.find((f) => f.name === "payment_amount")!, name: "a" }, { ...current.fields.find((f) => f.name === "payment_amount")!, name: "b" }], assertions: { renames: { a: "payment_amount", b: "payment_amount" } } };
    expect(diffContracts(current, twice as any).filter((c) => c.kind === "field_renamed")).toHaveLength(1);
  });
});

describe("repair operations and the assertion gate", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await revisionDir(await ensureFixtureRepo());
  });

  it("only accepts declared operations", () => {
    expect(RepairOperation.safeParse({ op: "run_sql", sql: "drop table" }).success).toBe(false);
    expect(RepairOperation.safeParse({ op: "rename_field", source: "payments", target: "amount_cents", from: "payment_amount", to: "amount_cents", extra: 1 }).success).toBe(false);
    expect(parseRepair('{"decision":"propose","operations":[]}').ok).toBe(false);
    expect(parseRepair('```json\n{"decision":"need_contract_fact","missing_facts":["unit"]}\n```').ok).toBe(true);
    expect(() => applyOperations(readMappings(dir), [{ op: "rename_field", source: "payments", target: "amount_cents", from: "wrong", to: "x" }])).toThrow(/reads "payment_amount"/);
  });

  it("blocks an undeclared unit even when the sample replay reconciles", async () => {
    const current = baselineContract("payments");
    const data = baselineData("baseline_usd");
    const eff = buildEffect({ type: "rename_amount_to_minor_units", new_name: "amount", declare_unit: false, declare_rename: false }, current, data.payments);
    const ops: RepairOperation[] = [{ op: "update_field_mapping", source: "payments", target: "amount_cents", from: "amount", as: "minor_units" }];
    const repaired = applyOperations(readMappings(dir), ops, { payments: 2 });
    const baseline = await runPipelineAt(dir, data);
    const candidate = await runPipelineAt(dir, { ...data, payments: eff.rows! }, { payments: repaired.payments });
    expect(reconcile(baseline, candidate).passed).toBe(true); // samples match...
    const gate = assertionGate(ops, repaired, { payments: eff.candidateContract! }, readMappings(dir));
    expect(gate.passed).toBe(false); // ...but matching samples cannot establish an undocumented contract
    expect(gate.required.find((r) => !r.present)).toMatchObject({ kind: "missing" });
    expect(gate.required.filter((r) => !r.present).map((r) => r.detail).join(" | ")).toMatch(/only an inference from samples/);
  });

  it("blocks an undeclared rename made through a generic mapping update, even with the unit declared", async () => {
    const data = baselineData("baseline_usd");
    const eff = buildEffect({ type: "rename_amount_to_minor_units", new_name: "amount", declare_unit: true, declare_rename: false }, baselineContract("payments"), data.payments);
    const ops: RepairOperation[] = [{ op: "update_field_mapping", source: "payments", target: "amount_cents", from: "amount", as: "minor_units" }];
    const base = readMappings(dir);
    const repaired = applyOperations(base, ops, { payments: 2 });
    expect(reconcile(await runPipelineAt(dir, data), await runPipelineAt(dir, { ...data, payments: eff.rows! }, { payments: repaired.payments })).passed).toBe(true);
    const gate = assertionGate(ops, repaired, { payments: eff.candidateContract! }, base);
    expect(gate.passed).toBe(false);
    expect(gate.required.find((r) => !r.present)).toMatchObject({ assertion: "payments: rename payment_amount -> amount declared", kind: "missing" });
    // The declared rename still passes, and is listed once.
    const ok = buildEffect({ type: "rename_amount_to_minor_units", new_name: "amount", declare_unit: true, declare_rename: true }, baselineContract("payments"), data.payments);
    const okGate = assertionGate(ops, repaired, { payments: ok.candidateContract! }, base);
    expect(okGate.passed).toBe(true);
    expect(okGate.required.filter((r) => /rename/.test(r.assertion))).toHaveLength(1);
  });

  it("separates what the producer left out from what the repair got wrong", () => {
    const data = baselineData("baseline_usd");
    const cand = buildEffect({ type: "rename_amount_to_minor_units", new_name: "amount_cents", declare_unit: true, declare_rename: true }, baselineContract("payments"), data.payments).candidateContract!;
    const base = readMappings(dir);
    const failing = (ops: RepairOperation[], candidates = { payments: cand }) => assertionGate(ops, applyOperations(base, ops, { payments: 2 }), candidates, base).required.filter((r) => !r.present);
    // A field name the contract does not define is the repair's mistake, not a missing declaration.
    const ghost = failing([{ op: "update_field_mapping", source: "payments", target: "amount_cents", from: "amount_minor", as: "minor_units" }]);
    expect(ghost.length).toBeGreaterThan(0);
    expect(ghost.every((r) => r.kind === "contradicted")).toBe(true);
    // Keys other than the declared ones, and a repair aimed at a feed that is not changing.
    expect(failing([{ op: "update_keys", source: "payments", keys: ["order_id"] }]).find((r) => /key/.test(r.assertion))).toMatchObject({ kind: "contradicted" });
    expect(failing([{ op: "update_keys", source: "orders", keys: ["order_id"] }])[0]).toMatchObject({ kind: "contradicted" });
    // A rename the producer declared differently.
    expect(failing([{ op: "rename_field", source: "payments", target: "amount_cents", from: "payment_amount", to: "amount_cents" }], { payments: { ...cand, assertions: { ...cand.assertions, renames: { amount_cents: "fee_amount" } } } }).find((r) => /rename/.test(r.assertion))).toMatchObject({ kind: "contradicted" });
    // A refund convention the producer never stated stays "missing".
    expect(failing([{ op: "set_refund_convention", source: "payments", convention: "positive_amount_with_kind" }], { payments: { ...cand, semantics: { ...cand.semantics, refund_convention: null } } } as any).find((r) => /refund/.test(r.assertion))).toMatchObject({ kind: "missing" });
  });

  it("concurrent requests for the same revision share one checkout", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const sha = await ensureFixtureRepo();
    const target = await revisionDir(sha);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true }); // a half-made directory from an interrupted checkout
    const dirs = await Promise.all([revisionDir(sha), revisionDir(sha), revisionDir(sha), ensureFixtureRepo()]);
    expect(new Set(dirs.slice(0, 3)).size).toBe(1);
    expect(fs.existsSync(path.join(target, "run.mjs"))).toBe(true);
  });

  it("the stale x100 conversion is caught per record: 1234 cents must not become 123400", async () => {
    const current = baselineContract("payments");
    const data = baselineData("baseline_usd");
    const eff = buildEffect({ type: "rename_amount_to_minor_units", new_name: "amount_cents", declare_unit: true, declare_rename: true }, current, data.payments);
    const renameOnly = applyOperations(readMappings(dir), [{ op: "rename_field", source: "payments", target: "amount_cents", from: "payment_amount", to: "amount_cents" }], { payments: 2 });
    const baseline = await runPipelineAt(dir, data);
    const broken = await runPipelineAt(dir, { ...data, payments: eff.rows! }, { payments: renameOnly.payments });
    const rep = reconcile(baseline, broken);
    expect(rep.first_failed_check).toBe("per_payment_rows");
    const p = (r: typeof baseline) => (r.ok ? r.output.payment_facts.find((x) => x.payment_id === "P-5009")!.amount_cents : null);
    expect(p(baseline)).toBe("1234");
    expect(p(broken)).toBe("123400");
    expect(assertionGate([], renameOnly, { payments: eff.candidateContract! }, readMappings(dir)).required.find((r) => !r.present)).toMatchObject({ kind: "contradicted" });
  });

  it("the old mapping rejects every candidate row instead of guessing", async () => {
    const data = baselineData("baseline_usd");
    const eff = buildEffect({ type: "rename_amount_to_minor_units", new_name: "amount_cents", declare_unit: true, declare_rename: true }, baselineContract("payments"), data.payments);
    const rep = reconcile(await runPipelineAt(dir, data), await runPipelineAt(dir, { ...data, payments: eff.rows! }));
    expect(rep.first_failed_check).toBe("rejected_rows");
  });
});

describe("scenario plan validation", () => {
  const base = CATALOG[0].plan;
  it("accepts all twenty catalog plans and gives each an expected result", () => {
    expect(CATALOG).toHaveLength(20);
    for (const c of CATALOG) {
      expect(validatePlan(c.plan, "catalog").ok, `case ${c.case_no}`).toBe(true);
      expect(c.expected_result.length).toBeGreaterThan(10);
    }
  });
  it("rejects undeclared mutations, out-of-scope teams, system events and contradictory expectations", () => {
    const reasons = (p: unknown, team?: any) => {
      const v = validatePlan(p, "agent", team);
      return v.ok ? [] : v.reasons;
    };
    expect(reasons({ ...base, fixture_mutation: { type: "delete_everything" } })[0]).toMatch(/fixture_mutation/);
    expect(reasons({ ...base, fixture_mutation: { type: "remove_order_id" } }).join()).toMatch(/may only change the payments feed/);
    expect(reasons(base, "orders")[0]).toMatch(/team must be "orders"/);
    expect(reasons({ ...base, events: [...base.events, { offset_min: 9, type: "snapshot.published", payload: {} }] })[0]).toMatch(/cannot be scripted/);
    expect(reasons({ ...base, expected_outcome: { ...base.expected_outcome, outcome: "pass_and_publish" } })[0]).toMatch(/contradicts the declared mutation/);
    expect(reasons({ ...base, events: [] })[0]).toMatch(/exactly one source.change.proposed/);
    expect(reasons({ ...base, extra: true })[0]).toBeDefined();
    // Delivery and extra-batch plans whose script would not produce the outcome they claim.
    const delay = CATALOG[13].plan; // shipping export late, arrives before cutoff
    const early = { ...delay, events: [...delay.events.filter((e) => !/export\.started|batch\.arrived/.test(e.type)), { offset_min: 20, type: "source.batch.arrived", source: "shipping", payload: {} }] };
    expect(reasons(early).join()).toMatch(/needs the cycle batch to arrive after minute/);
    const redeliver = CATALOG[9].plan; // already-applied batch delivered again
    const src = redeliver.team as string;
    expect(reasons({ ...redeliver, events: [...redeliver.events.filter((e) => !e.payload?.batch), { offset_min: 150, type: "source.batch.arrived", source: src, payload: { batch: "stale" } }] }).join()).toMatch(/needs payload.batch "redelivery"/);
    expect(reasons({ ...redeliver, events: [...redeliver.events.filter((e) => !e.payload?.batch), { offset_min: 1, type: "source.batch.arrived", source: src, payload: { batch: "redelivery" } }] }).join()).toMatch(/must arrive after the cycle batch/);
    expect(reasons({ ...base, events: [...base.events, { offset_min: 16, type: "source.export.started", source: "payments", payload: {} }, { offset_min: 17, type: "source.export.started", source: "payments", payload: {} }] }).join()).toMatch(/more than one source.export.started/);
    // Late delivery may only be scripted by delay_export; otherwise the expected outcome would be wrong.
    const lateArrival = { ...base, events: [...base.events.filter((e) => !(e.type === "source.batch.arrived" && e.source === "payments")), { offset_min: 190, type: "source.batch.arrived", source: "payments", payload: {} }] };
    expect(reasons(lateArrival).join()).toMatch(/may not arrive after the hard deadline/);
  });
});

describe("investigator output validation", () => {
  const ok = { observed_facts: [{ statement: "diff shows rename", evidence_ids: ["E-aaaa0000-01"] }], cause_status: "confirmed", cause_category: "unit_and_name_change", candidate_cause: "rename and unit change", evidence_ids: ["E-aaaa0000-01"], impacted_assets: ["dash.finance"], owner: "payments", severity: "high" };
  const owners = ["orders", "payments", "shipping", "data-platform"];
  it("accepts a well-formed finding and rejects wrong-run evidence, unknown assets and prose", () => {
    expect(parseFinding(JSON.stringify(ok), ["E-aaaa0000-01"], owners).ok).toBe(true);
    expect(parseFinding(JSON.stringify(ok), ["E-bbbb1111-01"], owners)).toMatchObject({ ok: false, category: "invalid_evidence" });
    expect(parseFinding(JSON.stringify({ ...ok, impacted_assets: ["dash.marketing"] }), ["E-aaaa0000-01"], owners)).toMatchObject({ ok: false, category: "malformed_output" });
    expect(parseFinding("It is probably the rename.", ["E-aaaa0000-01"], owners)).toMatchObject({ ok: false, category: "malformed_output" });
    expect(parseFinding(JSON.stringify({ ...ok, evidence_ids: [] }), ["E-aaaa0000-01"], owners).ok).toBe(false);
  });
});

describe("OpenClaw adapter", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sg-oc-"));
  const stub = (name: string, body: string) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  const envelope = (model: string) => JSON.stringify({ status: "ok", result: { payloads: [{ text: '{"ok":true}' }], meta: { durationMs: 321, finalAssistantVisibleText: '{"ok":true}', agentMeta: { provider: "cerebras", model, usage: { input: 10, output: 2, total: 12 } } } } });
  const turn = (bin: string, timeoutSeconds = 5) => {
    process.env.OPENCLAW_BIN = bin;
    process.env.OPENCLAW_MODEL = "cerebras/moonshotai-kimi-k3.1-pro-trial";
    return liveTurn({ agentId: "sg-investigator", sessionKey: `test-${Math.random()}`, prompt: "PROMPT_MARKER_42", timeoutSeconds });
  };
  afterAll(() => {
    delete process.env.OPENCLAW_BIN;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns text with provider, model, usage and elapsed time", async () => {
    const r = await turn(stub("ok", `cat <<'J'\n${envelope("moonshotai-kimi-k3.1-pro-trial")}\nJ`));
    expect(r).toMatchObject({ text: '{"ok":true}', provider: "cerebras", model: "moonshotai-kimi-k3.1-pro-trial", elapsedMs: 321, usage: { total: 12 } });
  });
  it("refuses a run that did not use the configured Kimi model", async () => {
    await expect(turn(stub("other", `cat <<'J'\n${envelope("gpt-oss-120b")}\nJ`))).rejects.toMatchObject({ category: "provenance_mismatch" });
  });
  it("separates unauthorized, rate-limited, unavailable and timeout", async () => {
    await expect(turn(stub("401", `echo "HTTP 401 invalid_api_key" >&2; exit 1`))).rejects.toMatchObject({ category: "unauthorized" });
    await expect(turn(stub("429", `echo "status=429 code=queue_exceeded" >&2; exit 1`))).rejects.toMatchObject({ category: "rate_limited" });
    await expect(turn(stub("down", `echo "connect ECONNREFUSED 127.0.0.1:18795" >&2; exit 1`))).rejects.toMatchObject({ category: "unavailable" });
    await expect(turn(stub("hang", `sleep 60`), 1)).rejects.toMatchObject({ category: "timeout" });
    await expect(turn(path.join(dir, "missing"))).rejects.toBeInstanceOf(AgentError);
    expect(classifyProviderText("all good")).toBeNull();
  }, 30_000);
  it("passes the prompt through a private file, never the command line", async () => {
    const r = await turn(stub("args", `case "$*" in *PROMPT_MARKER_42*) echo leaked >&2; exit 1;; esac\ncat <<'J'\n${envelope("moonshotai-kimi-k3.1-pro-trial")}\nJ`));
    expect(r.text).toBe('{"ok":true}');
  });
});

describe("agent retries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sg-retry-"));
  const bin = path.join(dir, "openclaw");
  const counter = path.join(dir, "calls");
  const reply = JSON.stringify({ status: "ok", result: { payloads: [{ text: "not json" }], meta: { durationMs: 12.6, finalAssistantVisibleText: "not json", agentMeta: { provider: "cerebras", model: "moonshotai-kimi-k3.1-pro-trial", usage: {} } } } });
  const setBin = (body: string) => {
    fs.writeFileSync(bin, `#!/bin/sh\necho x >> ${counter}\n${body}\n`, { mode: 0o755 });
    fs.rmSync(counter, { force: true });
    process.env.OPENCLAW_BIN = bin;
    process.env.OPENCLAW_MODEL = "cerebras/moonshotai-kimi-k3.1-pro-trial";
    resetBreaker();
  };
  const calls = () => (fs.existsSync(counter) ? fs.readFileSync(counter, "utf8").trim().split("\n").length : 0);
  const ask = (mode: "live" | "auto", parse: (t: string) => any) => callAgent({ runId: null, batchId: `retry_${Math.random().toString(16).slice(2)}`, mode, faults: [] }, { role: "payments_author", purpose: "retry-test", packet: authorPacket("payments", 4242, []), parse });
  afterAll(() => {
    delete process.env.OPENCLAW_BIN;
    resetBreaker();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("live mode makes at most the configured number of provider calls", async () => {
    setBin(`echo "status=503 unavailable" >&2; exit 1`);
    const r = await ask("live", () => ({ ok: true, value: 1 }));
    expect(r).toMatchObject({ ok: false, category: "unavailable" });
    expect(calls()).toBe(2);
  }, 30_000);

  it("live mode allows exactly one correction after an invalid reply, and stores a whole-number duration", async () => {
    setBin(`cat <<'J'\n${reply}\nJ`);
    const seen: string[] = [];
    const r = await ask("live", (t) => (seen.push(t), { ok: false, category: "malformed_output", errors: ["not JSON"] }));
    expect(r).toMatchObject({ ok: false, category: "malformed_output" });
    expect(calls()).toBe(2);
    expect(seen).toHaveLength(2);
  }, 30_000);

  it("auto mode still gets its correction turn after falling back to fixture output", async () => {
    setBin(`echo "status=429 code=queue_exceeded" >&2; exit 1`);
    let parses = 0;
    const r = await ask("auto", () => (++parses === 1 ? { ok: false, category: "malformed_output", errors: ["try again"] } : { ok: true, value: "second" }));
    expect(calls()).toBe(1);
    expect(parses).toBe(2);
    expect(r).toMatchObject({ ok: true, value: "second", mode: "fixture" });
  }, 30_000);
});

describe("reply parsing", () => {
  it("prefers the fenced JSON block over braces in the surrounding prose", () => {
    expect(extractJson('Here {is} the plan:\n```json\n{"a":1}\n```\nNote the {braces} above.')).toEqual({ a: 1 });
    expect(extractJson('prefix {"b":2} suffix')).toEqual({ b: 2 });
    expect(() => extractJson("no object here")).toThrow();
  });
});

describe("redaction", () => {
  it("removes configured secrets and key-shaped strings", () => {
    // Dummy values are assembled at runtime so secret scanners do not mistake them for real credentials.
    const fakeKey = ["csk", "test", "0123456789abcdef"].join("-");
    const fakeBearer = "abcdefghij".repeat(2);
    const fakeField = "z".repeat(12);
    process.env.CEREBRAS_API_KEY = fakeKey;
    const out = redact(`Authorization: ${"Bearer"} ${fakeBearer} key ${fakeKey} {"api_key":"${fakeField}"}`);
    expect(out).not.toContain(fakeKey);
    expect(out).not.toContain(fakeBearer);
    expect(out).not.toContain(fakeField);
    delete process.env.CEREBRAS_API_KEY;
  });
});
