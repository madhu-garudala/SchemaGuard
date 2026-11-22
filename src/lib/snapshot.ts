import type { CheckResult } from "./api-types";
import { q, q1, tx, type Db } from "./db";
import { BASELINE_AS_OF, baselineContract, baselineData, expectedBaseline } from "./fixtures";
import { ensureFixtureRepo, runPipelineRev, setEnvBranch } from "./fixture-repo";
import { diffCentMaps } from "./money";
import { validateRun } from "./replay";
import { SOURCES, type Contract, type Dataset, type Row, type SourceId } from "./types";

export interface EnvRow {
  id: string;
  label: string;
  kind: "main" | "sandbox";
  dataset: Dataset;
  active_contracts: Record<SourceId, number>;
  active_mapping_rev: string;
  baseline_rev: string;
  current_snapshot_id: string | null;
  current_revision: number;
  health: "healthy" | "at_risk" | "delayed";
  health_detail: string;
}

export const getEnv = (id: string, db?: Db) => q1<EnvRow>("SELECT * FROM environments WHERE id=$1", [id], db);

export async function activeContract(envId: string, source: SourceId, db?: Db): Promise<Contract> {
  const row = await q1<{ body: Contract }>("SELECT body FROM contracts WHERE env_id=$1 AND source=$2 AND status='active'", [envId, source], db);
  if (!row) throw new Error(`no active ${source} contract in ${envId}`);
  return row.body;
}

export interface BatchRow {
  id: string;
  source: SourceId;
  batch_id: string;
  seq: number;
  contract_version: number;
  rows: Row[];
  row_count: number;
  status: string;
}

export const latestAppliedBatches = async (envId: string, db?: Db): Promise<BatchRow[]> =>
  q<BatchRow>("SELECT DISTINCT ON (source) * FROM feed_batches WHERE env_id=$1 AND status='applied' ORDER BY source, seq DESC", [envId], db);

export interface RefreshResult {
  published: boolean;
  snapshot_id: string;
  revision: number;
  mapping_rev: string;
  contract_versions: Record<string, number>;
  checks: CheckResult[];
  first_failed_check: string | null;
  dashboards: Record<string, Record<string, string>> | null;
  reason: string | null;
}

/**
 * The normal refresh. It reads the ACTIVE contract versions and the ACTIVE mapping revision from the
 * database (so a restarted worker uses exactly what was activated), runs that revision of the
 * pipeline, stages a candidate snapshot, and only moves the current pointer if every deterministic
 * check passes. Pointer move and publication record share one transaction and are guarded by the
 * expected previous revision, so a delayed or duplicated refresh cannot overwrite a newer snapshot.
 */
export async function refreshAndPublish(opts: { envId: string; runId: string | null; dataAsOf: Date; expectedPrevRevision: number }): Promise<RefreshResult> {
  const env = await getEnv(opts.envId);
  if (!env) throw new Error(`unknown environment ${opts.envId}`);
  const batches = await latestAppliedBatches(opts.envId);
  const checks: CheckResult[] = [];
  const missing = SOURCES.filter((s) => !batches.some((b) => b.source === s));
  const stale = batches.filter((b) => b.contract_version !== env.active_contracts[b.source]);
  checks.push({ id: "input_versions", label: "Inputs match active contract versions", passed: missing.length === 0 && stale.length === 0, detail: missing.length ? `no applied batch for ${missing.join(", ")}` : stale.length ? stale.map((b) => `${b.source} batch is v${b.contract_version}, active contract is v${env.active_contracts[b.source]}`).join("; ") : SOURCES.map((s) => `${s} v${env.active_contracts[s]}`).join(", ") });

  let dashboards: RefreshResult["dashboards"] = null;
  if (checks[0].passed) {
    const input = Object.fromEntries(batches.map((b) => [b.source, b.rows])) as Record<SourceId, Row[]>;
    const result = await runPipelineRev(env.active_mapping_rev, input);
    checks.push(...validateRun(result).checks);
    if (result.ok) dashboards = result.output.dashboards;
  }
  const failed = checks.find((c) => !c.passed) ?? null;
  const revision = env.current_revision + 1;
  const finance = Object.fromEntries(Object.entries(dashboards?.finance ?? {}).filter(([k]) => k.startsWith("net_revenue_cents.")).map(([k, v]) => [k.split(".")[1], v]));
  const snap = await q1<{ id: string }>(
    `INSERT INTO snapshots (env_id, revision, status, data_as_of, contract_versions, mapping_rev, input_batches, totals, validation, run_id)
     VALUES ($1,$2,'candidate',$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [opts.envId, revision, opts.dataAsOf, JSON.stringify(env.active_contracts), env.active_mapping_rev, JSON.stringify(batches.map((b) => ({ source: b.source, batch_id: b.batch_id, seq: b.seq, contract_version: b.contract_version }))), JSON.stringify({ dashboards: dashboards ?? {}, finance_net_by_currency: finance }), JSON.stringify({ passed: !failed, checks }), opts.runId],
  );
  const base = { snapshot_id: snap!.id, revision, mapping_rev: env.active_mapping_rev, contract_versions: env.active_contracts, checks, dashboards };
  if (failed) {
    await q("UPDATE snapshots SET status='rejected' WHERE id=$1", [snap!.id]);
    return { ...base, published: false, first_failed_check: failed.id, reason: failed.detail };
  }
  const moved = await publishCandidate(opts.envId, snap!.id, opts.expectedPrevRevision);
  return { ...base, published: moved, first_failed_check: null, reason: moved ? null : `current revision is no longer ${opts.expectedPrevRevision}; a newer snapshot is already published` };
}

/** Atomically publish a staged candidate, provided the pointer still sits on the expected revision. */
export async function publishCandidate(envId: string, snapshotId: string, expectedPrevRevision: number): Promise<boolean> {
  return tx(async (db) => {
    const snap = await q1<{ revision: number; status: string }>("SELECT revision, status FROM snapshots WHERE id=$1 AND env_id=$2 FOR UPDATE", [snapshotId, envId], db);
    if (!snap || snap.status !== "candidate") return false;
    const moved = await q("UPDATE environments SET current_snapshot_id=$1, current_revision=$2, health='healthy', health_detail='' WHERE id=$3 AND current_revision=$4 AND $2 = $4 + 1 RETURNING id", [snapshotId, snap.revision, envId, expectedPrevRevision], db);
    if (moved.length === 0) {
      await q("UPDATE snapshots SET status='rejected', validation = validation || '{\"superseded\":true}'::jsonb WHERE id=$1", [snapshotId], db);
      return false;
    }
    await q("UPDATE snapshots SET status='published', published_at=now() WHERE id=$1", [snapshotId], db);
    return true;
  });
}

/**
 * Create an environment at the verified baseline: contracts v1, baseline batches, mapping at the
 * baseline commit, and snapshot revision 1 — which must equal the independent expected output.
 */
export async function createEnvironment(id: string, label: string, kind: "main" | "sandbox", dataset: Dataset): Promise<EnvRow> {
  const baseline = await ensureFixtureRepo();
  await q("DELETE FROM environments WHERE id=$1", [id]);
  await q("INSERT INTO environments (id,label,kind,dataset,active_contracts,active_mapping_rev,baseline_rev) VALUES ($1,$2,$3,$4,$5,$6,$6)", [id, label, kind, dataset, JSON.stringify({ orders: 1, payments: 1, shipping: 1 }), baseline]);
  const data = baselineData(dataset);
  for (const s of SOURCES) {
    await q("INSERT INTO contracts (env_id,source,version,status,body) VALUES ($1,$2,1,'active',$3)", [id, s, JSON.stringify(baselineContract(s))]);
    await q("INSERT INTO feed_batches (env_id,source,batch_id,seq,contract_version,rows,row_count,status,received_at) VALUES ($1,$2,$3,1,1,$4,$5,'applied',$6)", [id, s, `${s}-2026-03-01`, JSON.stringify(data[s]), data[s].length, BASELINE_AS_OF]);
  }
  await setEnvBranch(id, baseline);
  const r = await refreshAndPublish({ envId: id, runId: null, dataAsOf: new Date(BASELINE_AS_OF), expectedPrevRevision: 0 });
  if (!r.published) throw new Error(`baseline snapshot failed validation: ${r.reason}`);
  const flat = (d: Record<string, Record<string, string>>) => Object.fromEntries(Object.entries(d).flatMap(([a, m]) => Object.entries(m).map(([k, v]) => [`${a}.${k}`, v])));
  const drift = diffCentMaps(flat(expectedBaseline(dataset).dashboards), flat(r.dashboards!));
  if (drift.length) throw new Error(`baseline totals differ from the independent expected output: ${drift.join(", ")}`);
  return (await getEnv(id))!;
}
