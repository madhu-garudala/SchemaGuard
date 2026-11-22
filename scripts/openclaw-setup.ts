import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { cfg, redact, ROOT } from "../src/lib/config";
import { loadEnv } from "../src/lib/env";
import { run } from "../src/lib/proc";

/**
 * Idempotent OpenClaw setup for Schema Guard, isolated in its own profile (~/.openclaw-<profile>)
 * so personal agents, sessions and defaults under ~/.openclaw are never modified.
 *  - installs the Cerebras provider plugin into the profile if it is absent
 *  - registers the model and the five role agents, each with a dedicated workspace
 *  - references secrets as ${ENV} placeholders; no key is ever written to the profile config
 */
loadEnv();
const c = cfg();
const oc = (args: string[], input?: string) => run(c.openclawBin, ["--profile", c.openclawProfile, "--no-color", ...args], { timeoutMs: 180_000, input, env: process.env });
const home = path.join(os.homedir(), `.openclaw-${c.openclawProfile}`);

async function main() {
  if (!fs.existsSync(c.openclawBin)) throw new Error(`OpenClaw CLI not found at ${c.openclawBin}. Set OPENCLAW_BIN in .env.local.`);
  console.log((await run(c.openclawBin, ["--version"], { timeoutMs: 20_000 })).stdout.trim());
  if (!process.env.CEREBRAS_API_KEY) throw new Error("CEREBRAS_API_KEY is not set in .env.local");
  if (!process.env.OPENCLAW_GATEWAY_TOKEN) {
    const token = crypto.randomBytes(24).toString("hex");
    fs.appendFileSync(path.join(ROOT, ".env.local"), `${fs.readFileSync(path.join(ROOT, ".env.local"), "utf8").endsWith("\n") ? "" : "\n"}OPENCLAW_GATEWAY_TOKEN=${token}\n`);
    process.env.OPENCLAW_GATEWAY_TOKEN = token;
    console.log("Generated OPENCLAW_GATEWAY_TOKEN in .env.local (gitignored).");
  }
  if (!fs.existsSync(path.join(home, "extensions", "cerebras"))) {
    console.log("Installing @openclaw/cerebras-provider into the profile...");
    const r = await oc(["plugins", "install", "@openclaw/cerebras-provider", "--accept-capabilities"]);
    if (r.code !== 0) throw new Error(`plugin install failed: ${redact(r.stderr || r.stdout).slice(-400)}`);
  } else console.log("Cerebras provider plugin already installed in the profile.");

  const [provider, ...rest] = c.modelRef.split("/");
  const modelId = rest.join("/");
  const entries: Record<string, unknown> = {};
  for (const id of Object.values(c.agents)) {
    const workspace = path.join(home, "workspaces", id);
    fs.mkdirSync(workspace, { recursive: true });
    const template = path.join(ROOT, "openclaw", "workspaces", id, "AGENTS.md");
    if (!fs.existsSync(template)) throw new Error(`missing workspace template ${template}`);
    fs.copyFileSync(template, path.join(workspace, "AGENTS.md"));
    // Roles answer from a bounded evidence packet: minimal tool profile, no skills.
    entries[id] = { name: fs.readFileSync(template, "utf8").split("\n")[0].replace(/^#\s*/, ""), workspace, model: c.modelRef, tools: { profile: "minimal" }, skills: [] };
  }
  const patch = {
    gateway: { mode: "local", bind: "loopback", port: c.gatewayPort, auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" } },
    models: { mode: "merge", providers: { [provider]: { baseUrl: "https://api.cerebras.ai/v1", apiKey: "${CEREBRAS_API_KEY}", api: "openai-completions", models: [{ id: modelId, name: "Kimi K3.1 Pro (Cerebras)" }, { id: "gpt-oss-120b", name: "GPT OSS 120B (Cerebras)" }] } } },
    agents: { defaults: { model: c.modelRef }, entries },
  };
  const r = await oc(["config", "patch", "--stdin"], JSON.stringify(patch));
  if (r.code !== 0) throw new Error(`config patch failed: ${redact(r.stderr || r.stdout).slice(-600)}`);
  const v = await oc(["config", "validate"]);
  console.log(redact(v.stdout.trim() || v.stderr.trim()));
  const text = fs.readFileSync(path.join(home, "openclaw.json"), "utf8");
  if (text.includes(process.env.CEREBRAS_API_KEY!) || text.includes(process.env.OPENCLAW_GATEWAY_TOKEN!)) throw new Error("a secret value was written to the profile config; aborting");
  console.log(`Profile ${c.openclawProfile}: ${Object.keys(entries).length} role agents on ${c.modelRef}, gateway on 127.0.0.1:${c.gatewayPort}. No secrets in ${path.join(home, "openclaw.json")}.`);
  console.log("Next: npm run openclaw:gateway   (then: npm run live:check)");
}
main().catch((e) => ((process.exitCode = 1), console.error(`Setup failed: ${redact(e.message)}`)));
