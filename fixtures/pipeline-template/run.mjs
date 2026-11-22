// Entry point: reads {orders, payments, shipping, mappings?} as JSON on stdin and
// writes the pipeline result as JSON on stdout. BigInt values are serialized as strings.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runPipeline } from "./transform.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(readFileSync(path.join(here, "mappings", `${name}.json`), "utf8"));

const input = JSON.parse(readFileSync(0, "utf8"));
const mappings = { orders: load("orders"), payments: load("payments"), shipping: load("shipping"), ...(input.mappings ?? {}) };
try {
  const result = runPipeline(input, mappings);
  process.stdout.write(JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
} catch (err) {
  process.stdout.write(JSON.stringify({ error: { message: String(err.message), step: err.step ?? "unknown" } }));
  process.exitCode = 3;
}
