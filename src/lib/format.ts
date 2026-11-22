/** Display helpers for the dashboard. Money never touches floating point. */
import type { EnvHealth, IncidentView, Outcome, RunStatus } from "./api-types";

export type Tone = "neutral" | "good" | "warn" | "bad";

const CURRENCY_SYMBOL: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };

/** "184550" -> "1,845.50". Integer minor units in, BigInt arithmetic only. */
export function formatMinor(minor: string | null | undefined): string {
  if (minor == null || !/^-?\d+$/.test(minor)) return "—";
  const v = BigInt(minor);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (abs % 100n).toString().padStart(2, "0");
  return `${neg ? "−" : ""}${whole}.${frac}`;
}

export function formatMoney(minor: string | null | undefined, currency = "USD"): string {
  const body = formatMinor(minor);
  if (body === "—") return body;
  const sym = CURRENCY_SYMBOL[currency];
  if (!sym) return `${body} ${currency}`;
  return body.startsWith("−") ? `−${sym}${body.slice(1)}` : `${sym}${body}`;
}

/** Dashboard metric values are strings. "net_revenue_cents.USD" is money in that currency; the rest are counts. */
export function formatMetric(key: string, value: string): string {
  const money = /_cents(?:\.([A-Z]{3}))?$/.exec(key);
  if (money) return formatMoney(value, money[1] ?? "USD");
  if (/^-?\d+$/.test(value)) return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return value;
}

export function humanize(key: string): string {
  const cur = /\.([A-Z]{3})$/.exec(key)?.[1];
  const s = key.replace(/\.[A-Z]{3}$/, "").replace(/_cents$/, "").replace(/[._-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1) + (cur ? ` (${cur})` : "");
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m} min ${String(s).padStart(2, "0")} s`;
}

export function formatAgo(seconds: number | null | undefined): string {
  if (seconds == null) return "never";
  if (seconds < 5) return "just now";
  if (seconds < 90) return `${Math.round(seconds)} s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}

export function shortSha(rev: string | null | undefined): string {
  return rev ? rev.slice(0, 7) : "—";
}

export function utcLabel(iso: string): string {
  return iso.replace("T", " ").replace(/(\.\d+)?Z$/, " UTC");
}

export function localDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

/** Simulated clock, always shown in UTC so replays read the same everywhere. */
export function simClock(iso: string): string {
  const m = /T(\d\d:\d\d)/.exec(iso);
  return m ? m[1] : iso;
}

export const OUTCOME_LABEL: Record<Outcome, string> = {
  repair_and_publish: "Repaired and published",
  pass_and_publish: "Passed and published",
  block_pending_clarification: "Blocked pending clarification",
  hold_previous_snapshot: "Held on previous snapshot",
  warn_and_recover: "Warned, then recovered",
  delayed_previous_snapshot: "Delayed on previous snapshot",
  ignore_event: "Event ignored",
  withdrawn_no_change: "Withdrawn, no change",
};

export const OUTCOME_TONE: Record<Outcome, Tone> = {
  repair_and_publish: "good",
  pass_and_publish: "good",
  block_pending_clarification: "warn",
  hold_previous_snapshot: "bad",
  warn_and_recover: "good",
  delayed_previous_snapshot: "warn",
  ignore_event: "neutral",
  withdrawn_no_change: "neutral",
};

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
};

export const HEALTH_LABEL: Record<EnvHealth, string> = {
  healthy: "Healthy",
  at_risk: "At risk",
  delayed: "Delayed",
};

export const HEALTH_TONE: Record<EnvHealth, Tone> = { healthy: "good", at_risk: "warn", delayed: "bad" };

const INCIDENT_LABEL: Record<IncidentView["status"], string> = {
  at_risk: "At risk",
  investigating: "Investigating",
  diagnosed: "Diagnosed",
  repair_verified: "Repair verified",
  resolved: "Resolved",
  blocked: "Blocked",
  pending_clarification: "Pending clarification",
  held: "Held",
  delayed: "Delayed",
  warning: "Warning",
  recovered: "Recovered",
  withdrawn: "Withdrawn",
};

const INCIDENT_TONE: Record<IncidentView["status"], Tone> = {
  at_risk: "warn",
  investigating: "warn",
  diagnosed: "warn",
  repair_verified: "good",
  resolved: "good",
  blocked: "bad",
  pending_clarification: "warn",
  held: "bad",
  delayed: "bad",
  warning: "warn",
  recovered: "good",
  withdrawn: "neutral",
};

/** A proposed change that is not live yet reads "At risk before release", never just "At risk". */
export function incidentLabel(i: Pick<IncidentView, "status" | "risk_kind">): string {
  if (i.risk_kind === "future_change" && (i.status === "at_risk" || i.status === "investigating" || i.status === "diagnosed")) {
    return i.status === "at_risk" ? "At risk before release" : `${INCIDENT_LABEL[i.status]} · at risk before release`;
  }
  return INCIDENT_LABEL[i.status] ?? i.status;
}

export function incidentTone(i: Pick<IncidentView, "status">): Tone {
  return INCIDENT_TONE[i.status] ?? "neutral";
}

export function isOpenIncident(i: Pick<IncidentView, "status">): boolean {
  return !["resolved", "recovered", "withdrawn"].includes(i.status);
}

export function assetLabel(id: string): string {
  return humanize(id.replace(/^(dashboard|dash|feed|staging|stg|fact)[.:]/, ""));
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
