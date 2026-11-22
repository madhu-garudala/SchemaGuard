import { NextResponse } from "next/server";
import { redact } from "./config";
import { HttpError } from "./queries";

/** Wrap an API handler: JSON out, short and non-secret errors, never cached. */
export async function respond<T>(fn: () => Promise<T>): Promise<NextResponse> {
  try {
    return NextResponse.json(await fn(), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof HttpError) return NextResponse.json({ error: err.message }, { status: err.status });
    const e = err as { code?: string; message?: string };
    // Connection refused, undefined table (not migrated) or unknown database.
    const db = ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "42P01", "3D000", "57P03"].includes(e.code ?? "") || /ECONNREFUSED/.test(e.message ?? "");
    console.error("[api]", redact(e.message ?? String(err)));
    return NextResponse.json({ error: db ? "Database is not reachable or not migrated. Run `docker compose up -d db`, `npm run db:migrate` and `npm run db:seed`." : "Internal error" }, { status: db ? 503 : 500 });
  }
}

export async function jsonBody(req: Request): Promise<any> {
  const text = await req.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
}
