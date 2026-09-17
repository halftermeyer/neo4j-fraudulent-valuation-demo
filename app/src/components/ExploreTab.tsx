// Explore — bootstrap the database from inside the app (layer by layer), then
// investigate ONE position by progressive reveal. Never opens on the full graph:
// the point is that each click adds one weak signal and the audience watches
// the shape form.

import { useCallback, useEffect, useMemo, useState } from "react";
import { runQuery, withGroup } from "../lib/neo4j";
import {
  divergence,
  ingestLayer,
  layerCounts,
  listPositions,
  resetDatabase,
  type LayerName,
  type PositionSummary,
} from "../lib/queries";
import GraphView, { type GNode, type GRel } from "./GraphView";
import "./explore.css";

interface DivRow {
  at: string;
  observed: number | null;
  source: string | null;
  proxy: number | null;
  divergenceBps: number | null;
}

const LAYER_META: { name: LayerName; title: string; desc: string }[] = [
  {
    name: "market",
    title: "1 · Market (real)",
    desc: "Real illiquid US corporate bonds: TRACE daily panel (OSBAP), ESMA FITRS liquidity tiers, FRED Treasury proxy curve.",
  },
  {
    name: "governance",
    title: "2 · Governance (synthetic)",
    desc: "Synthetic desks, people, policies and controls — generated FROM the nine ControlObligations with a per-desk compliance rate. Gaps are computed, never hand-placed.",
  },
  {
    name: "cases",
    title: "3 · Cases",
    desc: "The encoded public true positive (POS-TP) and the deliberate false positive (POS-FP).",
  },
];

type SignalKind = "pnl" | "overrides" | "changes" | "ipv" | "gaps";

const SIGNAL_META: Record<SignalKind, { label: string; story: string }> = {
  pnl: { label: "Add PnL signals", story: "unexplained P&L — each one small" },
  overrides: { label: "Add price overrides", story: "marks moved away from quotes" },
  changes: { label: "Add methodology changes", story: "how the book is valued changed" },
  ipv: { label: "Add IPV reviews", story: "what independent verification saw" },
  gaps: { label: "Add governance gaps", story: "which control should have fired and did not" },
};

export default function ExploreTab() {
  // ── database / ingest state ──
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [casesLoaded, setCasesLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string>("");

  // ── exploration state ──
  const [positions, setPositions] = useState<PositionSummary[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [nodes, setNodes] = useState<Map<string, GNode>>(new Map());
  const [rels, setRels] = useState<Map<string, GRel>>(new Map());
  const [step, setStep] = useState(0); // 0 none, 1 position, 2 structure, 3 chart
  const [chart, setChart] = useState<DivRow[]>([]);
  const [added, setAdded] = useState<Partial<Record<SignalKind, number>>>({});

  const refreshDb = useCallback(async () => {
    try {
      const c = await layerCounts();
      setCounts(c);
      const tp = await runQuery<{ c: number }>(
        "MATCH (p:Position {id: 'POS-TP'}) RETURN count(p) AS c",
      );
      setCasesLoaded((tp[0]?.c ?? 0) > 0);
      if ((c["Position"] ?? 0) > 0) {
        setPositions(await listPositions());
      } else {
        setPositions([]);
      }
    } catch {
      setProgress("Cannot reach Neo4j — check app/.env and that the database is running.");
    }
  }, []);

  useEffect(() => {
    refreshDb();
  }, [refreshDb]);

  useEffect(() => {
    if (!selected && positions.length > 0) {
      setSelected(positions.find((p) => p.id === "POS-TP")?.id ?? positions[0].id);
    }
  }, [positions, selected]);

  const marketLoaded = (counts["Instrument"] ?? 0) > 0;
  const governanceLoaded = (counts["ControlObligation"] ?? 0) > 0;
  const loadedFlags: Record<LayerName, boolean> = {
    market: marketLoaded,
    governance: governanceLoaded,
    cases: casesLoaded,
  };
  const enabledFlags: Record<LayerName, boolean> = {
    market: true,
    governance: marketLoaded,
    cases: governanceLoaded,
  };

  const doIngest = async (name: LayerName) => {
    setBusy(name);
    try {
      await ingestLayer(name, (m) => setProgress(m));
      setProgress(`layer '${name}' ingested`);
    } catch (e) {
      setProgress(`ingest failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
      await refreshDb();
    }
  };

  const doReset = async () => {
    if (!confirm("Delete everything in the database?")) return;
    setBusy("reset");
    try {
      await resetDatabase();
      setProgress("database emptied — ingest layer by layer to bootstrap");
      setNodes(new Map());
      setRels(new Map());
      setStep(0);
      setAdded({});
      setSelected("");
      setChart([]);
    } finally {
      setBusy(null);
      await refreshDb();
    }
  };

  // ── progressive reveal ──

  const addNodes = (ns: GNode[], rs: GRel[]) => {
    setNodes((prev) => {
      const next = new Map(prev);
      ns.forEach((n) => next.set(n.id, n));
      return next;
    });
    setRels((prev) => {
      const next = new Map(prev);
      rs.forEach((r) => next.set(r.id, r));
      return next;
    });
  };

  const startReveal = async () => {
    const p = positions.find((x) => x.id === selected);
    if (!p) return;
    setNodes(new Map([[p.id, { id: p.id, label: "Position", caption: p.id, size: 38 }]]));
    setRels(new Map());
    setAdded({});
    setChart([]);
    setStep(1);
  };

  const addStructure = async () => {
    const rows = await withGroup(`Explore: structure of ${selected}`, () =>
      runQuery<Record<string, string | null>>(
        `MATCH (p:Position {id: $id})
         OPTIONAL MATCH (p)-[:OF_INSTRUMENT]->(i:Instrument)
         OPTIONAL MATCH (p)-[:ON_DESK]->(d:Desk)
         OPTIONAL MATCH (p)-[:OWNED_BY]->(o:Person)
         OPTIONAL MATCH (p)-[:VALUED_BY]->(vm:ValuationMethodology)
         RETURN i.id AS iid, i.name AS iname, d.id AS did, d.name AS dname,
                o.id AS oid, o.role AS orole, vm.id AS vmid, vm.name AS vmname`,
        { id: selected },
      ),
    );
    const r = rows[0];
    if (!r) return;
    const ns: GNode[] = [];
    const rs: GRel[] = [];
    if (r.iid) {
      ns.push({ id: r.iid, label: "Instrument", caption: r.iname ?? r.iid });
      rs.push({ id: `${selected}-i`, from: selected, to: r.iid, type: "OF_INSTRUMENT" });
    }
    if (r.did) {
      ns.push({ id: r.did, label: "Desk", caption: r.dname ?? r.did });
      rs.push({ id: `${selected}-d`, from: selected, to: r.did, type: "ON_DESK" });
    }
    if (r.oid) {
      ns.push({ id: r.oid, label: "Person", caption: r.orole ?? r.oid });
      rs.push({ id: `${selected}-o`, from: selected, to: r.oid, type: "OWNED_BY" });
    }
    if (r.vmid) {
      ns.push({ id: r.vmid, label: "ValuationMethodology", caption: r.vmname ?? r.vmid });
      rs.push({ id: `${selected}-vm`, from: selected, to: r.vmid, type: "VALUED_BY" });
    }
    addNodes(ns, rs);
    setStep(2);
  };

  const addChart = async () => {
    const rows = (await withGroup(`Explore: price vs proxy of ${selected}`, () =>
      divergence(selected),
    )) as unknown as DivRow[];
    setChart(rows.filter((r) => r.observed !== null));
    setStep(3);
  };

  const addSignals = async (kind: SignalKind) => {
    const queries: Record<SignalKind, { cypher: string; label: string; relType: string; caption: (r: Record<string, unknown>) => string }> = {
      pnl: {
        cypher: `MATCH (p:Position {id: $id})-[:GENERATED_SIGNAL]->(e:PnLSignal)
                 RETURN e.id AS id, toString(e.at) AS at, e.unexplainedPct AS v`,
        label: "PnLSignal",
        relType: "GENERATED_SIGNAL",
        caption: (r) => `PnL ${(String(r.at) || "").slice(0, 7)}`,
      },
      overrides: {
        cypher: `MATCH (p:Position {id: $id})-[:OVERRIDDEN_BY]->(e:PriceOverride)
                 RETURN e.id AS id, toString(e.at) AS at, e.deviationBps AS v`,
        label: "PriceOverride",
        relType: "OVERRIDDEN_BY",
        caption: (r) => `Override ${r.v ?? "?"}bps`,
      },
      changes: {
        cypher: `MATCH (p:Position {id: $id})-[:CHANGED_TO]->(e:MethodologyChange)
                 RETURN e.id AS id, toString(e.at) AS at, e.kind AS v`,
        label: "MethodologyChange",
        relType: "CHANGED_TO",
        caption: (r) => `Change: ${r.v ?? ""}`,
      },
      ipv: {
        cypher: `MATCH (p:Position {id: $id})-[:REVIEWED_BY]->(e:IPVReview)
                 RETURN e.id AS id, toString(e.at) AS at, e.divergenceBps AS v`,
        label: "IPVReview",
        relType: "REVIEWED_BY",
        caption: (r) => `IPV ${r.v ?? 0}bps`,
      },
      gaps: {
        cypher: `MATCH (g:GovernanceGap {abstract: false, positionId: $id})
                 OPTIONAL MATCH (g)-[:ON_TRIGGER]->(t:Event)
                 RETURN g.id AS id, g.ruleId AS rule, g.status AS status, t.id AS trigger`,
        label: "GovernanceGap",
        relType: "ON_POSITION",
        caption: (r) => `${r.rule} ${String(r.status ?? "").toLowerCase()}`,
      },
    };
    const q = queries[kind];
    const rows = await withGroup(`Explore: ${SIGNAL_META[kind].label} on ${selected}`, () =>
      runQuery<Record<string, unknown>>(q.cypher, { id: selected }),
    );
    const ns: GNode[] = [];
    const rs: GRel[] = [];
    rows.forEach((r) => {
      const id = String(r.id);
      ns.push({ id, label: q.label, caption: q.caption(r), size: 16 });
      if (kind === "gaps") {
        rs.push({ id: `${id}-p`, from: id, to: selected, type: "ON_POSITION" });
        if (r.trigger && (nodes.has(String(r.trigger)) || rows.some((x) => x.id === r.trigger))) {
          rs.push({ id: `${id}-t`, from: id, to: String(r.trigger), type: "ON_TRIGGER" });
        }
      } else {
        rs.push({ id: `${selected}-${id}`, from: selected, to: id, type: q.relType });
      }
    });
    addNodes(ns, rs);
    setAdded((prev) => ({ ...prev, [kind]: rows.length }));
  };

  const graphNodes = useMemo(() => [...nodes.values()], [nodes]);
  const graphRels = useMemo(
    () => [...rels.values()].filter((r) => nodes.has(r.from) && nodes.has(r.to)),
    [rels, nodes],
  );

  const isTP = selected === "POS-TP";

  return (
    <div className="explore-tab">
      <div className="business-problem">
        <div className="bp-title">The business problem</div>
        Reconstructing how one illiquid position was valued — marks, IPV results, P&L
        attribution, approvals, committee minutes — takes <strong>days of manual work across
        five systems</strong>, and it only happens after a loss. Here the same reconstruction
        is <strong>one graph, revealed one hop at a time</strong>.
      </div>

      {/* ── A. Ingest / database ── */}
      <div className="panel">
        <h2>Database</h2>
        <p className="hint">
          The demo bootstraps from an empty database, in three layers, from inside the app.
          Ingesting governance and cases also computes the GovernanceGaps — with the same gap
          query every screen runs (open the Cypher drawer).
        </p>
        <div className="ingest-grid">
          {LAYER_META.map((l) => (
            <div className={`ingest-card ${loadedFlags[l.name] ? "loaded" : ""}`} key={l.name}>
              <h3>{l.title}</h3>
              <p>{l.desc}</p>
              <button
                className="demo-btn"
                disabled={busy !== null || !enabledFlags[l.name] || loadedFlags[l.name]}
                onClick={() => doIngest(l.name)}
              >
                {loadedFlags[l.name] ? "Loaded ✓" : busy === l.name ? "Ingesting…" : "Ingest"}
              </button>
            </div>
          ))}
          <div className="ingest-card">
            <h3>Reset</h3>
            <p>Empty the database. The demo is resettable at any time.</p>
            <button className="demo-btn danger" disabled={busy !== null} onClick={doReset}>
              Reset database
            </button>
          </div>
        </div>
        {progress && <p className="ingest-progress">{progress}</p>}
        {Object.keys(counts).length > 0 && (
          <p className="db-counts">
            {Object.entries(counts)
              .slice(0, 10)
              .map(([l, c]) => `${l} ${c.toLocaleString()}`)
              .join(" · ")}
          </p>
        )}
      </div>

      {/* ── B. Progressive reveal ── */}
      {positions.length > 0 && (
        <div className="panel">
          <h2>Explore one position</h2>
          <p className="hint">
            Pick a position, then add one layer of context per click. Each signal alone is
            below threshold — connected, they have a shape.
          </p>
          <div className="btn-row">
            <select
              className="pos-select"
              onChange={(e) => {
                setSelected(e.target.value);
                setStep(0);
                setNodes(new Map());
                setRels(new Map());
                setAdded({});
                setChart([]);
              }}
              value={selected}
            >
              {positions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id} · {p.deskName} · {p.gapCount} gaps
                </option>
              ))}
            </select>
            <button className="demo-btn" disabled={!selected} onClick={startReveal}>
              1 · Show position
            </button>
            <button className="demo-btn" disabled={step < 1} onClick={addStructure}>
              2 · Add instrument, desk, owner, methodology
            </button>
            <button className="demo-btn" disabled={step < 2} onClick={addChart}>
              3 · Add price history vs proxy
            </button>
          </div>

          {isTP && (
            <div className="case-banner">
              POS-TP is a <strong>synthetic position shaped like a well-documented 2012 public
              mismarking case</strong>. Dates are shifted +10 years onto the demo clock; every
              event keeps its authentic date in <code>sourceAt</code> and its public-record
              citation in <code>sourceRef</code> — visible in the Cypher audit drawer.
            </div>
          )}

          {step >= 3 && (
            <div className="btn-row signal-row">
              {(Object.keys(SIGNAL_META) as SignalKind[]).map((k) => (
                <button
                  className="demo-btn secondary"
                  disabled={added[k] !== undefined}
                  key={k}
                  onClick={() => addSignals(k)}
                  title={SIGNAL_META[k].story}
                >
                  {SIGNAL_META[k].label}
                  {added[k] !== undefined ? ` (${added[k]})` : ""}
                </button>
              ))}
            </div>
          )}

          {step >= 3 && chart.length > 1 && <PriceChart rows={chart} />}

          {graphNodes.length > 0 && (
            <GraphView height={460} nodes={graphNodes} rels={graphRels} />
          )}
        </div>
      )}

      {positions.length === 0 && (
        <div className="panel">
          <h2>Explore one position</h2>
          <p className="hint">Ingest the layers above first — the graph is empty.</p>
        </div>
      )}
    </div>
  );
}

// ── hand-rolled SVG chart: observed vs proxy, shaded gap, divergence bars ────

function PriceChart({ rows }: { rows: DivRow[] }) {
  const W = 860;
  const H = 200;
  const PAD = 36;
  const isMarks = rows.some((r) => r.source === "trader mark");

  const xs = rows.map((_, i) => PAD + (i * (W - 2 * PAD)) / Math.max(rows.length - 1, 1));
  const values = rows.flatMap((r) => [r.observed, r.proxy]).filter((v): v is number => v !== null);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const y = (v: number) => H - PAD - ((v - lo) / Math.max(hi - lo, 0.001)) * (H - 2 * PAD);

  const line = (get: (r: DivRow) => number | null) =>
    rows
      .map((r, i) => {
        const v = get(r);
        return v === null ? null : `${xs[i]},${y(v).toFixed(1)}`;
      })
      .filter(Boolean)
      .join(" ");

  const both = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.observed !== null && r.proxy !== null);
  const area =
    both.map(({ r, i }) => `${xs[i]},${y(r.observed!).toFixed(1)}`).join(" ") +
    " " +
    [...both].reverse().map(({ r, i }) => `${xs[i]},${y(r.proxy!).toFixed(1)}`).join(" ");

  const maxDiv = Math.max(...rows.map((r) => Math.abs(r.divergenceBps ?? 0)), 1);

  return (
    <div className="price-chart">
      <div className="chart-title">
        {isMarks
          ? "Trader marks vs dealer midpoint (case reconstruction — the drift is the story)"
          : "Observed TRACE prices vs proxy curve (FRED Treasury + spread frozen at inception)"}
      </div>
      <svg height={H + 60} viewBox={`0 0 ${W} ${H + 60}`} width="100%">
        <polygon fill="#e0312f22" points={area} stroke="none" />
        <polyline fill="none" points={line((r) => r.observed)} stroke="#0b297d" strokeWidth={2} />
        <polyline
          fill="none"
          points={line((r) => r.proxy)}
          stroke="#00b4d8"
          strokeDasharray="5 4"
          strokeWidth={2}
        />
        {rows.map((r, i) =>
          i % Math.ceil(rows.length / 8) === 0 ? (
            <text fill="#5a6b85" fontSize={10} key={i} textAnchor="middle" x={xs[i]} y={H - 8}>
              {r.at.slice(0, 7)}
            </text>
          ) : null,
        )}
        <text fill="#0b297d" fontSize={11} x={PAD} y={16}>
          ● {isMarks ? "trader mark" : "observed (TRACE)"}
        </text>
        <text fill="#00b4d8" fontSize={11} x={PAD + 160} y={16}>
          ╌ {isMarks ? "dealer midpoint" : "proxy model"}
        </text>
        {rows.map((r, i) => {
          const d = Math.abs(r.divergenceBps ?? 0);
          const h = (d / maxDiv) * 34;
          return (
            <rect
              fill={d > 50 ? "#e03131" : "#9db4d0"}
              height={h}
              key={i}
              width={Math.max((W - 2 * PAD) / rows.length - 3, 2)}
              x={xs[i] - 4}
              y={H + 44 - h}
            >
              <title>{`${r.at.slice(0, 10)} · ${d} bps`}</title>
            </rect>
          );
        })}
        <text fill="#5a6b85" fontSize={10} x={PAD} y={H + 56}>
          divergence (bps) — red above 50
        </text>
      </svg>
    </div>
  );
}
