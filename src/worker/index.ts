import { cfg, redact } from "../lib/config";
import { loadEnv } from "../lib/env";
import { closePool, q } from "../lib/db";
import { generateScenarios } from "../lib/generate";
import { openclawVersion } from "../lib/agents/openclaw";
import { beat, claim, complete, fail, heartbeat, requeueExpired, type Job } from "../lib/queue";
import { executeRun, LeaseLost } from "../lib/runner";

/**
 * The long-lived worker. It runs on the same host as OpenClaw, makes only outbound connections
 * (Postgres, the local Gateway), and is the only process that invokes agents, Git or the pipeline.
 */
loadEnv();
const c = cfg();
const WORKER_ID = `worker-${process.pid}`;
let stopping = false;
let active = 0;
let version: string | null = null;

const log = (msg: string) => console.log(`${new Date().toISOString()} [worker] ${redact(msg)}`);

async function handle(job: Job): Promise<void> {
  // Keep the lease alive during long steps (an agent turn can take a while).
  let lost = false;
  const keepAlive = setInterval(async () => {
    if (!(await heartbeat(job, c.leaseSeconds).catch(() => true))) lost = true;
  }, Math.max(2000, (c.leaseSeconds * 1000) / 3));
  const checkpoint = async () => {
    if (lost || !(await heartbeat(job, c.leaseSeconds))) throw new LeaseLost(`lease for job ${job.id} was taken over`);
  };
  try {
    let result: unknown = null;
    if (job.type === "run.execute") await executeRun(job.payload.run_id, { checkpoint });
    else if (job.type === "scenarios.generate") result = await generateScenarios(job.payload.batch_id, job.payload.seed);
    else throw Object.assign(new Error(`unknown job type ${job.type}`), { permanent: true });
    if (!(await complete(job, result))) log(`job ${job.id} finished but the lease had moved; result discarded`);
    else log(`job ${job.id} ${job.type} done`);
  } catch (err) {
    if (err instanceof LeaseLost) return log(err.message);
    const e = err as Error & { permanent?: boolean };
    const message = redact(e.message ?? String(err));
    const permanent = Boolean(e.permanent) || /unknown run|references a plan|is invalid/i.test(message);
    const state = await fail(job, message, !permanent);
    log(`job ${job.id} ${job.type} failed (${state}): ${message}`);
    if (state === "failed" && job.type === "run.execute") await q("UPDATE runs SET status='failed', error=$2, finished_at=now() WHERE id=$1", [job.payload.run_id, message.slice(0, 600)]);
  } finally {
    clearInterval(keepAlive);
  }
}

async function loop(): Promise<void> {
  version = await openclawVersion().catch(() => null);
  log(`started: agent mode ${c.agentMode}, model ${c.modelRef}, OpenClaw ${version ?? "not found"} (profile ${c.openclawProfile}), run concurrency ${c.runConcurrency}`);
  let lastBeat = 0;
  while (!stopping) {
    try {
      if (Date.now() - lastBeat > 2000) {
        await beat("worker", { worker_id: WORKER_ID, agent_mode: c.agentMode, model_ref: c.modelRef, openclaw_version: version, active });
        lastBeat = Date.now();
        for (const j of await requeueExpired()) {
          log(`job ${j.id} lease expired; ${j.status === "failed" ? "attempts exhausted" : "re-queued"}`);
          if (j.status === "failed" && j.type === "run.execute") await q("UPDATE runs SET status='failed', error='The worker stopped while this run was in progress and retries were exhausted.', finished_at=now() WHERE id=$1", [j.payload.run_id]);
        }
      }
      if (active < Math.max(1, c.runConcurrency)) {
        const job = await claim(c.leaseSeconds);
        if (job) {
          active++;
          log(`claimed job ${job.id} ${job.type} (attempt ${job.attempt})`);
          void handle(job).finally(() => active--);
          continue;
        }
      }
    } catch (err) {
      log(`loop error: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  while (active > 0) await new Promise((r) => setTimeout(r, 200));
  await closePool();
}

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => ((stopping = true), log(`${sig} received; finishing the current job`)));
void loop();
