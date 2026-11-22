"use client";

import Link from "next/link";
import type { AgentRunView, EventView, RunDetail, RunSummary, ScoreView, SnapshotView, Timings } from "@/lib/api-types";
import { formatDuration, formatMetric, formatMoney, humanize, shortSha } from "@/lib/format";
import { FixtureTag, Json, LiveTag, Mark, RunModeTags, RunState, Status, Time } from "./primitives";
import { withMock } from "./use-poll";

export function contractsLine(v: Record<string, number>): string {
  return Object.entries(v)
    .map(([k, n]) => `${k} v${n}`)
    .join(" · ");
}

export function financeLines(s: SnapshotView): { currency: string; minor: string }[] {
  return Object.entries(s.finance_net_by_currency).map(([currency, minor]) => ({ currency, minor }));
}

const PUBLISH: Record<RunDetail["publish_status"], { label: string; tone: "good" | "warn" | "bad" | "neutral" }> = {
  published: { label: "Published", tone: "good" },
  held: { label: "Held on previous snapshot", tone: "bad" },
  delayed: { label: "Delayed", tone: "warn" },
  pending: { label: "Pending", tone: "neutral" },
  unchanged: { label: "Unchanged", tone: "neutral" },
};

export function PublishStatus({ status }: { status: RunDetail["publish_status"] }) {
  const p = PUBLISH[status];
  return <Status tone={p.tone}>{p.label}</Status>;
}

/** Alert time, diagnosis time, time to verified repair, publish status, owner. */
export function StoryMetrics({ run }: { run: RunDetail }) {
  const t = run.timings;
  const owner = run.incidents[0]?.owner;
  const sim = (m: number | null | undefined) => (m == null ? null : `sim +${m} min`);
  return (
    <dl className="metrics">
      <div className="metric">
        <dt>Change to alert</dt>
        <dd>
          {formatDuration(t?.alert_ms)}
          <small>{sim(t?.sim.alert_min)}</small>
        </dd>
      </div>
      <div className="metric">
        <dt>Change to diagnosis</dt>
        <dd>
          {formatDuration(t?.diagnosis_ms)}
          <small>{sim(t?.sim.diagnosis_min)}</small>
        </dd>
      </div>
      <div className="metric">
        <dt>Change to verified repair</dt>
        <dd>
          {formatDuration(t?.verified_repair_ms)}
          <small>{sim(t?.sim.verified_repair_min)}</small>
        </dd>
      </div>
      <div className="metric">
        <dt>Publish</dt>
        <dd style={{ fontSize: 14 }}>
          <PublishStatus status={run.publish_status} />
          <small>{sim(t?.sim.publish_min)}</small>
        </dd>
      </div>
      <div className="metric">
        <dt>Owner of impacted feed</dt>
        <dd style={{ fontSize: 14 }}>
          {owner ? owner.name : "—"}
          <small>{owner?.contact}</small>
        </dd>
      </div>
    </dl>
  );
}

export function TimingsTable({ t }: { t: Timings }) {
  const rows: [string, number | null, string][] = [
    ["Queue wait", t.queue_ms, "Enqueued until the worker claimed the job"],
    ["Model", t.model_ms, "Agent turns, wall clock"],
    ["Tools", t.tool_ms, "Git worktree, diff and repository tests"],
    ["Replay", t.replay_ms, "Baseline and candidate pipeline runs plus reconciliation"],
    ["Total", t.total_ms, "Wall clock for the whole run; concurrent work is not double counted"],
  ];
  return (
    <div className="scroll">
      <table>
        <tbody>
          {rows.map(([k, v, note]) => (
            <tr key={k}>
              <td className="nowrap">{k}</td>
              <td className="r num nowrap">{formatDuration(v)}</td>
              <td className="muted">{note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SnapshotSide({ label, s }: { label: string; s: SnapshotView | null }) {
  return (
    <div>
      <div className="label">{label}</div>
      {s ? (
        <>
          {financeLines(s).map((f) => (
            <div key={f.currency} className="figure">
              {formatMoney(f.minor, f.currency)}
            </div>
          ))}
          <div className="figure-sub">Finance net revenue · revision {s.revision}</div>
          <dl className="kv">
            <dt>Data as of</dt>
            <dd>
              <Time iso={s.data_as_of} />
            </dd>
            <dt>Contracts</dt>
            <dd>{contractsLine(s.contract_versions)}</dd>
            <dt>Mapping</dt>
            <dd className="mono" title={s.mapping_rev}>
              {shortSha(s.mapping_rev)}
            </dd>
          </dl>
        </>
      ) : (
        <p className="empty" style={{ marginTop: 10 }}>
          No new snapshot was published.
        </p>
      )}
    </div>
  );
}

export function SnapshotCompare({ run }: { run: RunDetail }) {
  const { snapshot_before: b, snapshot_after: a } = run;
  let verdict: React.ReactNode = null;
  if (b && a) {
    const cur = Array.from(new Set([...Object.keys(b.finance_net_by_currency), ...Object.keys(a.finance_net_by_currency)]));
    const equal = cur.every((c) => b.finance_net_by_currency[c] === a.finance_net_by_currency[c]);
    verdict = equal ? (
      <Status tone="good">Finance totals are identical before and after, to the cent.</Status>
    ) : (
      <Status tone="bad">Finance totals differ between the two snapshots.</Status>
    );
  } else if (b && !a) {
    verdict =
      run.run.status === "completed" || run.run.status === "failed" ? (
        <Status tone="neutral">Nothing new was published. Revision {b.revision} is still what dashboards read.</Status>
      ) : (
        <Status tone="neutral" pulse>
          Run in progress. Dashboards keep reading revision {b.revision}.
        </Status>
      );
  }
  const metrics = a && b ? Object.keys(a.dashboards) : [];
  return (
    <div>
      <div className="compare">
        <SnapshotSide label="Before this run" s={b} />
        <SnapshotSide label="After this run" s={a} />
      </div>
      {verdict && (
        <p className="verdict" aria-live="polite">
          {verdict}
        </p>
      )}
      {a && b && metrics.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary>All dashboard metrics, before and after</summary>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Dashboard</th>
                  <th>Metric</th>
                  <th className="r">Before</th>
                  <th className="r">After</th>
                  <th>Same</th>
                </tr>
              </thead>
              <tbody>
                {metrics.flatMap((d) =>
                  Object.keys(a.dashboards[d] ?? {}).map((m) => {
                    const bv = b.dashboards[d]?.[m];
                    const av = a.dashboards[d][m];
                    return (
                      <tr key={`${d}.${m}`}>
                        <td>{humanize(d)}</td>
                        <td>{humanize(m)}</td>
                        <td className="r num">{bv == null ? "—" : formatMetric(m, bv)}</td>
                        <td className="r num">{formatMetric(m, av)}</td>
                        <td>{bv === av ? <Status tone="good">Yes</Status> : <Status tone="bad">No</Status>}</td>
                      </tr>
                    );
                  }),
                )}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

export function AgentRuns({ runs }: { runs: AgentRunView[] }) {
  if (!runs.length) return <p className="empty">No agent turns were needed for this run.</p>;
  return (
    <div>
      {runs.map((r) => (
        <div className="agent-run" key={r.id}>
          <div className="agent-head">
            <span className="who">{humanize(r.role)}</span>
            <code className="muted">{r.agent_id}</code>
            {r.mode === "fixture" ? <FixtureTag reason={r.fallback_reason} /> : <LiveTag provider={r.provider} model={r.model} />}
            {r.status === "ok" ? <Status tone="good">OK</Status> : <Status tone="bad">{r.error_category ? humanize(r.error_category) : "Error"}</Status>}
            <span className="muted num">{formatDuration(r.elapsed_ms)}</span>
            <span className="muted">attempt {r.attempt}</span>
            {r.usage?.total != null && <span className="muted num">{r.usage.total.toLocaleString()} tokens</span>}
          </div>
          <div className="small muted">
            {r.purpose}
            {r.session_key ? (
              <>
                {" "}
                · session <code>{r.session_key}</code>
              </>
            ) : null}
          </div>
          {r.error_message && <div className="small t-bad">{r.error_message}</div>}
          <details>
            <summary>Input and output excerpt (secrets redacted)</summary>
            <div className="io">
              <div>
                <div className="label">Input</div>
                <Json value={r.input_excerpt} />
              </div>
              <div>
                <div className="label">Output</div>
                <Json value={r.output_excerpt} />
              </div>
            </div>
          </details>
        </div>
      ))}
    </div>
  );
}

export function EventsTable({ events }: { events: EventView[] }) {
  if (!events.length) return <p className="empty">No events yet.</p>;
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>Event time (UTC)</th>
            <th>Type</th>
            <th>Source</th>
            <th>Status</th>
            <th>Correlation</th>
            <th>Payload</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id}>
              <td className="mono nowrap" title={`Received ${e.received_at}`}>
                {e.event_time.slice(11, 16)}
              </td>
              <td className="mono nowrap">{e.type}</td>
              <td>{e.source}</td>
              <td className="nowrap">
                <Status tone={e.status === "accepted" ? "good" : "neutral"}>{humanize(e.status)}</Status>
                {e.note && <div className="small muted">{e.note}</div>}
              </td>
              <td className="mono small" title={`Dedup key ${e.dedup_key}`}>
                {e.correlation_id}
              </td>
              <td style={{ minWidth: 180 }}>
                <details>
                  <summary>Show</summary>
                  <Json value={e.payload} />
                </details>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ScoreTable({ score }: { score: ScoreView }) {
  return (
    <div>
      <p style={{ marginBottom: 6 }}>
        <Status tone={score.matched === score.total ? "good" : "warn"}>
          {score.matched} of {score.total} expectations matched
        </Status>
        <span className="muted">
          {" "}
          · {score.verified_diagnosis ? "diagnosis counted as verified (evidence cited)" : "diagnosis not counted as verified"}
        </span>
      </p>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Field</th>
              <th>Expected</th>
              <th>Actual</th>
              <th>Match</th>
            </tr>
          </thead>
          <tbody>
            {score.items.map((it) => (
              <tr key={it.field}>
                <td>{humanize(it.field)}</td>
                <td className="mono">{it.expected}</td>
                <td className="mono">{it.actual}</td>
                <td>
                  <span className="nowrap">
                    <Mark tone={it.match ? "good" : "bad"} /> {it.match ? "Yes" : "No"}
                  </span>
                  {it.note && <div className="small muted">{it.note}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ScoreText({ score }: { score: RunSummary["score"] }) {
  if (!score) return <span className="faint">—</span>;
  return (
    <span className={`num ${score.matched === score.total ? "t-good" : "t-warn"}`} title="Scorer: expectations matched">
      {score.matched}/{score.total}
    </span>
  );
}

export function RunsTable({ runs }: { runs: RunSummary[] }) {
  if (!runs.length) return <p className="empty">No runs yet. Start the rehearsal above.</p>;
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th>Run</th>
            <th>Result</th>
            <th className="r">Score</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td>
                <Link className="row-link" href={withMock(`/runs/${r.id}`)}>
                  {r.title}
                </Link>
                <div className="small muted">
                  {r.catalog_title ?? (r.kind === "rehearsal" ? "Schema-change rehearsal" : "Generated scenario")}
                </div>
                <div className="small muted">
                  <Time iso={r.started_at ?? r.created_at} /> <RunModeTags run={r} />
                </div>
              </td>
              <td>
                <RunState run={r} />
              </td>
              <td className="r">
                <ScoreText score={r.score} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
