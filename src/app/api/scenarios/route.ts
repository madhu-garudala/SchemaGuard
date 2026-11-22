import { respond } from "@/lib/http";
import { getScenarios } from "@/lib/queries";

export const dynamic = "force-dynamic";
export const GET = () => respond(getScenarios);
