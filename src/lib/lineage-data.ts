import data from "../../fixtures/lineage.json";

export interface Lineage {
  nodes: { id: string; kind: "feed" | "staging" | "fact" | "dashboard"; label: string; owner_team: string }[];
  edges: { from: string; to: string; column: string | null; grain: string | null; transform: string | null }[];
  dataset_impacts: Record<string, string[]>;
  column_impacts: Record<string, string[]>;
}

/** Statically bundled, so the dashboard needs no filesystem access to show lineage. */
export const lineage = (): Lineage => data as Lineage;
