import { NextResponse } from "next/server";
import { HttpError } from "./queries";

/** Wrap an API handler: JSON out, short and non-secret errors, never cached. */
export async function respond<T>(fn: () => Promise<T>): Promise<NextResponse> {
  try {
    return NextResponse.json(await fn(), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof HttpError) return NextResponse.json({ error: err.message }, { status: err.status });
    const e = err as { code?: string; message?: string };
    const db = e.code === "ECONNREFUSED" || /ECONNREFUSED|does not exist|connect/i.test(e.message ?? "");
    console.error("[api]", e.message);
    return NextResponse.json({ error: db ? "Database is not reachable or not migrated. Run `docker compose up -d db`, `npm run db:migrate` and `npm run db:seed`." : "Internal error" }, { status: db ? 503 : 500 });
  }
}

export async function jsonBody(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}
