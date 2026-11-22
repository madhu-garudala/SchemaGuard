import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { cfg } from "../src/lib/config";
import { loadEnv } from "../src/lib/env";
import { gatewayLogPath } from "../src/lib/agents/openclaw";

/**
 * Run the Schema Guard OpenClaw Gateway in the foreground: loopback only, own profile, own port.
 * Secrets come from .env.local through this process's environment. Output is written to
 * .runtime/openclaw-gateway.log, which the worker reads to classify provider errors quickly.
 */
loadEnv();
const c = cfg();
fs.mkdirSync(path.dirname(gatewayLogPath()), { recursive: true });
const log = fs.createWriteStream(gatewayLogPath(), { flags: "a" });
const child = spawn(c.openclawBin, ["--profile", c.openclawProfile, "--no-color", "gateway", "run", "--port", String(c.gatewayPort), "--bind", "loopback"], { env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
console.log(`OpenClaw Gateway (profile ${c.openclawProfile}) starting on ws://127.0.0.1:${c.gatewayPort}; log: ${path.relative(process.cwd(), gatewayLogPath())}`);
let ready = false;
const onData = (b: Buffer) => {
  log.write(b);
  if (!ready && /runtime-post-bind/i.test(b.toString())) {
    ready = true;
    console.log("Gateway is up. Leave this running; Ctrl-C stops it.");
  }
};
child.stdout.on("data", onData);
child.stderr.on("data", onData);
child.on("exit", (code) => {
  console.log(`Gateway exited with code ${code}. See the log for details.`);
  process.exit(code ?? 1);
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
