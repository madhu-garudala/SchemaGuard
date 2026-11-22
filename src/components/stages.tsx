"use client";

import type { RunDetail } from "@/lib/api-types";
import { assetLabel, formatDuration, humanize, type Tone } from "@/lib/format";
import { Mark } from "./primitives";

type StageState = "done" | "failed" | "active" | "waiting" | "skipped";
interface Stage {
  name: string;
  state: StageState;
  line: string;
  time?: string | null;
}

const TONE: Record<StageState, Tone> = { done: "good", failed: "bad", active: "warn", waiting: "neutral", skipped: "neutral" };
const SR: Record<StageState, string> = { done: "done", failed: "failed", active: "in progress", waiting: "waiting", skipped: "not needed" };

/** The run reduced to the six things an owner wants to know, one short line each. */
export function stagesFor(d: RunDetail): Stage[] {
  const inc = d.incidents[0];
  const repair = inc?.repair ?? null;
  const finding = inc?.finding ?? null;
  const t = d.timings;
  const finished = d.run.status === "completed" || d.run.status === "failed";
  const running = d.run.status === "running";
  const proposed = d.events.find((e) => e.type === "source.change.proposed");
  const next = (reached: boolean): StageState => (reached ? "done" : finished ? "skipped" : running ? "waiting" : "waiting");

  const trigger: Stage = proposed
    ? { name: "Change proposed", state: "done", line: `${humanize(proposed.source)} contract change, not live yet` }
    : { name: "Feeds arriving", state: d.events.length ? "done" : next(false), line: d.events.length ? `${d.events.length} events received` : "Waiting for the first event" };

  const alert: Stage = inc
    ? { name: "Alert", state: "done", line: inc.affected_dashboards.length ? `${inc.affected_dashboards.map(assetLabel).join(", ")} at risk` : "Opened", time: formatDuration(t?.alert_ms) }
    : { name: "Alert", state: next(false), line: finished ? "Nothing at risk" : "None yet" };

  const diagnosis: Stage = finding
    ? { name: "Diagnosis", state: "done", line: `${humanize(finding.cause_status)}: ${humanize(finding.cause_category).toLowerCase()}`, time: formatDuration(t?.diagnosis_ms) }
    : { name: "Diagnosis", state: inc && !finished ? "active" : next(false), line: inc && !finished ? "Investigator working" : "Not needed" };

  let repairStage: Stage = { name: "Repair", state: finding && !finished && !repair ? "active" : next(false), line: finding && !finished ? "Repair agent working" : "Not needed" };
  if (repair) {
    if (repair.decision === "propose") repairStage = { name: "Repair", state: "done", line: repair.diff ? `${repair.operations.length} mapping ${repair.operations.length === 1 ? "change" : "changes"}, real diff` : `${repair.operations.length} proposed` };
    else if (repair.decision === "need_contract_fact") repairStage = { name: "Repair", state: "failed", line: "Needs a fact from the owner" };
    else if (repair.decision === "no_safe_repair") repairStage = { name: "Repair", state: "failed", line: "No safe repair exists" };
    else repairStage = { name: "Repair", state: "failed", line: "No proposal" };
  }

  let verify: Stage = { name: "Replay check", state: repair?.decision === "propose" && !finished ? "active" : next(false), line: repair?.decision === "propose" && !finished ? "Replaying the same records" : "Not needed" };
  if (repair?.replay || repair?.gate) {
    const gateOk = repair.gate?.passed ?? true;
    const replayOk = repair.replay?.passed ?? false;
    const failedCheck = repair.replay?.checks.find((c) => !c.passed)?.label;
    verify = gateOk && replayOk
      ? { name: "Replay check", state: "done", line: `${repair.replay!.checks.length} checks passed, totals identical`, time: formatDuration(t?.verified_repair_ms) }
      : { name: "Replay check", state: "failed", line: !gateOk ? (repair.gate!.required.some((g) => !g.present && g.kind !== "contradicted") ? "Contract leaves a fact undeclared" : "Repair conflicts with the contract") : `Failed: ${failedCheck ?? "replay"}` };
  }

  const rev = d.snapshot_after?.revision ?? d.snapshot_current?.revision;
  const publish: Stage =
    d.publish_status === "published"
      ? { name: "Publish", state: "done", line: `Revision ${rev} published` }
      : d.publish_status === "held"
        ? { name: "Publish", state: "failed", line: `Held on revision ${d.snapshot_before?.revision ?? rev}` }
        : d.publish_status === "delayed"
          ? { name: "Publish", state: "failed", line: `Delayed, revision ${d.snapshot_before?.revision ?? rev} kept` }
          : d.publish_status === "unchanged"
            ? { name: "Publish", state: "skipped", line: "Nothing new to publish" }
            : { name: "Publish", state: "waiting", line: "Waiting for the checks" };

  return [trigger, alert, diagnosis, repairStage, verify, publish];
}

export function Stages({ run }: { run: RunDetail }) {
  const stages = stagesFor(run);
  return (
    <ol className="stages" aria-label="Run progress">
      {stages.map((s) => (
        <li key={s.name} className={`stage stage-${s.state}`}>
          <div className="stage-head">
            <Mark tone={TONE[s.state]} pulse={s.state === "active"} />
            <span className="stage-name">{s.name}</span>
            <span className="sr-only">({SR[s.state]})</span>
          </div>
          <div className="stage-line">{s.line}</div>
          {s.time && s.time !== "—" && <div className="stage-time">{s.time}</div>}
        </li>
      ))}
    </ol>
  );
}
