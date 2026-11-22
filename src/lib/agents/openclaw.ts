import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { cfg, redact } from "../config";
import { run } from "../proc";

export type ErrorCategory = "unauthorized" | "unavailable" | "rate_limited" | "timeout" | "malformed_output" | "provenance_mismatch" | "invalid_evidence";

export class AgentError extends Error {
  constructor(public category: ErrorCategory, message: string, public elapsedMs = 0, public provider: string | null = null, public model: string | null = null) {
    super(message);
  }
}

export interface TurnResult {
  text: string;
  provider: string | null;
  model: string | null;
  usage: { input?: number; output?: number; total?: number } | null;
  elapsedMs: number;
  sessionKey: string | null;
}

export const gatewayLogPath = () => path.join(cfg().runtimeDir, "openclaw-gateway.log");

export function classifyProviderText(text: string): ErrorCategory | null {
  if (/\b(401|403)\b|unauthori[sz]ed|invalid[_ ]api[_ ]key|authentication|permission[_ ]denied|wrong api key/i.test(text)) return "unauthorized";
  if (/\b429\b|rate[_ -]?limit|too_many_requests|queue_exceeded|quota/i.test(text)) return "rate_limited";
  if (/timed? ?out|deadline exceeded|ETIMEDOUT/i.test(text)) return "timeout";
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|gateway (is )?not running|not reachable|\b50[0234]\b|overloaded|unavailable|fetch failed|model[_ ]not[_ ]found|does not exist/i.test(text)) return "unavailable";
  return null;
}

/** Provider errors the Gateway logged for one session. The CLI itself retries silently for minutes. */
function providerErrorsFor(sessionKey: string, fromOffset: number): { count: number; category: ErrorCategory | null; detail: string } {
  try {
    const file = gatewayLogPath();
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(Math.min(size - fromOffset, 512 * 1024));
    fs.readSync(fd, buf, 0, buf.length, Math.max(fromOffset, size - buf.length));
    fs.closeSync(fd);
    const lines = buf.toString("utf8").replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter((l) => l.includes(sessionKey) && l.includes("[provider-error]"));
    if (!lines.length) return { count: 0, category: null, detail: "" };
    const last = lines[lines.length - 1];
    const status = /status=(\d+)/.exec(last)?.[1] ?? "";
    const code = /code=(\S+)/.exec(last)?.[1] ?? "";
    const type = /type=(\S+)/.exec(last)?.[1] ?? "";
    const detail = `provider returned HTTP ${status}${code ? ` ${code}` : ""}${type ? ` (${type})` : ""}`;
    return { count: lines.length, category: classifyProviderText(`${status} ${code} ${type}`) ?? "unavailable", detail };
  } catch {
    return { count: 0, category: null, detail: "" };
  }
}

/**
 * One agent turn through the local OpenClaw Gateway:
 *   openclaw --profile <p> agent --agent <id> --session-key <key> --message-file <tmp> --json
 * This is the only place that knows how OpenClaw is invoked. The prompt goes through a private
 * temp file, never the command line. `--deliver` is never used.
 */
export async function liveTurn(opts: { agentId: string; sessionKey: string; prompt: string; timeoutSeconds?: number }): Promise<TurnResult> {
  const c = cfg();
  const [wantProvider, ...rest] = c.modelRef.split("/");
  const wantModel = rest.join("/");
  if (!fs.existsSync(c.openclawBin)) throw new AgentError("unavailable", `OpenClaw CLI not found at OPENCLAW_BIN (${c.openclawBin})`);
  const tmpDir = path.join(c.runtimeDir, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  const file = path.join(tmpDir, `prompt-${crypto.randomBytes(8).toString("hex")}.txt`);
  fs.writeFileSync(file, opts.prompt, { mode: 0o600 });
  const timeout = opts.timeoutSeconds ?? c.agentTimeoutSeconds;
  const logOffset = fs.existsSync(gatewayLogPath()) ? fs.statSync(gatewayLogPath()).size : 0;
  const abort = new AbortController();
  let early: ReturnType<typeof providerErrorsFor> | null = null;
  const watcher = setInterval(() => {
    const seen = providerErrorsFor(opts.sessionKey, logOffset);
    if (seen.count >= 4) {
      early = seen;
      abort.abort();
    }
  }, 700);
  try {
    const r = await run(
      c.openclawBin,
      ["--profile", c.openclawProfile, "--no-color", "agent", "--agent", opts.agentId, "--session-key", opts.sessionKey, "--model", c.modelRef, "--thinking", c.thinking, "--message-file", file, "--json", "--timeout", String(timeout)],
      { timeoutMs: (timeout + 5) * 1000, abort: abort.signal, env: { ...process.env, NO_COLOR: "1" } },
    );
    const seen = (early as ReturnType<typeof providerErrorsFor> | null) ?? providerErrorsFor(opts.sessionKey, logOffset);
    if (r.aborted && seen.category) throw new AgentError(seen.category, `${seen.detail} for ${c.modelRef}; stopped after ${seen.count} attempts`, r.elapsedMs, wantProvider, wantModel);
    if (r.timedOut) throw new AgentError(seen.category ?? "timeout", seen.category ? `${seen.detail} for ${c.modelRef}` : `no reply from ${c.modelRef} within ${timeout}s`, r.elapsedMs, wantProvider, wantModel);

    let body: any = null;
    const start = r.stdout.indexOf("{");
    if (start >= 0) {
      try {
        body = JSON.parse(r.stdout.slice(start));
      } catch {
        body = null;
      }
    }
    const meta = body?.result?.meta ?? body?.meta ?? {};
    const agentMeta = meta.agentMeta ?? {};
    const text: string | undefined = meta.finalAssistantVisibleText ?? body?.result?.payloads?.find((p: any) => typeof p?.text === "string")?.text ?? body?.payloads?.[0]?.text;
    const provider = agentMeta.provider ?? meta.executionTrace?.winnerProvider ?? null;
    const model = agentMeta.model ?? meta.executionTrace?.winnerModel ?? null;
    if (r.code !== 0 || !body || body.status !== "ok" || !text) {
      const blob = redact(`${body?.error?.message ?? ""} ${body?.summary ?? ""} ${r.stderr} ${body ? "" : r.stdout}`).replace(/\s+/g, " ").trim();
      const category = seen.category ?? classifyProviderText(blob) ?? "unavailable";
      throw new AgentError(category, (seen.detail || blob || `openclaw exited with code ${r.code}`).slice(0, 300), r.elapsedMs, provider, model);
    }
    if (provider !== wantProvider || model !== wantModel)
      throw new AgentError("provenance_mismatch", `run used ${provider}/${model}, expected ${c.modelRef}`, r.elapsedMs, provider, model);
    const u = agentMeta.usage ?? {};
    return { text, provider, model, usage: { input: u.input, output: u.output, total: u.total }, elapsedMs: meta.durationMs ?? r.elapsedMs, sessionKey: opts.sessionKey };
  } finally {
    clearInterval(watcher);
    fs.rmSync(file, { force: true });
  }
}

export async function openclawVersion(): Promise<string | null> {
  const c = cfg();
  if (!fs.existsSync(c.openclawBin)) return null;
  const r = await run(c.openclawBin, ["--version"], { timeoutMs: 15_000 });
  return /OpenClaw\s+(\S+)/.exec(r.stdout)?.[1] ?? null;
}
