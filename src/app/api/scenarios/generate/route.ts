import { jsonBody, respond } from "@/lib/http";
import { startGeneration } from "@/lib/queries";

export const dynamic = "force-dynamic";
export const POST = (req: Request) => respond(async () => startGeneration(await jsonBody(req)));
