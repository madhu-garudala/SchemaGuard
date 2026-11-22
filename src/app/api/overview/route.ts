import { respond } from "@/lib/http";
import { getOverview } from "@/lib/queries";

export const dynamic = "force-dynamic";
export const GET = () => respond(getOverview);
