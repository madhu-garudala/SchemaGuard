import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentError, classifyProviderText, liveTurn } from "../src/lib/agents/openclaw";
import { parseFinding, parseRepair } from "../src/lib/agents/schemas";
import { CATALOG } from "../src/lib/catalog";
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

describe("redaction", () => {
  it("removes configured secrets and key-shaped strings", () => {
    process.env.CEREBRAS_API_KEY = "csk-test-0123456789abcdef";
    const out = redact('Authorization: Bearer abcdefghijklmnop1234 key csk-test-0123456789abcdef {"api_key":"zzzzzzzzzzzz"}');
    expect(out).not.toMatch(/0123456789abcdef|abcdefghijklmnop1234|zzzzzzzzzzzz/);
    delete process.env.CEREBRAS_API_KEY;
  });
});
