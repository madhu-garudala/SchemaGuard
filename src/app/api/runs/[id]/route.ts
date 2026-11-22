import { respond } from "@/lib/http";
import { getRunDetail, HttpError } from "@/lib/queries";

export const dynamic = "force-dynamic";
export const GET = (_req: Request, ctx: { params: Promise<{ id: string }> }) =>
  respond(async () => {
    const { id } = await ctx.params;
    const run = /^run_[0-9a-f]{12}$/.test(id) ? await getRunDetail(id) : null;
    if (!run) throw new HttpError(404, "Run not found");
    return run;
  });
