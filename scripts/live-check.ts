import { AgentError, liveTurn, openclawVersion } from "../src/lib/agents/openclaw";
import { investigatorPrompt } from "../src/lib/agents/prompts";
import { parseFinding } from "../src/lib/agents/schemas";
import { cfg, redact } from "../src/lib/config";
import { loadEnv } from "../src/lib/env";
import { CAUSE_CATEGORIES } from "../src/lib/types";
import { lineage } from "../src/lib/fixtures";

/**
 * Live acceptance check, through the same adapter the worker uses:
 *  1. a minimal completion, 2. an evidence-packet turn validated like a real finding.
 * Prints provider, model, elapsed time and, on failure, the error category. Never prints secrets.
 */
loadEnv();
const c = cfg();
const stamp = Date.now().toString(36);

async function step(name: string, fn: () => Promise<string>): Promise<boolean> {
  try {
    console.log(`PASS  ${name}: ${await fn()}`);
    return true;
  } catch (err) {
    const e = err as AgentError;
    console.log(`FAIL  ${name}: category=${e.category ?? "unknown"} after ${e.elapsedMs ?? 0}ms — ${redact(e.message)}`);
    return false;
  }
}

async function main() {
  console.log(`OpenClaw ${await openclawVersion()} · profile ${c.openclawProfile} · gateway 127.0.0.1:${c.gatewayPort} · model ${c.modelRef}`);
  const a = await step("minimal completion", async () => {
    const r = await liveTurn({ agentId: c.agents.investigator, sessionKey: `sg-livecheck-min-${stamp}`, prompt: 'Reply with exactly this JSON and nothing else: {"ok":true}' });
    return `provider=${r.provider} model=${r.model} elapsed=${r.elapsedMs}ms tokens=${r.usage?.total ?? "?"} reply=${r.text.replace(/\s+/g, " ").slice(0, 60)}`;
  });
  const evidence = [
    { id: "E-livechk-01", kind: "contract_diff", title: "Structural differences", body: { changes: [{ kind: "field_renamed", from: "payment_amount", to: "amount_cents", declared: true }, { kind: "unit_changed", field: "amount_cents", from: "dollars", to: "cents", previous_field: "payment_amount" }] } },
    { id: "E-livechk-02", kind: "sample_rows", title: "Rows before and after", body: { current: [{ payment_id: "P-5009", payment_amount: 12.34 }], proposed: [{ payment_id: "P-5009", amount_cents: 1234 }] } },
    { id: "E-livechk-03", kind: "lineage_impact", title: "Downstream assets", body: { assets: ["stg.payments", "fact.payments", "fact.orders", "dash.finance", "dash.revenue"] } },
  ];
  const packet = { task: "investigate", trigger: { type: "source.change.proposed", source: "payments", summary: "Payments proposed contract v2; not active yet." }, evidence, lineage_nodes: lineage().nodes, owners: ["orders", "payments", "shipping", "data-platform"], cause_categories: CAUSE_CATEGORIES };
  const b = await step("evidence-packet turn", async () => {
    const r = await liveTurn({ agentId: c.agents.investigator, sessionKey: `sg-livecheck-ev-${stamp}`, prompt: investigatorPrompt(packet) });
    const p = parseFinding(r.text, evidence.map((e) => e.id), packet.owners);
    if (!p.ok) throw new AgentError(p.category, p.errors.join("; "), r.elapsedMs, r.provider, r.model);
    return `provider=${r.provider} model=${r.model} elapsed=${r.elapsedMs}ms cause=${p.value.cause_category} (${p.value.cause_status}) evidence=${p.value.evidence_ids.join(",")}`;
  });
  console.log(a && b ? "\nLIVE CHECK PASSED" : "\nLIVE CHECK FAILED (the app still runs in fixture/auto mode)");
  process.exitCode = a && b ? 0 : 1;
}
void main();
