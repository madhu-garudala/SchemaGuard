import { spawn } from "node:child_process";

export interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  elapsedMs: number;
}

/**
 * Run a subprocess with an argument array (never a shell string), bounded output and a hard timeout.
 * `abort` lets a caller stop the process early.
 */
export function run(
  bin: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number; maxBytes?: number; abort?: AbortSignal } = {},
): Promise<ProcResult> {
  const max = opts.maxBytes ?? 4 * 1024 * 1024;
  const started = Date.now();
  return new Promise((resolve) => {
    // Own process group, so a timeout also stops any helpers the child started.
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    const cap = (cur: string, chunk: Buffer) => (cur.length >= max ? cur : cur + chunk.toString("utf8").slice(0, max - cur.length));
    child.stdout.on("data", (c: Buffer) => (stdout = cap(stdout, c)));
    child.stderr.on("data", (c: Buffer) => (stderr = cap(stderr, c)));
    const signal = (sig: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, sig);
      } catch {
        child.kill(sig);
      }
    };
    let killTimer: NodeJS.Timeout | null = null;
    let exitTimer: NodeJS.Timeout | null = null;
    const kill = () => {
      signal("SIGTERM");
      killTimer ??= setTimeout(() => signal("SIGKILL"), 2000);
      killTimer.unref();
    };
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, opts.timeoutMs)
      : null;
    const onAbort = () => {
      aborted = true;
      kill();
    };
    opts.abort?.addEventListener("abort", onAbort, { once: true });
    if (opts.abort?.aborted) onAbort();
    let settled = false;
    const done = (code: number | null, extra = "") => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (exitTimer) clearTimeout(exitTimer);
      // Once the child is gone its process-group id can be reused; never signal it later.
      if (killTimer && code !== null) clearTimeout(killTimer);
      opts.abort?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr: stderr + extra, timedOut, aborted, elapsedMs: Date.now() - started });
    };
    child.on("error", (err) => done(null, `\nspawn error: ${err.message}`));
    child.on("close", (code) => done(code));
    // A helper process can keep the pipes open after the child exits; do not wait for it.
    child.on("exit", (code) => {
      exitTimer = setTimeout(() => done(code), 250);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input ?? "");
  });
}
