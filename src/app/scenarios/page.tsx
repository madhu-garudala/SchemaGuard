"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { GenerateResponse, RunSummary, ScenariosView, StartRunRequest, StartRunResponse } from "@/lib/api-types";
import { OUTCOME_LABEL, humanize } from "@/lib/format";
import { WorkerOfflineNotice } from "@/components/chrome";
import { ApiError, FixtureTag, LiveTag, Loading, RunState, Section, Status, Time } from "@/components/primitives";
import { ScoreText } from "@/components/run-parts";
import { api, publishWorker, usePoll, withMock } from "@/components/use-poll";

function busy(v: ScenariosView | null): boolean {
  if (!v) return false;
  const g = v.generation?.status;
  if (g === "queued" || g === "running") return true;
  const live = (r: RunSummary | null) => r?.status === "queued" || r?.status === "running";
  return v.catalog.some((c) => live(c.last_run)) || v.generated.some((p) => live(p.last_run));
}

function LastRun({ run }: { run: RunSummary | null }) {
  if (!run) return <span className="faint">Not run yet</span>;
  return (
    <>
      <Link className="row-link" href={withMock(`/runs/${run.id}`)} style={{ fontWeight: 400 }}>
        <RunState run={run} />
      </Link>
      {run.used_fixture && (
        <div className="small">
          <FixtureTag />
        </div>
      )}
    </>
  );
}

const GEN_LABEL = { queued: "Queued", running: "Authors are writing plans", done: "Finished", failed: "Failed" } as const;

export default function ScenariosPage() {
  const router = useRouter();
  const { data: v, error, loading, stale, refresh } = usePoll<ScenariosView>("/api/scenarios", (d) => (busy(d) ? 1500 : 10_000));
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (v) publishWorker(v.worker);
    else if (error) publishWorker(null, true);
  }, [v, error]);

  const replay = async (plan_id: string) => {
    setPending(plan_id);
    setActionError(null);
    try {
      const body: StartRunRequest = { kind: "scenario", plan_id };
      const res = await api<StartRunResponse>("/api/runs", { method: "POST", body });
      router.push(withMock(`/runs/${res.run_id}`));
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
      setPending(null);
    }
  };

  const generate = async () => {
    setPending("generate");
    setActionError(null);
    try {
      await api<GenerateResponse>("/api/scenarios/generate", { method: "POST", body: {} });
      refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(null);
    }
  };

  if (!v) {
    return (
      <>
        <h1 className="h-page" style={{ marginBottom: 16 }}>
          Scenarios
        </h1>
        <ApiError error={error} />
        {loading && <Loading what="the scenario catalog" />}
      </>
    );
  }

  const gen = v.generation;
  const generating = gen?.status === "queued" || gen?.status === "running";
  const accepted = v.generated.filter((p) => p.status === "accepted").length;

  return (
    <>
      <h1 className="h-page">Scenarios</h1>
      <p className="lede" style={{ margin: "6px 0 20px" }}>
        Each replay runs in its own sandbox from the same baseline, so results are reproducible.
      </p>
      <ApiError error={error} stale={stale} />
      <WorkerOfflineNotice online={v.worker.online} seconds={v.worker.seconds_since_heartbeat} />
      <div aria-live="polite">
        {actionError && (
          <div className="notice notice-bad" role="alert">
            {actionError}
          </div>
        )}
      </div>

      <div className="stack">
        <Section title="Twenty-case catalog" aside="Deterministic seeds for regression">
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th className="r">#</th>
                  <th>Case</th>
                  <th>Team</th>
                  <th>Expected outcome</th>
                  <th>Last run</th>
                  <th>Score</th>
                  <th>
                    <span className="sr-only">Replay</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {v.catalog.map((c) => (
                  <tr key={c.plan_id}>
                    <td className="r num muted">{c.case_no}</td>
                    <td style={{ minWidth: 240 }}>
                      <details>
                        <summary>
                          <b style={{ color: "var(--ink)" }}>{c.title}</b> {c.quick && <span className="tag" title="One of the three quickest cases to try first">Quick</span>}
                        </summary>
                        <div className="small muted" style={{ marginTop: 4 }}>{c.summary}</div>
                      </details>
                    </td>
                    <td className="nowrap">{humanize(c.team)}</td>
                    <td>{OUTCOME_LABEL[c.expected_outcome]}</td>
                    <td>
                      <LastRun run={c.last_run} />
                    </td>
                    <td>
                      <ScoreText score={c.last_run?.score ?? null} />
                    </td>
                    <td className="r">
                      <button type="button" className="btn btn-sm" disabled={pending != null} onClick={() => replay(c.plan_id)} aria-label={`Replay case ${c.case_no}: ${c.title}`}>
                        {pending === c.plan_id ? "Starting…" : "Replay"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section
          title="Generated by the scenario-author agents"
          aside={v.generated.length ? `${accepted} accepted, ${v.generated.length - accepted} invalid` : undefined}
        >
          <div className="actions" style={{ marginBottom: 10 }}>
            <button type="button" className="btn" onClick={generate} disabled={pending != null || generating}>
              {generating ? "Generating…" : "Generate scenarios"}
            </button>
            <span aria-live="polite" className="small">
              {gen ? (
                <>
                  <Status tone={gen.status === "done" ? "good" : gen.status === "failed" ? "bad" : "neutral"} pulse={generating}>
                    {GEN_LABEL[gen.status]}
                  </Status>
                  <span className="muted">
                    {" "}
                    · batch <code>{gen.batch_id}</code> · seed <code>{gen.seed}</code> · <Time iso={gen.created_at} mode="time" />
                    {gen.error ? ` · ${gen.error}` : ""}
                  </span>
                </>
              ) : (
                <span className="muted">The Orders, Payments and Shipping authors each write a plan, up to three at a time.</span>
              )}
            </span>
          </div>

          {v.generated.length ? (
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th>Plan</th>
                    <th>Author</th>
                    <th className="r">Seed</th>
                    <th>Validation</th>
                    <th>Last run</th>
                    <th>
                      <span className="sr-only">Replay</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {v.generated.map((p) => (
                    <tr key={p.id}>
                      <td style={{ minWidth: 220 }}>
                        <b>{p.title ?? "Untitled plan"}</b>
                        <div className="small muted">
                          <code>{p.id}</code>
                          {p.mutation_summary ? ` · ${p.mutation_summary}` : ""}
                          {p.event_count ? ` · ${p.event_count} events` : ""}
                        </div>
                      </td>
                      <td>
                        {humanize(p.author_role)}
                        <div className="small">
                          <code className="muted">{p.agent_id}</code>
                        </div>
                        <div className="small">{p.mode === "fixture" ? <FixtureTag /> : <LiveTag model={p.model} />}</div>
                      </td>
                      <td className="r mono">{p.seed}</td>
                      <td style={{ minWidth: 200 }}>
                        {p.status === "accepted" ? <Status tone="good">Accepted</Status> : <Status tone="bad">Invalid</Status>}
                        <span className="muted small"> · attempt {p.attempt}</span>
                        {p.reasons.length > 0 && (
                          <ul className="reasons">
                            {p.reasons.map((r, i) => (
                              <li key={i}>{r}</li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td>{p.status === "accepted" ? <LastRun run={p.last_run} /> : <span className="faint">—</span>}</td>
                      <td className="r">
                        {p.status === "accepted" && (
                          <button type="button" className="btn btn-sm" disabled={pending != null} onClick={() => replay(p.id)} aria-label={`Replay generated plan ${p.title ?? p.id}`}>
                            {pending === p.id ? "Starting…" : "Replay"}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty">No generated plans yet. Invalid plans stay listed here with the reason they were rejected.</p>
          )}
        </Section>
      </div>
    </>
  );
}
