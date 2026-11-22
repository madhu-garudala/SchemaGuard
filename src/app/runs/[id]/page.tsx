"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import type { RunDetail } from "@/lib/api-types";
import { HEALTH_LABEL, HEALTH_TONE, formatDuration } from "@/lib/format";
import { EvidenceList, Incident, Timeline } from "@/components/incident";
import { ApiError, Loading, RunModeTags, RunState, Section, Status, Time } from "@/components/primitives";
import { AgentRuns, EventsTable, ScoreTable, SnapshotCompare, StoryMetrics, TimingsTable } from "@/components/run-parts";
import { usePoll, withMock } from "@/components/use-poll";

const done = (d: RunDetail | null) => d != null && (d.run.status === "completed" || d.run.status === "failed");

export default function RunPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  // Poll quickly while the run is active, then stop for good once it has finished.
  const { data: d, error, loading, stale } = usePoll<RunDetail>(id ? `/api/runs/${encodeURIComponent(id)}` : null, (cur) => (done(cur) ? null : 1500));

  if (!d) {
    return (
      <>
        <p className="crumb">
          <Link href="/">Overview</Link> / Run
        </p>
        <h1 className="h-page" style={{ margin: "6px 0 16px" }}>
          Run {id}
        </h1>
        <ApiError error={error} />
        {loading && <Loading what="the run" />}
      </>
    );
  }

  const { run } = d;
  return (
    <>
      <p className="crumb">
        <Link href={withMock("/")}>Overview</Link> / <Link href={withMock("/scenarios")}>Scenarios</Link> / <span className="mono">{run.id}</span>
      </p>
      <h1 className="h-page" style={{ marginTop: 6 }}>
        {run.title}
      </h1>
      {run.catalog_title && (
        <p className="lede">
          {run.case_no != null ? `Case ${run.case_no}: ` : ""}
          {run.catalog_title}
        </p>
      )}
      <div className="run-head" aria-live="polite">
        <RunState run={run} />
        <RunModeTags run={run} />
        <span className="muted">agents requested: {run.agent_mode}</span>
        <span className="muted">
          {d.env.kind === "main" ? "Main demo environment" : d.env.label} ·{" "}
          <Status tone={HEALTH_TONE[d.env.health]}>current data {HEALTH_LABEL[d.env.health].toLowerCase()}</Status>
        </span>
        <span className="muted">
          Started <Time iso={run.started_at ?? run.created_at} />
          {d.timings?.total_ms != null ? ` · ${formatDuration(d.timings.total_ms)}` : ""}
        </span>
      </div>

      <div style={{ marginTop: 20 }}>
        <ApiError error={error} stale={stale} />
        {d.error && (
          <div className="notice notice-bad" role="alert">
            <strong>Run error.</strong> {d.error}
          </div>
        )}
      </div>

      <div className="stack" style={{ marginTop: 8 }}>
        <Section title="Published numbers, before and after" aside={d.env.health_detail}>
          <SnapshotCompare run={d} />
        </Section>

        <Section title="Milestones">
          <StoryMetrics run={d} />
        </Section>

        <div className="cols" style={{ marginTop: 36 }}>
          <div className="stack">
            <Section title="Incidents" aside={`${d.incidents.length} for this run`}>
              {d.incidents.length ? (
                d.incidents.map((i) => <Incident key={i.id} incident={i} />)
              ) : (
                <p className="empty">This run opened no incident. Nothing put a dashboard at risk.</p>
              )}
            </Section>

            <Section title="Agent turns" aside="Run through OpenClaw unless labelled Fixture mode">
              <AgentRuns runs={d.agent_runs} />
            </Section>

            <Section title="Evidence" aside="IDs cited by the investigator are checked against this list">
              <EvidenceList items={d.evidence} />
            </Section>
          </div>

          <div className="stack">
            <Section title="Timeline">
              <Timeline entries={d.timeline} />
            </Section>

            {d.timings && (
              <Section title="Where the time went">
                <TimingsTable t={d.timings} />
              </Section>
            )}

            {d.score && (
              <Section title="Scorer" aside="Compared with the private answer key after the run">
                <ScoreTable score={d.score} />
              </Section>
            )}
          </div>
        </div>

        <Section title="Events" aside={`${d.events.length} received`}>
          <EventsTable events={d.events} />
        </Section>
      </div>
    </>
  );
}
