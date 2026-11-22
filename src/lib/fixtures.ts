import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config";
import type { Contract, Dataset, Row, SourceId } from "./types";

const read = <T>(rel: string): T => JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures", rel), "utf8")) as T;

export const baselineContract = (source: SourceId): Contract => read<Contract>(`contracts/${source}.v1.json`);
export const baselineData = (dataset: Dataset): Record<SourceId, Row[]> => read(`data/${dataset}.json`);
export const expectedBaseline = (dataset: Dataset) =>
  read<{ row_counts: Record<string, number>; payments_canonical: Record<string, string>; dashboards: Record<string, Record<string, string>> }>(`expected/${dataset}.json`);

export { lineage, type Lineage } from "./lineage-data";

/** Fixed simulation clock: every replay starts at the same instant. */
export const CYCLE_START = "2026-03-02T06:00:00.000Z";
export const BASELINE_AS_OF = "2026-03-01T23:59:59.000Z";
export const REFRESH_MIN = 180;
export const simTime = (offsetMin: number): Date => new Date(Date.parse(CYCLE_START) + offsetMin * 60_000);
