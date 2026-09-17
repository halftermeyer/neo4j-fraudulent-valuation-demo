// Shared NVL graph canvas. Progressive reveal + community colouring are done by
// the callers: they decide which nodes to pass and which colour/grey to give
// them (DATA_PLAN: manage visual complexity by reveal, not by dropping entities).
//
// NVL does not restart its force simulation when elements are added through the
// React wrapper, so newly added nodes stack at the origin until the user drags
// one. Two counter-measures here: new nodes get a deterministic scattered seed
// position, and setLayout(ForceDirectedLayoutType) is re-applied whenever the
// NODE SET changes (colour-only updates keep the current layout).

import type { NVL, Node as NvlNode, Relationship as NvlRel } from "@neo4j-nvl/base";
import { d3ForceLayoutType } from "@neo4j-nvl/base";
import { InteractiveNvlWrapper } from "@neo4j-nvl/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { captureCypher } from "../lib/companion";
import { runQuery, withGroup } from "../lib/neo4j";
import { ExplainButton } from "./CompanionPanel";

export const TYPE_COLORS: Record<string, string> = {
  Position: "#0b297d",
  Instrument: "#006fd6",
  MarketPrice: "#8fb4e8",
  ValuationMethodology: "#00b4d8",
  MethodologyChange: "#7a3fbf",
  PriceOverride: "#d9480f",
  IPVReview: "#0f766e",
  MAPReview: "#0f9960",
  PnLSignal: "#c2255c",
  Control: "#5c7cfa",
  Approval: "#2f9e44",
  Escalation: "#e8590c",
  Evidence: "#868e96",
  Incident: "#a1160a",
  RootCause: "#862e9c",
  CorrectiveAction: "#3b5bdb",
  Person: "#f08c00",
  Desk: "#9c36b5",
  Committee: "#c05621",
  Policy: "#495057",
  ControlObligation: "#1864ab",
  GovernanceGap: "#e03131",
  RiskAttribute: "#0ca678",
  Pattern: "#5f3dc4",
  RegimeBreak: "#343a40",
  Curve: "#adb5bd",
};

export const GREY = "#ccd4e0";

export interface GNode {
  id: string;
  label: string; // primary node label, drives colour
  caption?: string;
  color?: string; // override (e.g. community colour)
  size?: number;
  grey?: boolean;
}

export interface GRel {
  id: string;
  from: string;
  to: string;
  type?: string;
  grey?: boolean;
}

// ── node inspector (click any node in any view → detailed panel) ─────────────

interface RelSummary {
  type: string;
  dir: "out" | "in";
  count: number;
  sample: string[];
}

interface NodeDetails {
  id: string;
  labels: string[];
  props: Record<string, unknown>;
  rels: RelSummary[];
  cypher: string;
}

// property display order: the story-critical fields first, citations last
const PROP_ORDER = [
  "name", "at", "sourceAt", "description", "outcome", "status", "severity",
  "amountUsdM", "reportedUsdM", "estimatedMidUsdM", "lossUsdM", "divergenceBps",
  "divergenceUsdM", "deviationBps", "pctOfBidAsk", "unexplainedPct", "consecutiveDays",
  "kind", "formal", "effectiveAt", "role", "type", "actorRole", "confidence",
];
const PROP_HIDE = new Set([
  "id", "positionId", "datePrecision", "seq", "synthetic",
  "communityId", // GDS write-back artifact — shown as colour in S1, noise as a property
]);

function fmtValue(k: string, v: unknown): string {
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 16).replace("T", " ");
  if (k === "unexplainedPct" && typeof v === "number") return `${(v * 100).toFixed(1)}%`;
  return s.length > 220 ? s.slice(0, 220) + "…" : s;
}

async function fetchNodeDetails(id: string): Promise<NodeDetails | null> {
  const { result, cypher } = await captureCypher(() => withGroup(`Inspect node ${id}`, async () => {
    const rows = await runQuery<{
      labels: string[];
      props: Record<string, unknown>;
      rels: (RelSummary | null)[];
    }>(
      `MATCH (n) WHERE n.id = $id
       WITH n LIMIT 1
       OPTIONAL MATCH (n)-[r]-(m)
       WITH n, type(r) AS relType,
            CASE WHEN r IS NULL THEN null WHEN startNode(r) = n THEN 'out' ELSE 'in' END AS dir,
            count(*) AS cnt,
            collect(coalesce(m.name, m.id))[..4] AS sample
       RETURN [l IN labels(n) WHERE l <> 'Event'] AS labels, properties(n) AS props,
              collect(CASE WHEN relType IS NULL THEN null
                           ELSE {type: relType, dir: dir, count: cnt, sample: sample} END) AS rels`,
      { id },
    );
    const r = rows[0];
    return r ?? null;
  }));
  if (!result) return null;
  return {
    id,
    labels: result.labels,
    props: result.props,
    rels: (result.rels.filter(Boolean) as RelSummary[]).sort((a, b) => b.count - a.count),
    cypher,
  };
}

function NodeInspector({ details, onClose }: { details: NodeDetails; onClose: () => void }) {
  const keys = Object.keys(details.props).filter(
    (k) => !PROP_HIDE.has(k) && details.props[k] !== null && details.props[k] !== "",
  );
  keys.sort((a, b) => {
    const ia = PROP_ORDER.indexOf(a);
    const ib = PROP_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });
  const citation = details.props["sourceRef"];
  const label = details.labels[0] ?? "Node";
  return (
    <div className="node-inspector">
      <div className="node-inspector-head">
        <span className="pill pill-info" style={{ background: TYPE_COLORS[label] ?? "#5a6b85", color: "#fff" }}>
          {label}
        </span>
        <code>{details.id}</code>
        <ExplainButton
          payload={() => ({
            scene: "explore",
            selectionId: details.id,
            title: `${label} ${details.id}`,
            rows: { properties: details.props, neighbourhood: details.rels },
            cypher: details.cypher,
          })}
          small
        />
        <button className="node-inspector-close" onClick={onClose}>✕</button>
      </div>
      <table className="node-inspector-props">
        <tbody>
          {keys.filter((k) => k !== "sourceRef").map((k) => (
            <tr key={k}>
              <td>{k}</td>
              <td>{fmtValue(k, details.props[k])}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {details.rels.length > 0 && (
        <div className="node-inspector-rels">
          {details.rels.map((r) => (
            <div key={`${r.type}-${r.dir}`}>
              <code>
                {r.dir === "out" ? "→" : "←"} {r.type}
              </code>{" "}
              × {r.count}
              <span className="hint"> {r.sample.join(", ")}{r.count > r.sample.length ? ", …" : ""}</span>
            </div>
          ))}
        </div>
      )}
      {citation != null && (
        <div className="node-inspector-citation">Source: {String(citation)}</div>
      )}
    </div>
  );
}

// deterministic pseudo-random angle/radius from a node id
function seedPosition(id: string): { x: number; y: number } {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  }
  const angle = ((h >>> 8) % 3600) / 3600 * 2 * Math.PI;
  const radius = 120 + ((h >>> 20) % 240);
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

export default function GraphView({
  nodes,
  rels,
  onNodeClick,
  height = 480,
}: {
  nodes: GNode[];
  rels: GRel[];
  onNodeClick?: (id: string) => void;
  height?: number;
}) {
  const nvlRef = useRef<NVL | null>(null);
  const seenIds = useRef<Set<string>>(new Set());
  const [inspected, setInspected] = useState<NodeDetails | null>(null);

  const inspect = async (id: string) => {
    onNodeClick?.(id);
    setInspected(await fetchNodeDetails(id));
  };

  const nvlNodes: NvlNode[] = useMemo(
    () =>
      nodes.map((n) => {
        // seed a scattered position ONLY for nodes NVL has not seen yet —
        // re-sending x/y for existing nodes would fight the simulation
        const isNew = !seenIds.current.has(n.id);
        const pos = isNew ? seedPosition(n.id) : {};
        return {
          id: n.id,
          captions: [{ value: n.caption ?? n.id }],
          color: n.grey ? GREY : (n.color ?? TYPE_COLORS[n.label] ?? "#5a6b85"),
          size: n.size ?? (n.label === "Position" || n.label === "Incident" ? 34 : 20),
          ...pos,
        };
      }),
    [nodes],
  );
  const nvlRels: NvlRel[] = useMemo(
    () =>
      rels.map((r) => ({
        id: r.id,
        from: r.from,
        to: r.to,
        captions: r.type ? [{ value: r.type }] : undefined,
        color: r.grey ? GREY : "#7d92ba",
      })),
    [rels],
  );

  // restart the force layout when the node SET changes (mount, reveal, expand) —
  // NOT on colour/size-only updates (community highlighting keeps positions)
  const idSignature = useMemo(() => nodes.map((n) => n.id).sort().join("|"), [nodes]);
  useEffect(() => {
    nodes.forEach((n) => seenIds.current.add(n.id));
    const t = window.setTimeout(() => {
      try {
        nvlRef.current?.setLayout(d3ForceLayoutType);
      } catch {
        // canvas not ready yet — the seeded positions still avoid the origin stack
      }
    }, 60);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idSignature]);

  return (
    <div className="graph-canvas" style={{ height, position: "relative" }}>
      <InteractiveNvlWrapper
        mouseEventCallbacks={{
          onNodeClick: (node) => void inspect(String(node.id)),
          onZoom: true,
          onPan: true,
          onDrag: true,
        }}
        nodes={nvlNodes}
        nvlOptions={{ initialZoom: 1, layout: d3ForceLayoutType }}
        ref={nvlRef}
        rels={nvlRels}
      />
      {inspected && <NodeInspector details={inspected} onClose={() => setInspected(null)} />}
      <div className="graph-canvas-hint">click a node to inspect it</div>
    </div>
  );
}
