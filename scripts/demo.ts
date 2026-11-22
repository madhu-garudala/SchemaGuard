import { loadEnv } from "../src/lib/env";
import { closePool } from "../src/lib/db";
import { getRunDetail, startRun } from "../src/lib/queries";
import { centsToDecimal } from "../src/lib/money";

/**
 * Command-line version of the dashboard's primary button: enqueue the schema-change rehearsal
 * and print the result. Needs `npm run worker` running. Usage:
 *   npm run demo                 main rehearsal
 *   npm run demo -- --bad-repair rehearsal with a deliberately wrong repair
 *   npm run demo -- --case 3     replay a catalog case in a sandbox
 */
loadEnv();
const args = process.argv.slice(2);
const caseNo = args.includes("--case") ? Number(args[args.indexOf("--case") + 1]) : null;
const money = (m: Record<string, string> | undefined) => Object.entries(m ?? {}).map(([c, v]) => `${c} ${centsToDecimal(v)}`).join(", ");

async function main() {
  const { run_id } = await startRun(caseNo ? { kind: "scenario", plan_id: `catalog-${String(caseNo).padStart(2, "0")}` } : { kind: "rehearsal", fault: args.includes("--bad-repair") ? "bad_repair" : null });
  console.log(`Queued ${run_id}. Waiting for the worker...`);
  const deadline = Date.now() + 10 * 60_000;
  let seen = 0;
  for (;;) {
    const d = (await getRunDetail(run_id))!;
    for (const t of d.timeline.slice(seen)) console.log(`  ${t.sim_at.slice(11, 16)}  ${t.actor.padEnd(34).slice(0, 34)} ${t.title}`);
    seen = d.timeline.length;
    if (d.run.status === "completed" || d.run.status === "failed") {
      console.log(`\nStatus ${d.run.status}; outcome ${d.run.outcome ?? "-"}; publish ${d.publish_status}${d.error ? `; error: ${d.error}` : ""}`);
      console.log(`Finance before: r${d.snapshot_before?.revision} ${money(d.snapshot_before?.finance_net_by_currency)}`);
      console.log(`Finance now:    r${d.snapshot_current?.revision} ${money(d.snapshot_current?.finance_net_by_currency)}`);
      const repair = d.incidents.find((i) => i.repair?.diff)?.repair;
      if (repair?.diff) console.log(`\nRepair diff (${repair.base_rev?.slice(0, 7)} -> ${repair.candidate_rev?.slice(0, 7)}), replay ${repair.replay?.passed ? "passed" : `failed at ${repair.replay?.first_failed_check}`}:\n${repair.diff}`);
      console.log(`Agent turns: ${d.agent_runs.map((a) => `${a.role} ${a.mode === "fixture" ? "[Fixture mode]" : `[${a.provider}/${a.model}]`} ${a.status}${a.error_category ? `:${a.error_category}` : ""}`).join("; ") || "none"}`);
      if (d.score) console.log(`Score ${d.score.matched}/${d.score.total}`);
      break;
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for the worker; is `npm run worker` running?");
    await new Promise((r) => setTimeout(r, 700));
  }
}
main().catch((e) => ((process.exitCode = 1), console.error(e.message))).finally(closePool);
