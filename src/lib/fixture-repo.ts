import fs from "node:fs";
import path from "node:path";
import { cfg, ROOT } from "./config";
import { run } from "./proc";
import { applyOperations, type RepairOperation } from "./repair-ops";
import type { Mapping, PipelineResult, Row, SourceId } from "./types";

/**
 * The fixture pipeline lives in its own standalone Git repository under the runtime directory.
 * Repairs happen in run-specific worktrees of THAT repository; the Schema Guard application
 * repository and any other working tree on this machine are never touched.
 */
export const repoDir = () => path.join(cfg().runtimeDir, "fixture-repo");
const TEMPLATE = path.join(ROOT, "fixtures", "pipeline-template");
const REPAIRABLE = /^(mappings\/(orders|payments|shipping)\.json|samples\/payments\.sample\.json)$/;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Schema Guard",
  GIT_AUTHOR_EMAIL: "schema-guard@localhost",
  GIT_COMMITTER_NAME: "Schema Guard",
  GIT_COMMITTER_EMAIL: "schema-guard@localhost",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  // Fixed dates make every repair commit reproducible for a given tree and message.
  GIT_AUTHOR_DATE: "2026-03-02T06:00:00Z",
  GIT_COMMITTER_DATE: "2026-03-02T06:00:00Z",
};

export async function git(args: string[], cwd = repoDir()): Promise<string> {
  const r = await run("git", args, { cwd, env: GIT_ENV, timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`git ${args.slice(0, 3).join(" ")} failed: ${r.stderr.trim().slice(0, 400)}`);
  return r.stdout.trim();
}

/** Create the fixture repository from the checked-in template if needed. Returns the baseline commit. */
export async function ensureFixtureRepo(): Promise<string> {
  const dir = repoDir();
  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.mkdirSync(dir, { recursive: true });
    fs.cpSync(TEMPLATE, dir, { recursive: true });
    await git(["init", "-q", "-b", "main"]);
    await git(["add", "-A"]);
    await git(["commit", "-q", "-m", "Baseline pipeline and mappings"]);
    await git(["tag", "baseline"]);
  }
  return git(["rev-parse", "baseline"]);
}

/** A read-only checkout of an exact revision. Cached: a commit never changes. */
export async function revisionDir(sha: string): Promise<string> {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`not a commit sha: ${sha}`);
  const dir = path.join(cfg().runtimeDir, "revisions", sha);
  if (!fs.existsSync(path.join(dir, "run.mjs"))) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await git(["worktree", "prune"]);
    await git(["worktree", "add", "--detach", "-f", dir, sha]);
  }
  return dir;
}

export function readMappings(dir: string): Record<SourceId, Mapping> {
  const load = (s: string) => JSON.parse(fs.readFileSync(path.join(dir, "mappings", `${s}.json`), "utf8")) as Mapping;
  return { orders: load("orders"), payments: load("payments"), shipping: load("shipping") };
}

/** Run the repository's real transformations at a checkout. Optional mapping override is used for controls only. */
export async function runPipelineAt(dir: string, input: Record<SourceId, Row[]>, mappings?: Partial<Record<SourceId, Mapping>>): Promise<PipelineResult> {
  const r = await run(process.execPath, ["run.mjs"], { cwd: dir, input: JSON.stringify({ ...input, mappings }), timeoutMs: 30_000 });
  try {
    const parsed = JSON.parse(r.stdout);
    if (parsed.error) return { ok: false, error: parsed.error };
    return { ok: true, output: parsed };
  } catch {
    return { ok: false, error: { message: (r.stderr || "pipeline produced no output").slice(0, 400), step: "process" } };
  }
}

export const runPipelineRev = async (sha: string, input: Record<SourceId, Row[]>) => runPipelineAt(await revisionDir(sha), input);

export interface RepairWorktree {
  dir: string;
  branch: string;
  base_rev: string;
}

export async function createRepairWorktree(key: string, baseRev: string): Promise<RepairWorktree> {
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, "-");
  const dir = path.join(cfg().runtimeDir, "worktrees", safe);
  const branch = `repair/${safe}`;
  await removeWorktree(dir);
  await git(["branch", "-D", branch]).catch(() => {});
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(["worktree", "add", "-q", "-b", branch, dir, baseRev]);
  return { dir, branch, base_rev: baseRev };
}

export async function removeWorktree(dir: string): Promise<void> {
  if (fs.existsSync(dir)) await git(["worktree", "remove", "--force", dir]).catch(() => fs.rmSync(dir, { recursive: true, force: true }));
  await git(["worktree", "prune"]).catch(() => {});
}

/**
 * Apply typed operations inside a repair worktree, commit, and return the candidate revision and diff.
 * Only mapping files and the payments sample may change; anything else aborts.
 */
export async function applyRepair(wt: RepairWorktree, ops: RepairOperation[], opts: { candidateVersion: Record<string, number>; paymentsSample?: Row[]; message: string }): Promise<{ candidate_rev: string; diff: string }> {
  const repaired = applyOperations(readMappings(wt.dir), ops, opts.candidateVersion);
  for (const s of new Set(ops.map((o) => o.source))) fs.writeFileSync(path.join(wt.dir, "mappings", `${s}.json`), JSON.stringify(repaired[s], null, 2) + "\n");
  if (opts.paymentsSample)
    fs.writeFileSync(path.join(wt.dir, "samples", "payments.sample.json"), JSON.stringify({ contract_version: opts.candidateVersion.payments ?? 1, rows: opts.paymentsSample }, null, 2) + "\n");
  const changed = [...(await git(["diff", "--name-only"], wt.dir)).split("\n"), ...(await git(["ls-files", "--others", "--exclude-standard"], wt.dir)).split("\n")].filter(Boolean);
  const illegal = changed.filter((f) => !REPAIRABLE.test(f));
  if (illegal.length) throw new Error(`repair touched files outside the allowed set: ${illegal.join(", ")}`);
  if (changed.length === 0) throw new Error("repair produced no change");
  await git(["add", "-A"], wt.dir);
  await git(["commit", "-q", "-m", opts.message], wt.dir);
  const candidate_rev = await git(["rev-parse", "HEAD"], wt.dir);
  const diff = await git(["diff", "--no-color", `${wt.base_rev}..${candidate_rev}`, "--", "mappings"], wt.dir);
  return { candidate_rev, diff };
}

export async function runRepoTests(dir: string): Promise<{ passed: boolean; total: number; failed: number; output_excerpt: string }> {
  const r = await run(process.execPath, ["--test", "--test-reporter=tap", "test.mjs"], { cwd: dir, timeoutMs: 60_000 });
  const num = (label: string) => Number(new RegExp(`^# ${label} (\\d+)`, "m").exec(r.stdout)?.[1] ?? 0);
  const failed = num("fail");
  const total = num("tests");
  const lines = r.stdout.split("\n").filter((l) => /^(not ok|ok|# (tests|pass|fail))/.test(l.trim()) || /expected|actual|error:/i.test(l));
  return { passed: r.code === 0 && failed === 0 && total > 0, total, failed, output_excerpt: lines.slice(0, 30).join("\n").slice(0, 2000) };
}

/** Each environment tracks its active mapping on a branch; activation moves the branch to the tested commit. */
export const setEnvBranch = (envId: string, sha: string) => git(["update-ref", `refs/heads/env/${envId.replace(/[^a-zA-Z0-9_-]/g, "-")}`, sha]);

export async function isAncestor(ancestor: string, sha: string): Promise<boolean> {
  const r = await run("git", ["merge-base", "--is-ancestor", ancestor, sha], { cwd: repoDir(), env: GIT_ENV, timeoutMs: 10_000 });
  return r.code === 0;
}
