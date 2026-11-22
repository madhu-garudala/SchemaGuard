"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { IncidentView, Overview, StartRunRequest, StartRunResponse } from "@/lib/api-types";
import { HEALTH_LABEL, HEALTH_TONE, assetLabel, incidentLabel, incidentTone, isOpenIncident, shortSha } from "@/lib/format";
import { WorkerOfflineNotice } from "@/components/chrome";
import { Incident, Timeline } from "@/components/incident";
import { Lineage } from "@/components/lineage";
import { ApiError, Loading, RunModeTags, RunState, Section, Status, Time } from "@/components/primitives";
import { RunsTable, StoryMetrics, contractsLine, financeLines } from "@/components/run-parts";
import { api, publishWorker, usePoll, withMock } from "@/components/use-poll";
import { formatMoney } from "@/lib/format";

function runIsActive(o: Overview | null): boolean {
  if (!o) return false;
  const s = o.latest_main_run?.run.status;
  return o.active_run_id != null || s === "queued" || s === "running";
}

function PublishedNow({ o }: { o: Overview }) {
  const s = o.snapshot;
  return (
    <div className="statement">
      <div className="label">Published now</div>
      {s ? (
        <>
          {financeLines(s).map((f) => (
            <div className="figure" key={f.currency}>
              {formatMoney(f.minor, f.currency)}
            </div>
          ))}
          <div className="figure-sub">Finance net revenue · snapshot revision {s.revision}</div>
        </>
      ) : (
        <p className="empty" style={{ marginTop: 10 }}>
          No snapshot has been published. Run <code>npm run db:seed</code>.
        </p>
      )}
      <p style={{ marginTop: 12 }} aria-live="polite">
        <Status tone={HEALTH_TONE[o.env.health]}>Current data: {HEALTH_LABEL[o.env.health]}</Status>
        {o.env.health_detail ? <span className="muted"> — {o.env.health_detail}</span> : <span className="muted"> — the published snapshot passed every deterministic check</span>}
      </p>
      {s && (
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
      )}
    </div>
  );
}

function ChangeRisk({ o }: { o: Overview }) {
  const open = o.alerts.filter(isOpenIncident);
  const future = open.filter((a) => a.risk_kind === "future_change");
  const current = open.filter((a) => a.risk_kind === "current_data");
  const focus: IncidentView | undefined = future[0] ?? current[0];
  const lastClosed = o.latest_main_run?.incidents.find((i) => !isOpenIncident(i));

  let body: React.ReactNode;
  if (focus) {
    const isFuture = focus.risk_kind === "future_change";
    body = (
      <>
        <p style={{ marginTop: 8 }} aria-live="polite">
          <Status tone={incidentTone(focus)}>{incidentLabel(focus)}</Status>
        </p>
        <h2 className="risk-title">{focus.title}</h2>
        <p>{focus.what_breaks}</p>
        <dl className="kv">
          <dt>Would break</dt>
          <dd>{focus.affected_dashboards.length ? focus.affected_dashboards.map(assetLabel).join(", ") : "No dashboards"}</dd>
          <dt>Owner</dt>
          <dd>
            {focus.owner.name} <span className="muted">· {focus.owner.contact}</span>
          </dd>
          <dt>Verified fix</dt>
          <dd>{focus.has_verified_fix ? <Status tone="good">Yes, replay-verified</Status> : <Status tone="neutral">Not yet</Status>}</dd>
          <dt>Published numbers</dt>
          <dd>{isFuture ? "Unaffected. The change is not live, and it cannot go live without passing replay." : "The last verified snapshot stays visible."}</dd>
        </dl>
        {open.length > 1 && <p className="small muted" style={{ marginTop: 8 }}>{open.length - 1} more open below.</p>}
      </>
    );
  } else if (lastClosed) {
    body = (
      <>
        <p style={{ marginTop: 8 }}>
          <Status tone="good">No open change risk</Status>
        </p>
        <h2 className="risk-title">Last change: {lastClosed.title}</h2>
        <dl className="kv">
          <dt>Result</dt>
          <dd>
            <Status tone={incidentTone(lastClosed)}>{incidentLabel(lastClosed)}</Status>
          </dd>
          <dt>Would have broken</dt>
          <dd>{lastClosed.affected_dashboards.length ? lastClosed.affected_dashboards.map(assetLabel).join(", ") : "No dashboards"}</dd>
          <dt>Owner</dt>
          <dd>
            {lastClosed.owner.name} <span className="muted">· {lastClosed.owner.contact}</span>
          </dd>
          <dt>Verified fix</dt>
          <dd>{lastClosed.has_verified_fix ? <Status tone="good">Yes, replay-verified</Status> : <Status tone="neutral">None needed or none found</Status>}</dd>
        </dl>
      </>
    );
  } else {
    body = (
      <>
        <p style={{ marginTop: 8 }}>
          <Status tone="neutral">No upstream changes pending</Status>
        </p>
        <p className="muted" style={{ marginTop: 6, maxWidth: "46ch" }}>
          When a source team proposes a contract change, it is compared, traced to dashboards and rehearsed here before it can affect the published numbers.
        </p>
      </>
    );
  }
  return (
    <div className="statement">
      <div className="label">Upcoming change risk</div>
      {body}
    </div>
  );
}

export default function OverviewPage() {
  const { data: o, error, loading, stale, refresh } = usePoll<Overview>("/api/overview", (d) => (runIsActive(d) ? 1500 : 10_000));
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [queuedId, setQueuedId] = useState<string | null>(null);

  useEffect(() => {
    if (o) publishWorker(o.worker);
    else if (error) publishWorker(null, true);
  }, [o, error]);

  const start = async (fault: StartRunRequest["fault"]) => {
    setStarting(true);
    setStartError(null);
    try {
      const body: StartRunRequest = { kind: "rehearsal", fault };
      const res = await api<StartRunResponse>("/api/runs", { method: "POST", body });
      setQueuedId(res.run_id);
      refresh();
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  if (!o) {
    return (
      <>
        <h1 className="sr-only">Overview</h1>
        <ApiError error={error} />
        {loading && <Loading what="the current snapshot" />}
      </>
    );
  }

  const active = runIsActive(o);
  const story = o.latest_main_run;
  const focusIncident = story?.incidents[0] ?? o.alerts[0];
  const affected = focusIncident ? [...focusIncident.affected_assets, ...focusIncident.affected_dashboards, `feed.${focusIncident.source}`] : [];
  const pendingQueued = queuedId != null && story?.run.status === "queued" && !o.worker.online;

  return (
    <>
      <h1 className="sr-only">Overview</h1>
      <ApiError error={error} stale={stale} />
      <WorkerOfflineNotice online={o.worker.online} seconds={o.worker.seconds_since_heartbeat} />

      <div className="statements">
        <PublishedNow o={o} />
        <ChangeRisk o={o} />
      </div>

      <div className="cta">
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={() => start(null)} disabled={starting || active}>
            {!active ? "Run schema-change rehearsal" : story?.run.status === "queued" || story?.run.status === "running" ? "Rehearsal running…" : "Another run in progress…"}
          </button>
          <button type="button" className="btn btn-quiet" onClick={() => start("bad_repair")} disabled={starting || active}>
            Replay with a deliberately wrong repair
          </button>
        </div>
        <p className="hint">
          Simulates a Payments pull request that replaces <code>payment_amount</code> (dollars) with <code>amount_cents</code> (integer cents), before it is
          active. Each rehearsal runs in a fresh environment that starts from the baseline snapshot, so the result is reproducible.
        </p>
        <div aria-live="polite">
          {startError && <p className="t-bad" style={{ marginTop: 6 }}>Could not start the run: {startError}</p>}
          {pendingQueued && <p className="t-warn" style={{ marginTop: 6 }}>Run {queuedId} is queued. It starts when the worker comes online.</p>}
        </div>
      </div>

      <div className="cols">
        <div className="stack">
          <Section
            title={story ? "Latest rehearsal" : "Rehearsal"}
            aside={
              story && (
                <>
                  <Link href={withMock(`/runs/${story.run.id}`)}>Full run detail</Link>
                </>
              )
            }
          >
            {story ? (
              <>
                <p style={{ marginBottom: 14 }}>
                  <b>{story.run.title}</b>
                  {story.run.catalog_title ? <span className="muted"> · {story.run.catalog_title}</span> : null}
                  <br />
                  <RunState run={story.run} /> <RunModeTags run={story.run} />
                </p>
                <StoryMetrics run={story} />
                {story.error && (
                  <div className="notice notice-bad" role="alert">
                    {story.error}
                  </div>
                )}
                <Timeline entries={story.timeline} linkEvidence={false} />
              </>
            ) : (
              <p className="empty">
                No rehearsal has run yet. The button above proposes the Payments change, has the investigator and repair agents work on it, and replays the
                same records to prove the Finance total holds.
              </p>
            )}
          </Section>

          <Section title="Alerts" aside={o.alerts.length ? `${o.alerts.filter(isOpenIncident).length} open of ${o.alerts.length}` : undefined}>
            {o.alerts.length ? (
              o.alerts.map((a) => <Incident key={a.id} incident={a} depth={story && a.run_id === story.run.id ? "full" : "summary"} linkEvidence={false} />)
            ) : (
              <p className="empty">No alerts. An alert opens when a proposed change or an arriving batch puts a dashboard at risk.</p>
            )}
          </Section>

          <Section title="Lineage">
            <Lineage lineage={o.lineage} affected={affected} resolved={focusIncident ? !isOpenIncident(focusIncident) || focusIncident.has_verified_fix : false} />
          </Section>
        </div>

        <div className="stack">
          <Section title="Source teams">
            <ul className="sources">
              {o.sources.map((s) => (
                <li key={s.id}>
                  <div className="source-head">
                    <span className="source-name">{s.id.charAt(0).toUpperCase() + s.id.slice(1)}</span>
                    <span className="mono muted">
                      contract v{s.contract_version} · {s.field_count} fields
                    </span>
                  </div>
                  <div className="small muted">
                    {s.owner.name} · {s.owner.contact}
                  </div>
                  <div className="small">
                    {s.last_batch ? (
                      <>
                        Last batch <code>{s.last_batch.batch_id}</code>, {s.last_batch.row_count} rows, {s.last_batch.status},{" "}
                        <Time iso={s.last_batch.received_at} mode="time" />
                      </>
                    ) : (
                      <span className="muted">No batch received</span>
                    )}
                  </div>
                  <div className="small muted">
                    Feeds {s.feeds_dashboards.map(assetLabel).join(", ")} · due by +{s.delivery.hard_deadline_min} min
                  </div>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Recent runs" aside={<Link href={withMock("/scenarios")}>Scenario catalog</Link>}>
            <RunsTable runs={o.recent_runs} />
          </Section>
        </div>
      </div>
    </>
  );
}
