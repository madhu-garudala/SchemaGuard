"use client";

import type { CheckResult, FindingView, IncidentView, RepairView, TimelineEntry } from "@/lib/api-types";
import { assetLabel, humanize, incidentLabel, incidentTone, shortSha, simClock, type Tone } from "@/lib/format";
import { EvidenceIds, Json, Mark, Status, Time } from "./primitives";

/** Titles first; each step's detail and evidence open on demand. */
export function Timeline({ entries, linkEvidence = true }: { entries: TimelineEntry[]; linkEvidence?: boolean }) {
  if (!entries.length) return <p className="empty">Nothing recorded yet.</p>;
  return (
    <ol className="timeline compact">
      {entries.map((e) => (
        <li key={e.key}>
          <div className="tl-time">
            <Time iso={e.at} mode="time" />
            <small title="Simulated clock (UTC)">sim {simClock(e.sim_at)}</small>
          </div>
          <div className="tl-mark">
            <Mark tone={e.tone} />
          </div>
          <div>
            <div className="tl-actor">{e.actor}</div>
            {e.detail || e.evidence_ids.length ? (
              <details className="tl-entry">
                <summary>
                  <span className="tl-title">{e.title}</span>
                </summary>
                {e.detail && <div className="tl-detail">{e.detail}</div>}
                <EvidenceIds ids={e.evidence_ids} link={linkEvidence} />
              </details>
            ) : (
              <div className="tl-title">{e.title}</div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function DiffView({ diff }: { diff: string }) {
  const lines = diff.replace(/\n$/, "").split("\n");
  return (
    <div className="code diff" role="region" aria-label="Repair diff" tabIndex={0}>
      {lines.map((line, i) => {
        const meta = /^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line);
        const kind = meta ? "meta" : line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
        const sign = kind === "add" ? "+" : kind === "del" ? "−" : " ";
        const body = kind === "add" || kind === "del" || (kind === "ctx" && line.startsWith(" ")) ? line.slice(1) : line;
        return (
          <div key={i} className={kind}>
            <span className="sign" aria-hidden="true">
              {sign}
            </span>
            <span>
              {(kind === "add" || kind === "del") && <span className="sr-only">{kind === "add" ? "added: " : "removed: "}</span>}
              {body || " "}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function SampleTable({ rows }: { rows: Record<string, unknown>[] }) {
  const cols = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
  return (
    <div className="scroll" style={{ marginTop: 6 }}>
      <table className="compact">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c}>{humanize(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c}>{r[c] == null ? "—" : typeof r[c] === "object" ? JSON.stringify(r[c]) : String(r[c])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Checks({ checks, firstFailed }: { checks: CheckResult[]; firstFailed: string | null }) {
  return (
    <ol className="checks">
      {checks.map((c) => {
        const first = !c.passed && c.id === firstFailed;
        return (
          <li key={c.id} className={first ? "first-fail" : undefined}>
            <span className="mark">
              <Mark tone={c.passed ? "good" : "bad"} />
            </span>
            <div>
              <div className="check-label">
                <span className="sr-only">{c.passed ? "Passed: " : "Failed: "}</span>
                {c.label}
                {first && <span className="t-bad"> — first failed check</span>}
                {!c.passed && !first && <span className="t-bad"> — failed</span>}
              </div>
              <div className="check-detail">{c.detail}</div>
              {c.sample && c.sample.length > 0 && <SampleTable rows={c.sample} />}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function FindingBlock({ f, linkEvidence = true }: { f: FindingView; linkEvidence?: boolean }) {
  return (
    <div className="block">
      <h4 className="h-sub">
        Diagnosis <span className="tag">{f.source === "agent" ? "Investigator agent" : "Deterministic fallback"}</span>{" "}
        {!f.valid && <span className="tag t-bad">Rejected</span>}
      </h4>
      <p>
        <Status tone={f.cause_status === "confirmed" ? "good" : f.cause_status === "likely" ? "warn" : "neutral"}>Cause {f.cause_status}</Status>
        <span className="muted"> · </span>
        <code>{f.cause_category}</code>
      </p>
      <p>{f.candidate_cause}</p>
      {f.observed_facts.length > 0 && (
        <ul className="facts">
          {f.observed_facts.map((o, i) => (
            <li key={i}>
              {o.statement}
              <EvidenceIds ids={o.evidence_ids} link={linkEvidence} />
            </li>
          ))}
        </ul>
      )}
      {f.validation_errors.length > 0 && (
        <ul className="reasons" style={{ marginTop: 6 }}>
          {f.validation_errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      {f.next_verification_step && (
        <p className="muted small" style={{ marginTop: 6 }}>
          Next verification step: {f.next_verification_step}
        </p>
      )}
    </div>
  );
}

const REPAIR_STATUS: Record<RepairView["status"], { label: string; tone: Tone }> = {
  verified: { label: "Repair verified", tone: "good" },
  failed: { label: "Repair failed verification", tone: "bad" },
  blocked: { label: "Repair blocked", tone: "warn" },
  not_needed: { label: "No repair needed", tone: "neutral" },
  pending: { label: "Repair in progress", tone: "neutral" },
};

const DECISION: Record<RepairView["decision"], string> = {
  propose: "Agent proposed a typed mapping change",
  need_contract_fact: "Agent asked for a missing contract fact",
  no_safe_repair: "Agent found no safe downstream repair",
  not_attempted: "No agent proposal",
};

function opArgs(op: { op: string; [k: string]: unknown }): string {
  return Object.entries(op)
    .filter(([k]) => k !== "op")
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join("  ");
}

function RepairBlock({ r }: { r: RepairView }) {
  const st = REPAIR_STATUS[r.status];
  return (
    <div className="block">
      <h4 className="h-sub">Repair</h4>
      <p>
        <Status tone={st.tone}>{st.label}</Status>
        <span className="muted"> · {DECISION[r.decision]}</span>
      </p>

      {r.operations.length > 0 && (
        <ul className="oplist" style={{ marginTop: 6 }}>
          {r.operations.map((op, i) => (
            <li key={i}>
              <b>{op.op}</b> <span className="muted">{opArgs(op)}</span>
            </li>
          ))}
        </ul>
      )}
      {r.question_for_owner && (
        <p style={{ marginTop: 8 }}>
          <span className="label">Question for the owning team</span>
          <br />
          {r.question_for_owner}
        </p>
      )}
      {r.missing_facts.length > 0 && (
        <ul className="facts">
          {r.missing_facts.map((m, i) => (
            <li key={i}>Missing: {m}</li>
          ))}
        </ul>
      )}

      {r.gate && (
        <div className="block">
          <h4 className="h-sub">Contract assertions</h4>
          <p className="small muted">
            {r.gate.passed
              ? "Every unit, key and meaning the repair relies on is declared by the producer."
              : r.gate.required.some((g) => !g.present && g.kind !== "contradicted")
                ? "Activation is blocked. Matching samples cannot establish a contract the producer has not declared."
                : "Activation is blocked. The repair conflicts with what the producer declared."}
          </p>
          <ol className="checks">
            {r.gate.required.map((g, i) => (
              <li key={i}>
                <span className="mark">
                  <Mark tone={g.present ? "good" : "bad"} />
                </span>
                <div>
                  <div className="check-label">
                    <span className="sr-only">{g.present ? "Declared: " : g.kind === "contradicted" ? "Conflicts: " : "Missing: "}</span>
                    {g.assertion}
                    {!g.present && <span className="t-bad"> — {g.kind === "contradicted" ? "conflicts with the proposed contract" : "not declared"}</span>}
                  </div>
                  <div className="check-detail">{g.detail}</div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {r.diff && (
        <div className="block">
          <h4 className="h-sub">
            Diff{" "}
            <span className="muted mono" style={{ fontWeight: 400 }}>
              {shortSha(r.base_rev)} → {shortSha(r.candidate_rev)}
              {r.branch ? ` on ${r.branch}` : ""}
            </span>
          </h4>
          <DiffView diff={r.diff} />
        </div>
      )}

      {r.repo_tests && (
        <div className="block">
          <h4 className="h-sub">Repository tests</h4>
          <p>
            <Status tone={r.repo_tests.passed ? "good" : "bad"}>
              {r.repo_tests.total - r.repo_tests.failed} of {r.repo_tests.total} passed
            </Status>
          </p>
          {r.repo_tests.output_excerpt && (
            <details>
              <summary>Test output</summary>
              <pre className="code">{r.repo_tests.output_excerpt}</pre>
            </details>
          )}
        </div>
      )}

      {r.replay && (
        <div className="block">
          <h4 className="h-sub">Replay on the same logical records</h4>
          <p style={{ marginBottom: 4 }}>
            <Status tone={r.replay.passed ? "good" : "bad"}>
              {r.replay.passed ? "All checks passed" : "Replay failed — the previous snapshot stays active"}
            </Status>
          </p>
          <Checks checks={r.replay.checks} firstFailed={r.replay.first_failed_check} />
        </div>
      )}

      {(r.assumptions.length > 0 || r.expected_invariants.length > 0) && (
        <details className="block">
          <summary>Assumptions and expected invariants</summary>
          <ul className="facts">
            {r.assumptions.map((a, i) => (
              <li key={`a${i}`}>Assumes: {a}</li>
            ))}
            {r.expected_invariants.map((a, i) => (
              <li key={`i${i}`}>Invariant: {a}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** The in-app alert. One incident row is updated in place as diagnosis and repair progress. */
/** linkEvidence: set false on pages that have no evidence list for the anchors to point at. */
export function Incident({ incident: i, depth = "full", linkEvidence = true }: { incident: IncidentView; depth?: "summary" | "full"; linkEvidence?: boolean }) {
  const tone = incidentTone(i);
  const future = i.risk_kind === "future_change";
  return (
    <article className={`incident t-edge-${tone}`} aria-label={i.title}>
      <div className="incident-meta">
        <Status tone={tone}>{incidentLabel(i)}</Status>
        <span>{future ? "Future change, not live yet" : "Affects data arriving now"}</span>
        <span>Severity {i.severity}</span>
        <span>
          Updated <Time iso={i.updated_at} mode="time" />
        </span>
      </div>
      <h3 className="incident-title">{i.title}</h3>
      <p>{i.what_breaks}</p>

      <dl className="kv">
        <dt>Cause</dt>
        <dd>
          {i.cause_status ? (
            <>
              <b>{humanize(i.cause_status)}</b>
              {i.cause_text ? ` — ${i.cause_text}` : ""}
            </>
          ) : (
            <span className="muted">Not diagnosed yet</span>
          )}
        </dd>
        <dt>Affected dashboards</dt>
        <dd>{i.affected_dashboards.length ? i.affected_dashboards.map(assetLabel).join(", ") : "None"}</dd>
        <dt>Owner</dt>
        <dd>
          {i.owner.name} <span className="muted">· {i.owner.contact}</span>
        </dd>
        <dt>Published data</dt>
        <dd>
          Revision {i.freshness.snapshot_revision}, as of <Time iso={i.freshness.data_as_of} />
          <span className="muted">
            {" "}
            · {i.freshness.label === "healthy" ? "current numbers unaffected" : i.freshness.label === "delayed" ? "delayed" : "at risk"}
          </span>
        </dd>
        <dt>Verified fix</dt>
        <dd>{i.has_verified_fix ? <Status tone="good">Yes, replay-verified</Status> : <Status tone="neutral">Not yet</Status>}</dd>
        <dt>Next action</dt>
        <dd>{i.next_action}</dd>
        {i.evidence_ids.length > 0 && (
          <>
            <dt>Evidence</dt>
            <dd>
              <EvidenceIds ids={i.evidence_ids} link={depth === "full" && linkEvidence} />
            </dd>
          </>
        )}
      </dl>

      {depth === "full" && i.finding && <FindingBlock f={i.finding} linkEvidence={linkEvidence} />}
      {depth === "full" && i.repair && <RepairBlock r={i.repair} />}

      {i.history.length > 0 && (
        <details className="block">
          <summary>Alert history ({i.history.length} updates to this incident)</summary>
          <div className="scroll">
            <table>
              <tbody>
                {i.history.map((h, n) => (
                  <tr key={n}>
                    <td className="nowrap">
                      <Time iso={h.at} mode="time" />
                    </td>
                    <td className="nowrap">{humanize(h.status)}</td>
                    <td>{h.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </article>
  );
}

/** One line per alert; the full incident lives on the run page. */
export function AlertRows({ incidents, href }: { incidents: IncidentView[]; href?: (i: IncidentView) => string }) {
  return (
    <ul className="rows">
      {incidents.map((i) => (
        <li key={i.id}>
          <Status tone={incidentTone(i)}>{incidentLabel(i)}</Status>
          <div className="row-main">
            <div className="row-title">{i.title}</div>
            <div className="row-sub">
              {i.affected_dashboards.length ? `${i.affected_dashboards.map(assetLabel).join(", ")} · ` : ""}
              {i.owner.name}
              {i.has_verified_fix ? " · fix verified by replay" : ""}
            </div>
          </div>
          {href ? <a href={href(i)}>Details</a> : <span />}
        </li>
      ))}
    </ul>
  );
}

export function EvidenceList({ items }: { items: { id: string; kind: string; title: string; body: unknown }[] }) {
  if (!items.length) return <p className="empty">No evidence was collected for this run.</p>;
  return (
    <ul>
      {items.map((e) => (
        <li key={e.id} id={`ev-${e.id}`} style={{ padding: "5px 0", borderBottom: "1px solid var(--rule)" }}>
          <details>
            <summary>
              <code>{e.id}</code>
              <span style={{ color: "var(--ink)" }}>{e.title}</span>
              <span className="faint">{e.kind}</span>
            </summary>
            <Json value={e.body} />
          </details>
        </li>
      ))}
    </ul>
  );
}
