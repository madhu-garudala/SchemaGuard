"use client";

import type { Overview } from "@/lib/api-types";

const COLS: { kind: Overview["lineage"]["nodes"][number]["kind"]; label: string }[] = [
  { kind: "feed", label: "Team feeds" },
  { kind: "staging", label: "Staging" },
  { kind: "fact", label: "Facts" },
  { kind: "dashboard", label: "Dashboards" },
];
const W = 640;
const NODE_W = 124;
const NODE_H = 26;
const ROW = 40;
const TOP = 26;

/** Feeds → staging → facts → dashboards. Affected assets carry a heavier outline and a text marker, not colour alone. */
export function Lineage({ lineage, affected, resolved }: { lineage: Overview["lineage"]; affected: string[]; resolved: boolean }) {
  const hit = new Set(affected);
  const pos = new Map<string, { x: number; y: number }>();
  const gap = (W - NODE_W * COLS.length) / (COLS.length - 1);
  let maxRows = 1;
  COLS.forEach((c, ci) => {
    const nodes = lineage.nodes.filter((n) => n.kind === c.kind);
    maxRows = Math.max(maxRows, nodes.length);
    nodes.forEach((n, ri) => pos.set(n.id, { x: ci * (NODE_W + gap), y: TOP + ri * ROW }));
  });
  const H = TOP + maxRows * ROW;
  const hitCount = lineage.nodes.filter((n) => hit.has(n.id)).length;

  return (
    <figure>
      <div className="scroll">
        <svg className={`lineage${resolved ? " resolved" : ""}`} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Data lineage from team feeds to dashboards">
          {COLS.map((c, ci) => (
            <text key={c.kind} className="col-label" x={ci * (NODE_W + gap)} y={11}>
              {c.label}
            </text>
          ))}
          {lineage.edges.map((e, i) => {
            const a = pos.get(e.from);
            const b = pos.get(e.to);
            if (!a || !b) return null;
            const x1 = a.x + NODE_W;
            const y1 = a.y + NODE_H / 2;
            const x2 = b.x;
            const y2 = b.y + NODE_H / 2;
            const mx = (x1 + x2) / 2;
            const on = hit.has(e.from) && hit.has(e.to);
            return (
              <path key={i} className={on ? "hit" : undefined} d={`M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`}>
                <title>{[`${e.from} → ${e.to}`, e.column && `column ${e.column}`, e.grain && `grain ${e.grain}`, e.transform].filter(Boolean).join(" · ")}</title>
              </path>
            );
          })}
          {lineage.nodes.map((n) => {
            const p = pos.get(n.id);
            if (!p) return null;
            const on = hit.has(n.id);
            return (
              <g key={n.id} className={on ? "hit" : undefined}>
                <title>{`${n.label} · owned by ${n.owner_team}${on ? " · affected" : ""}`}</title>
                <rect x={p.x + 0.5} y={p.y + 0.5} width={NODE_W - 1} height={NODE_H - 1} rx="3" />
                <text x={p.x + 9} y={p.y + NODE_H / 2 + 4}>
                  {on ? "▲ " : ""}
                  {n.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <figcaption className="small muted" style={{ marginTop: 6 }}>
        {hitCount === 0
          ? "No assets are affected by an open change."
          : resolved
            ? `${hitCount} assets were in the path of the latest change (marked ▲). The verified repair covers them.`
            : `${hitCount} assets are in the path of the latest change (marked ▲).`}
      </figcaption>
    </figure>
  );
}
