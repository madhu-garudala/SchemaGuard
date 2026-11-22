import { jsonBody, respond } from "@/lib/http";
import { startRun } from "@/lib/queries";

export const dynamic = "force-dynamic";
export const POST = (req: Request) => respond(async () => startRun(await jsonBody(req)));
