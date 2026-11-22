import os from "node:os";
import path from "node:path";
import type { AgentMode } from "./api-types";

export const ROOT = process.env.SCHEMA_GUARD_ROOT ?? process.cwd();

const expand = (p: string) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);
const int = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);

/** Pure configuration from process.env. Worker-side processes call loadEnv() (src/lib/env.ts) first. */
export function cfg() {
  const e = process.env;
  return {
    databaseUrl: e.DATABASE_URL ?? "postgres://schema_guard:schema_guard@127.0.0.1:54329/schema_guard",
    runtimeDir: path.resolve(ROOT, e.SCHEMA_GUARD_RUNTIME_DIR ?? ".runtime"),
    agentMode: (["live", "fixture", "auto"].includes(e.AGENT_MODE ?? "") ? e.AGENT_MODE : "auto") as AgentMode,
    openclawBin: expand(e.OPENCLAW_BIN ?? "~/.openclaw/bin/openclaw"),
    openclawProfile: e.OPENCLAW_PROFILE ?? "schema-guard",
    gatewayPort: int(e.OPENCLAW_GATEWAY_PORT, 18795),
    modelRef: e.OPENCLAW_MODEL ?? "cerebras/moonshotai-kimi-k3.1-pro-trial",
    thinking: e.OPENCLAW_THINKING ?? "off",
    agentTimeoutSeconds: int(e.OPENCLAW_TIMEOUT_SECONDS, 75),
    agentMaxAttempts: int(e.AGENT_MAX_ATTEMPTS, 2),
    agents: {
      investigator: e.OPENCLAW_AGENT_INVESTIGATOR ?? "sg-investigator",
      repair: e.OPENCLAW_AGENT_REPAIR ?? "sg-repair",
      orders_author: e.OPENCLAW_AGENT_ORDERS_AUTHOR ?? "sg-orders-author",
      payments_author: e.OPENCLAW_AGENT_PAYMENTS_AUTHOR ?? "sg-payments-author",
      shipping_author: e.OPENCLAW_AGENT_SHIPPING_AUTHOR ?? "sg-shipping-author",
    },
    runConcurrency: int(e.WORKER_RUN_CONCURRENCY, 1),
    authorConcurrency: int(e.SCENARIO_AUTHOR_CONCURRENCY, 3),
    leaseSeconds: int(e.JOB_LEASE_SECONDS, 60),
    heartbeatStaleSeconds: 15,
  };
}

export type Config = ReturnType<typeof cfg>;
export type RoleKey = keyof Config["agents"];

/** Secrets that must never appear in logs, excerpts or stored output. */
export function secretValues(): string[] {
  return [process.env.CEREBRAS_API_KEY, process.env.OPENCLAW_GATEWAY_TOKEN].filter((v): v is string => Boolean(v && v.length >= 8));
}

export function redact(text: string): string {
  let out = text;
  for (const s of secretValues()) out = out.split(s).join("[redacted]");
  return out
    .replace(/\bcsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{12,}/gi, "$1[redacted]")
    .replace(/((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',}]{8,}/gi, "$1[redacted]");
}
