// Schema peek — the eye icon on each Explore layer card. Opens a popover with
// that layer's mini-schema (curated label set, ≤ 12 nodes; the relationship
// triples come from a LIVE query, logged in the audit drawer like everything
// else) and a 5-row sample from a live query. Closes on click-away.

import { useEffect, useRef, useState } from "react";
import { runQuery, withGroup } from "../lib/neo4j";
import type { LayerName } from "../lib/queries";
import GraphView, { type GNode, type GRel } from "./GraphView";

// curated per-layer label sets (mirrors data/layers/*.json node keys, capped at 12)
const LAYER_LABELS: Record<LayerName, string[]> = {
  market: ["Instrument", "MarketPrice", "Curve", "RiskAttribute", "RegimeBreak"],
  governance: [
    "Policy", "ControlObligation", "Committee", "Desk", "Person", "Position",
    "ValuationMethodology", "PriceOverride", "IPVReview", "Approval", "Escalation", "Evidence",
  ],
  cases: [
    "Incident", "Position", "Instrument", "Person", "Desk", "PriceOverride",
    "MethodologyChange", "IPVReview", "Approval", "Escalation", "Evidence", "CorrectiveAction",
  ],
};

const SAMPLE_QUERY: Record<LayerName, string> = {
  market: `MATCH (i:Instrument) WITH i ORDER BY i.id LIMIT 5
           RETURN properties(i) AS props`,
  governance: `MATCH (o:ControlObligation) WITH o ORDER BY o.id LIMIT 5
               RETURN properties(o) AS props`,
  cases: `MATCH (e:Event {positionId: 'POS-TP'}) WITH e ORDER BY e.at LIMIT 5
          RETURN {id: e.id, label: [l IN labels(e) WHERE l <> 'Event'][0],
                  at: toString(e.at), description: e.description} AS props`,
};

interface Triple {
  from: string;
  relType: string;
  to: string;
  n: number;
}

interface PeekData {
  labels: string[];
  triples: Triple[];
  sample: Record<string, unknown>[];
}

async function fetchPeek(layer: LayerName): Promise<PeekData> {
  return withGroup(`Schema peek: ${layer} layer`, async () => {
    const labels = LAYER_LABELS[layer];
    const triples = await runQuery<Triple>(
      `MATCH (a)-[r]->(b)
       WITH [l IN labels(a) WHERE l <> 'Event'][0] AS from, type(r) AS relType,
            [l IN labels(b) WHERE l <> 'Event'][0] AS to, count(*) AS n
       WHERE from IN $labels AND to IN $labels AND relType <> 'NEXT'
       RETURN from, relType, to, n ORDER BY n DESC LIMIT 30`,
      { labels },
    );
    const sampleRows = await runQuery<{ props: Record<string, unknown> }>(SAMPLE_QUERY[layer]);
    return { labels, triples, sample: sampleRows.map((r) => r.props) };
  });
}

const SAMPLE_COL_CAP = 5;

function SampleTable({ rows }: { rows: Record<string, unknown>[] }) {
  if (rows.length === 0) return null;
  const preferred = ["id", "name", "label", "at", "description"];
  const cols: string[] = [];
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r).filter((k) => r[k] !== null)))];
  keys.sort((a, b) => {
    const ia = preferred.indexOf(a);
    const ib = preferred.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  for (const k of keys) if (cols.length < SAMPLE_COL_CAP) cols.push(k);
  const fmt = (v: unknown) => {
    const s = String(v ?? "—");
    return s.length > 42 ? s.slice(0, 42) + "…" : s;
  };
  return (
    <table className="data-table schema-peek-sample">
      <thead>
        <tr>
          {cols.map((c) => (
            <th key={c}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {cols.map((c) => (
              <td key={c}>{fmt(r[c])}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function SchemaPeek({ layer }: { layer: LayerName }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<PeekData | null>(null);
  const [sampleLabel, setSampleLabel] = useState<string | null>(null);
  const [error, setError] = useState("");
  const popRef = useRef<HTMLDivElement | null>(null);

  // click a label node → the sample table shows 5 live rows of that label
  const loadSample = async (label: string) => {
    try {
      const rows = await withGroup(`Schema peek: sample of ${label}`, () =>
        runQuery<{ props: Record<string, unknown> }>(
          `MATCH (n:\`${label}\`) WITH n ORDER BY n.id LIMIT 5 RETURN properties(n) AS props`,
        ),
      );
      setSampleLabel(label);
      setData((d) => (d ? { ...d, sample: rows.map((r) => r.props) } : d));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // click-away close
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    setError("");
    setSampleLabel(null);
    try {
      setData(await fetchPeek(layer)); // live every open — the layer may have just been ingested
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const graph: { nodes: GNode[]; rels: GRel[] } | null = data && {
    nodes: data.labels.map((l) => ({ id: l, label: l, caption: l, size: 22 })),
    rels: data.triples.map((t, i) => ({
      id: `sp${i}`,
      from: t.from,
      to: t.to,
      type: t.relType,
    })),
  };

  return (
    <span className="schema-peek">
      <button
        aria-label={`Peek at the ${layer} layer schema`}
        className="schema-peek-btn"
        data-testid={`schema-peek-${layer}`}
        onClick={(e) => {
          e.stopPropagation();
          void toggle();
        }}
        title="Mini-schema + live sample of this layer"
      >
        👁
      </button>
      {open && (
        <div className="schema-peek-pop" ref={popRef}>
          <div className="schema-peek-head">
            <strong>{layer} layer — labels & relationships</strong>
            <button className="node-inspector-close" onClick={() => setOpen(false)}>
              ✕
            </button>
          </div>
          {error && <div className="companion-error">⚠ {error}</div>}
          {!data && !error && <div className="hint">querying the schema…</div>}
          {graph && data && (
            <>
              <GraphView
                height={230}
                hintText="click a label to sample 5 live rows"
                inspectOnClick={false}
                nodes={graph.nodes}
                onNodeClick={(label) => void loadSample(label)}
                rels={graph.rels}
                showExploreLink={false}
              />
              <p className="hint">
                {data.triples.length} relationship types among {data.labels.length} labels (live
                query — see the Cypher drawer). <code>NEXT</code> chains omitted for legibility.
              </p>
              <p className="hint">
                <strong>Sample{sampleLabel ? ` — ${sampleLabel}` : ""}</strong> (5 live rows
                {sampleLabel ? "" : ", click a label above to sample another"})
              </p>
              <SampleTable rows={data.sample} />
            </>
          )}
        </div>
      )}
    </span>
  );
}
