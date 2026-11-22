import type pg from "pg";
import { q, q1 } from "./db";

export interface Job {
  id: string;
  type: string;
  payload: any;
  status: "queued" | "running" | "done" | "failed";
  attempt: number;
  max_attempts: number;
  claim_token: string | null;
  lease_expires_at: Date | null;
  serial_key: string | null;
  last_error: string | null;
}

/** Enqueue once per logical operation: a repeated request with the same dedup key returns the existing job. */
export async function enqueue(type: string, payload: unknown, opts: { dedupKey: string; serialKey?: string | null; maxAttempts?: number }, db?: pg.PoolClient): Promise<string> {
  const row = await q1<{ id: string }>(
    `INSERT INTO jobs (type,payload,dedup_key,serial_key,max_attempts) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (dedup_key) DO NOTHING RETURNING id`,
    [type, JSON.stringify(payload), opts.dedupKey, opts.serialKey ?? null, opts.maxAttempts ?? 3],
    db,
  );
  return row?.id ?? (await q1<{ id: string }>("SELECT id FROM jobs WHERE dedup_key=$1", [opts.dedupKey], db))!.id;
}

/**
 * Claim the next runnable job in one statement. SKIP LOCKED lets several workers poll safely;
 * a job is skipped while another job with the same serial key is running, so runs that share a
 * fixture never overlap.
 */
export async function claim(leaseSeconds: number): Promise<Job | null> {
  return q1<Job>(
    `WITH next AS (
       SELECT j.id FROM jobs j
       WHERE j.status='queued' AND j.available_at <= now()
         AND (j.serial_key IS NULL OR NOT EXISTS (SELECT 1 FROM jobs r WHERE r.serial_key = j.serial_key AND r.status='running'))
       ORDER BY j.id
       FOR UPDATE SKIP LOCKED
       LIMIT 1)
     UPDATE jobs SET status='running', attempt=attempt+1, claim_token=gen_random_uuid(), lease_expires_at=now() + make_interval(secs => $1), updated_at=now()
     FROM next WHERE jobs.id = next.id RETURNING jobs.*`,
    [leaseSeconds],
  );
}

/** Extend the lease. False means this worker no longer owns the job and must stop. */
export async function heartbeat(job: Pick<Job, "id" | "claim_token">, leaseSeconds: number): Promise<boolean> {
  const rows = await q("UPDATE jobs SET lease_expires_at=now() + make_interval(secs => $3), updated_at=now() WHERE id=$1 AND claim_token=$2 AND status='running' RETURNING id", [job.id, job.claim_token, leaseSeconds]);
  return rows.length === 1;
}

/** Commit a result only if the claim token still matches: a worker whose lease was taken over cannot overwrite. */
export async function complete(job: Pick<Job, "id" | "claim_token">, result: unknown = null): Promise<boolean> {
  const rows = await q("UPDATE jobs SET status='done', result=$3, lease_expires_at=NULL, updated_at=now() WHERE id=$1 AND claim_token=$2 AND status='running' RETURNING id", [job.id, job.claim_token, JSON.stringify(result)]);
  return rows.length === 1;
}

export const backoffSeconds = (attempt: number) => Math.min(60, 2 ** attempt);

/** Transient failure: retry with backoff until attempts run out. Invalid input or configuration: fail now with the reason. */
export async function fail(job: Job, error: string, retryable: boolean): Promise<"retry" | "failed" | "lost"> {
  const final = !retryable || job.attempt >= job.max_attempts;
  const rows = await q(
    `UPDATE jobs SET status=$3, last_error=$4, claim_token=NULL, lease_expires_at=NULL, available_at=now() + make_interval(secs => $5), updated_at=now()
     WHERE id=$1 AND claim_token=$2 AND status='running' RETURNING id`,
    [job.id, job.claim_token, final ? "failed" : "queued", error.slice(0, 1000), final ? 0 : backoffSeconds(job.attempt)],
  );
  return rows.length === 0 ? "lost" : final ? "failed" : "retry";
}

/** Put abandoned work back on the queue (or fail it once attempts are exhausted). */
export async function requeueExpired(): Promise<Job[]> {
  return q<Job>(
    `UPDATE jobs SET status = CASE WHEN attempt >= max_attempts THEN 'failed' ELSE 'queued' END, claim_token=NULL, lease_expires_at=NULL,
       last_error='lease expired: the worker stopped or stalled', updated_at=now()
     WHERE status='running' AND lease_expires_at < now() RETURNING *`,
  );
}

export async function beat(workerId: string, info: Record<string, unknown>): Promise<void> {
  await q("INSERT INTO worker_heartbeat (id,last_beat,info) VALUES ($1, now(), $2) ON CONFLICT (id) DO UPDATE SET last_beat=now(), info=EXCLUDED.info", [workerId, JSON.stringify(info)]);
}
