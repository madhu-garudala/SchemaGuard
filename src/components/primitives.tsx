"use client";

import type { ReactNode } from "react";
import type { Outcome, RunSummary } from "@/lib/api-types";
import {
  OUTCOME_LABEL,
  OUTCOME_TONE,
  RUN_STATUS_LABEL,
  formatMoney,
  localDateTime,
  localTime,
  utcLabel,
  type Tone,
} from "@/lib/format";

/** Shape carries the meaning as well as colour: disc = good, triangle = warn, square = bad, ring = neutral. */
export function Mark({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  const cls = `t-${tone}${pulse ? " live-dot" : ""}`;
  return (
    <svg className={cls} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      {tone === "good" && <circle cx="5" cy="5" r="4.5" fill="currentColor" />}
      {tone === "warn" && <path d="M5 0.6 9.8 9.2H0.2Z" fill="currentColor" />}
      {tone === "bad" && <rect x="0.8" y="0.8" width="8.4" height="8.4" fill="currentColor" />}
      {tone === "neutral" && <circle cx="5" cy="5" r="3.8" fill="none" stroke="currentColor" strokeWidth="1.4" />}
    </svg>
  );
}

export function Status({ tone, children, pulse }: { tone: Tone; children: ReactNode; pulse?: boolean }) {
  return (
    <span className={`status t-${tone}`}>
      <Mark tone={tone} pulse={pulse} />
      <span>{children}</span>
    </span>
  );
}

export function Time({ iso, mode = "datetime" }: { iso: string | null | undefined; mode?: "datetime" | "time" }) {
  if (!iso) return <span className="faint">—</span>;
  return (
    <time dateTime={iso} title={utcLabel(iso)} className="num">
      {mode === "time" ? localTime(iso) : localDateTime(iso)}
    </time>
  );
}

export function Money({ minor, currency = "USD" }: { minor: string | null | undefined; currency?: string }) {
  return <span className="num">{formatMoney(minor, currency)}</span>;
}

export function FixtureTag({ reason }: { reason?: string | null }) {
  return (
    <span className="tag tag-fixture" title={reason ? `Canned fixture output was used because the live call failed: ${reason}` : "Canned fixture output, not a model call"}>
      Fixture mode{reason ? ` · live ${reason.replace(/_/g, " ")}` : ""}
    </span>
  );
}

export function LiveTag({ provider, model }: { provider?: string | null; model?: string | null }) {
  return (
    <span className="tag tag-live" title="Completed live through OpenClaw">
      Live{provider || model ? ` · ${[provider, model].filter(Boolean).join(" / ")}` : ""}
    </span>
  );
}

export function RunModeTags({ run }: { run: Pick<RunSummary, "used_fixture" | "used_live" | "status"> }) {
  if (!run.used_fixture && !run.used_live) return run.status === "completed" ? <span className="tag">No agent turns</span> : null;
  return (
    <>
      {run.used_live && <LiveTag />} {run.used_fixture && <FixtureTag />}
    </>
  );
}

export function OutcomeText({ outcome }: { outcome: Outcome | null }) {
  if (!outcome) return <span className="faint">—</span>;
  return <Status tone={OUTCOME_TONE[outcome]}>{OUTCOME_LABEL[outcome]}</Status>;
}

export function RunState({ run }: { run: Pick<RunSummary, "status" | "outcome"> }) {
  if (run.status === "completed") return <OutcomeText outcome={run.outcome} />;
  if (run.status === "failed") return <Status tone="bad">Run failed</Status>;
  return (
    <Status tone="neutral" pulse>
      {RUN_STATUS_LABEL[run.status]}
    </Status>
  );
}

export function Section({ title, aside, children, id }: { title: string; aside?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section id={id} aria-label={title}>
      <div className="sec-head">
        <h2 className="h-sec">{title}</h2>
        {aside != null && <div className="aside">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

export function Json({ value }: { value: unknown }) {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return (
    <pre className="code" tabIndex={0}>
      {text}
    </pre>
  );
}

export function EvidenceIds({ ids, link = true }: { ids: string[]; link?: boolean }) {
  if (!ids.length) return null;
  return (
    <div className="ev-ids">
      <span className="sr-only">Evidence: </span>
      {ids.map((id, i) => (
        <span key={id}>
          {i > 0 && "  "}
          {link ? <a href={`#ev-${id}`}>{id}</a> : id}
        </span>
      ))}
    </div>
  );
}

export function ApiError({ error, stale }: { error: string | null; stale?: boolean }) {
  if (!error) return null;
  return (
    <div className="notice notice-bad" role="alert">
      <strong>{stale ? "Showing the last loaded data." : "The dashboard API is not answering."}</strong> {error}. Check that Postgres is up
      (<code>docker compose up -d db</code>) and migrations have run (<code>npm run db:migrate</code>). Retrying automatically.
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <p className="skeleton" role="status">
      Loading {what}…
    </p>
  );
}

export interface TabDef {
  id: string;
  label: string;
  count?: number;
}

export function Tabs({ tabs, active, onChange, label }: { tabs: TabDef[]; active: string; onChange: (id: string) => void; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-selected={active === t.id} aria-controls={`panel-${t.id}`} className="tab" onClick={() => onChange(t.id)}>
          {t.label}
          {t.count != null && <span className="count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}
