import { respond } from "@/lib/http";
import { workerView } from "@/lib/queries";

export const dynamic = "force-dynamic";
export const GET = () => respond(async () => ({ ok: true, worker: await workerView() }));
