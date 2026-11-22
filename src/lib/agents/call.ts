import { cfg, redact, type RoleKey } from "../config";
import { q, q1 } from "../db";
import type { AgentMode } from "../api-types";
import { AgentError, liveTurn, type ErrorCategory } from "./openclaw";
import { fixtureTurn } from "./fixture";
import { authorPrompt, investigatorPrompt, repairPrompt } from "./prompts";
import type { Parsed } from "./schemas";

export interface AgentCtx {
  runId: string | null;
  batchId?: string | null;
  mode: AgentMode;
  faults: string[];
}

export type AgentOutcome<T> =
  | { ok: true; value: T; mode: "live" | "fixture"; provider: string | null; model: string | null; elapsedMs: number }
  | { ok: false; category: ErrorCategory; message: string };

const ROLE_LABEL: Record<RoleKey, string> = { investigator: "Investigator", repair: "Repair agent", orders_author: "Orders scenario author", payments_author: "Payments scenario author", shipping_author: "Shipping scenario author" };
export const roleLabel = (r: RoleKey) => ROLE_LABEL[r];

const PROVIDER_FAILURES: ErrorCategory[] = ["unauthorized", "unavailable", "rate_limited", "timeout", "provenance_mismatch"];
const excerpt = (s: string, n = 6000) => redact(s.length > n ? `${s.slice(0, n)}\n... [${s.length - n} more characters]` : s);

/** After a provider failure, skip straight to the fallback for a short while instead of waiting out every call. */
const breaker = { until: 0, reason: "" as string };
export const resetBreaker = () => ((breaker.until = 0), (breaker.reason = ""));

function promptFor(role: RoleKey, packet: Record<string, unknown>, correction?: string[]): string {
  if (role === "investigator") return investigatorPrompt(packet, correction);
  if (role === "repair") return repairPrompt(packet, correction);
  return authorPrompt(packet, correction);
}

async function record(ctx: AgentCtx, row: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(row);
  await q(`INSERT INTO agent_runs (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`, cols.map((c) => (c === "usage" || c === "output" ? JSON.stringify(row[c]) : row[c])));
}

/**
 * Run one agent role to a validated result. Every attempt is recorded with mode, provider, model,
 * elapsed time and error category. A completed turn for the same run and purpose is reused, so a
 * job retried after a crash never pays for (or diverges from) an answer it already has.
 */
export async function callAgent<T>(ctx: AgentCtx, req: { role: RoleKey; purpose: string; packet: Record<string, unknown>; parse: (text: string) => Parsed<T> }): Promise<AgentOutcome<T>> {
  const c = cfg();
  const agentId = c.agents[req.role];
  if (ctx.runId) {
    const prior = await q1<{ output: { text: string }; mode: "live" | "fixture"; provider: string | null; model: string | null; elapsed_ms: number }>(
      "SELECT output, mode, provider, model, elapsed_ms FROM agent_runs WHERE run_id=$1 AND purpose=$2 AND status='ok' ORDER BY id DESC LIMIT 1", [ctx.runId, req.purpose]);
    if (prior?.output?.text) {
      const p = req.parse(prior.output.text);
      if (p.ok) return { ok: true, value: p.value, mode: prior.mode, provider: prior.provider, model: prior.model, elapsedMs: prior.elapsed_ms };
    }
  }
  const outage = ctx.faults.includes("agent_unavailable");
  const forcedFixture = req.role === "repair" && ctx.faults.includes("bad_repair");
  let useFixture = ctx.mode === "fixture" || forcedFixture;
  let fallbackReason: string | null = forcedFixture && ctx.mode !== "fixture" ? "fault_injection" : null;
  if (!useFixture && ctx.mode === "auto" && Date.now() < breaker.until) {
    useFixture = true;
    fallbackReason = `${breaker.reason} (recent provider failure; live retried after cool-down)`;
  }
  let correction: string[] | undefined;
  let last: { category: ErrorCategory; message: string } = { category: "unavailable", message: "no attempt made" };
  const base = { run_id: ctx.runId, batch_id: ctx.batchId ?? null, role: ROLE_LABEL[req.role], agent_id: agentId, purpose: req.purpose };

  for (let attempt = 1; attempt <= c.agentMaxAttempts + 1; attempt++) {
    const prompt = promptFor(req.role, req.packet, correction);
    const sessionKey = `sg-${(ctx.runId ?? ctx.batchId ?? "adhoc").toLowerCase()}-${req.purpose.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-a${attempt}`;
    const started = Date.now();
    let text: string;
    let provider: string | null = null;
    let model: string | null = null;
    let usage: unknown = null;
    let elapsed = 0;
    const mode: "live" | "fixture" = useFixture ? "fixture" : "live";
    try {
      if (outage) throw new AgentError("unavailable", "Agent runtime unreachable (simulated outage for this scenario)");
      if (useFixture) {
        text = fixtureTurn(req.role, req.packet, { attempt, faults: ctx.faults });
        elapsed = Date.now() - started;
      } else {
        const r = await liveTurn({ agentId, sessionKey, prompt });
        ({ text, provider, model, usage } = r);
        elapsed = r.elapsedMs;
      }
      if (ctx.faults.includes("malformed_output") && attempt === 1) text = "Looking at the evidence, I believe the most probable explanation is a change in the feed. Let me know if you want details.";
    } catch (err) {
      const e = err instanceof AgentError ? err : new AgentError("unavailable", String((err as Error).message));
      last = { category: e.category, message: redact(e.message) };
      await record(ctx, { ...base, mode, fallback_reason: fallbackReason, provider: e.provider, model: e.model, session_key: mode === "live" ? sessionKey : null, status: "error", error_category: e.category, error_message: last.message, elapsed_ms: e.elapsedMs || Date.now() - started, attempt, input_excerpt: excerpt(prompt), output_excerpt: "" });
      if (outage) break;
      if (!useFixture && PROVIDER_FAILURES.includes(e.category)) {
        breaker.until = Date.now() + 90_000;
        breaker.reason = e.category;
        if (ctx.mode === "auto") {
          useFixture = true;
          fallbackReason = e.category;
          continue;
        }
        if (e.category === "unauthorized" || e.category === "provenance_mismatch") break;
        await new Promise((r) => setTimeout(r, 1500));
      }
      continue;
    }
    const parsed = req.parse(text);
    await record(ctx, { ...base, mode, fallback_reason: fallbackReason, provider, model, session_key: mode === "live" ? sessionKey : null, status: parsed.ok ? "ok" : "error", error_category: parsed.ok ? null : parsed.category, error_message: parsed.ok ? null : parsed.errors.join("; ").slice(0, 600), elapsed_ms: elapsed, attempt, usage, input_excerpt: excerpt(prompt), output_excerpt: excerpt(text), output: { text } });
    if (parsed.ok) return { ok: true, value: parsed.value, mode, provider, model, elapsedMs: elapsed };
    last = { category: parsed.category, message: parsed.errors.join("; ") };
    correction = parsed.errors;
    if (attempt >= c.agentMaxAttempts) break;
  }
  return { ok: false, ...last };
}
