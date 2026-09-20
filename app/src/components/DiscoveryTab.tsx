// Discovery — structure-driven analysis that feeds the main flow. Not for the
// executive demo: a hood to open for technical audiences (visible only when the
// "Technical" toggle is on). Naming rule: no GDS / algorithms / ML / prediction
// in customer-facing copy. Every panel ends on a button that writes its output
// INTO the main flow (candidate rule, watchlist entry, timeline signal); every
// panel shows its evaluation next to its result; Reset removes every write.

import { useEffect, useMemo, useState } from "react";
import {
  addBehaviourClusterAttributes,
  addRuleR10,
  addToWatchlist,
  approvalCircles,
  computeDecorrelation,
  computeTrajectories,
  DECORR_DEFAULTS,
  discoveryReset,
  fetchGapHoldout,
  proposeApprovalCircleRule,
  TRAJECTORY_PARAMS,
  type CirclePerson,
  type DecorrResult,
  type GapHoldout,
  type TrajectoryResult,
} from "../lib/discoveryQueries";
import { AS_OF_DEFAULT, expectedControls, listPositions, type PositionSummary } from "../lib/queries";
import circlesMd from "../content/discovery/approval-circles.md?raw";
import decorrMd from "../content/discovery/peer-decorrelation.md?raw";
import trajectoriesMd from "../content/discovery/trajectories.md?raw";
import DiscoveryExplainer from "./DiscoveryExplainer";
import GraphView, { type GNode, type GRel } from "./GraphView";
import "./discovery.css";

const COMMUNITY_COLORS = [
  "#0b297d", "#d9480f", "#0f766e", "#c2255c", "#5f3dc4", "#e8590c",
  "#2f9e44", "#9c36b5", "#1864ab", "#f08c00", "#862e9c", "#0ca678",
];

// ── Panel 1 · Approval circles ───────────────────────────────────────────────

function ApprovalCircles() {
  const [people, setPeople] = useState<CirclePerson[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const run = async () => {
    setBusy(true);
    try {
      setPeople(await approvalCircles());
      setNote("");
    } finally {
      setBusy(false);
    }
  };

  const propose = async () => {
    setBusy(true);
    try {
      await proposeApprovalCircleRule();
      setNote(
        "R-C1 written to the Policy step, badged candidate — off by default, nothing evaluates it until it is validated.",
      );
    } finally {
      setBusy(false);
    }
  };

  const communities = useMemo(() => {
    const m = new Map<number, CirclePerson[]>();
    for (const p of people) m.set(p.community, [...(m.get(p.community) ?? []), p]);
    return [...m.entries()]
      .map(([id, members]) => ({
        id,
        members,
        desks: [...new Set(members.map((x) => x.deskName ?? x.desk ?? "?"))],
        hasIndependent: members.some((x) => x.independent),
      }))
      .sort((a, b) => b.members.length - a.members.length);
  }, [people]);

  const graph = useMemo((): { nodes: GNode[]; rels: GRel[] } => {
    const nodes = people.map((p) => ({
      id: p.personId,
      label: "Person",
      caption: p.role ?? p.personId,
      color: COMMUNITY_COLORS[p.community % COMMUNITY_COLORS.length],
      size: p.independent ? 26 : 18,
    }));
    return { nodes, rels: [] };
  }, [people]);

  return (
    <div className="panel disc-panel" data-testid="disc-panel-circles">
      <h2>
        Approval circles{" "}
        <DiscoveryExplainer markdown={circlesMd} panelId="circles" title="Approval circles" />
      </h2>
      <p className="hint">
        Who approves whose overrides, as a structure: people who keep approving each
        other's marks form circles. Circles that contain{" "}
        <strong>no independent control function</strong> are highlighted — no rule described
        them; the structure did.
      </p>
      <div className="btn-row">
        <button className="demo-btn" data-testid="disc-circles-run" disabled={busy} onClick={run}>
          Find approval circles
        </button>
      </div>
      {communities.length > 0 && (
        <>
          <div className="disc-split">
            <table className="data-table disc-circles-table">
              <thead>
                <tr>
                  <th>Circle</th>
                  <th>Members</th>
                  <th>Desks covered</th>
                  <th>Independent function?</th>
                </tr>
              </thead>
              <tbody>
                {communities.map((c) => (
                  <tr className={c.hasIndependent ? "" : "row-gap"} key={c.id}>
                    <td>
                      <span
                        className="legend-dot"
                        style={{ background: COMMUNITY_COLORS[c.id % COMMUNITY_COLORS.length] }}
                      />{" "}
                      #{c.id}
                    </td>
                    <td>
                      {c.members.slice(0, 6).map((m) => (
                        <span className="pill pill-info" key={m.personId} title={m.personId}>
                          {m.role ?? m.personId}
                        </span>
                      ))}
                      {c.members.length > 6 ? ` +${c.members.length - 6}` : ""}
                    </td>
                    <td>{c.desks.join(", ")}</td>
                    <td>
                      {c.hasIndependent ? (
                        <span className="pill pill-met">yes</span>
                      ) : (
                        <span className="pill pill-missed">none — closed circle</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="disc-graph">
              <GraphView height={340} hintText="people coloured by circle — larger = independent function" inspectOnClick={true} nodes={graph.nodes} rels={graph.rels} />
            </div>
          </div>
          <p className="hint disc-honesty">
            At 60 people this is visible by eye. At your scale it is not. Nothing here is a
            finding; it is a hypothesis for a rule. Evaluation: {communities.length} circles,{" "}
            {communities.filter((c) => !c.hasIndependent).length} without an independent function —
            visible by eye at this size; matters at scale.
          </p>
          <div className="btn-row">
            <button
              className="demo-btn secondary"
              data-testid="disc-circles-propose"
              disabled={busy}
              onClick={propose}
            >
              Propose as rule → candidate R-C1 in the Policy step
            </button>
            {note && <span className="policy-note">{note}</span>}
          </div>
        </>
      )}
    </div>
  );
}

// ── Panel 2 · Trajectories ───────────────────────────────────────────────────

function Fingerprint({
  title,
  vector,
  atoms,
  gridDays,
  max,
}: {
  title: string;
  vector: number[];
  atoms: string[];
  gridDays: number[];
  max: number;
}) {
  const g = TRAJECTORY_PARAMS.gridPoints;
  // show only atoms this vector (or its comparison) actually touches, densest first
  const rows = atoms
    .map((atom, ai) => ({
      atom,
      cells: Array.from({ length: g }, (_, gi) => vector[ai * g + gi] ?? 0),
    }))
    .filter((r) => r.cells.some((c) => c > 1e-9))
    .sort((a, b) => Math.max(...b.cells) - Math.max(...a.cells))
    .slice(0, 12);
  return (
    <div className="disc-heatmap">
      <div className="disc-heatmap-title">{title}</div>
      <div className="disc-heatmap-grid" style={{ gridTemplateColumns: `160px repeat(${g}, 26px)` }}>
        <div className="disc-heatmap-label" />
        {gridDays.map((d) => (
          <div className="disc-heatmap-label" key={d} style={{ textAlign: "center", paddingRight: 0 }}>
            {d}d
          </div>
        ))}
        {rows.map((r) => (
          <>
            <div className="disc-heatmap-label" key={r.atom} title={r.atom}>
              {r.atom}
            </div>
            {r.cells.map((c, gi) => (
              <div
                className="disc-heatmap-cell"
                key={gi}
                style={{ background: `rgba(11, 41, 125, ${Math.min(c / max, 1)})` }}
                title={`${r.atom} ≈${gridDays[gi]}d ago: ${c.toFixed(2)}`}
              />
            ))}
          </>
        ))}
      </div>
    </div>
  );
}

function Trajectories() {
  const [positions, setPositions] = useState<PositionSummary[]>([]);
  const [reference, setReference] = useState("POS-TP");
  const [asOf, setAsOf] = useState(AS_OF_DEFAULT.slice(0, 10));
  const [result, setResult] = useState<TrajectoryResult | null>(null);
  const [holdout, setHoldout] = useState<GapHoldout[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    void listPositions().then(setPositions);
    void fetchGapHoldout().then(setHoldout);
  }, []);

  const run = async () => {
    setBusy(true);
    try {
      const r = await computeTrajectories(reference, `${asOf}T00:00:00Z`);
      setResult(r);
      setSelected(r.neighbors[0]?.positionId ?? null);
      setNote("");
    } finally {
      setBusy(false);
    }
  };

  const watch = async (pid: string) => {
    setBusy(true);
    try {
      await addToWatchlist(pid, reference, asOf);
      setNote(`${pid} added to the S4 watchlist — reason recorded, audit-logged.`);
    } finally {
      setBusy(false);
    }
  };

  const gridWord = (gi: number) => `≈${result?.gridDays[gi] ?? 0} d ago`;
  const evaluation = useMemo(() => {
    if (!result) return null;
    const top = new Set(result.neighbors.map((n) => n.positionId));
    // headline: a readable retrieval check — does the shortlist over-select
    // books with a recent history of the case's core gap families?
    const enriched = result.neighbors.filter((n) => result.gapRich.has(n.positionId)).length;
    const popShare = result.gapRich.size / result.positionCount;
    // secondary: holdout recall, with its sample size stated
    const hits = holdout.filter((h) => top.has(h.positionId));
    return { enriched, popShare, hits };
  }, [result, holdout]);

  const heatMax = useMemo(() => {
    if (!result) return 1;
    const vs = [result.vectors.get(reference), selected ? result.vectors.get(selected) : null];
    return Math.max(...vs.flatMap((v) => v ?? [0]), 0.05);
  }, [result, reference, selected]);

  return (
    <div className="panel disc-panel" data-testid="disc-panel-traj">
      <h2>
        Trajectories{" "}
        <DiscoveryExplainer markdown={trajectoriesMd} panelId="trajectories" title="Trajectories" />
      </h2>
      <p className="hint">
        A deterministic function of each position's own history. Nothing is learned, nothing is
        predicted. Same history shifted in time gives the same result — which is what makes it
        comparable across periods. (Θ = {TRAJECTORY_PARAMS.theta} d, {TRAJECTORY_PARAMS.gridPoints}{" "}
        time bands; every dimension is nameable: an atom — event type, rule, role, desk — in a band.)
      </p>
      <div className="btn-row">
        <label className="inline-label">
          Reference
          <select data-testid="disc-traj-ref" onChange={(e) => setReference(e.target.value)} value={reference}>
            {positions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id}
              </option>
            ))}
          </select>
        </label>
        <label className="inline-label">
          As of
          <input onChange={(e) => setAsOf(e.target.value)} type="date" value={asOf} />
        </label>
        <button className="demo-btn" data-testid="disc-traj-run" disabled={busy} onClick={run}>
          Compare trajectories
        </button>
        {note && <span className="policy-note">{note}</span>}
      </div>
      {result && (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th>Neighbour</th>
                <th>shape (cosine)</th>
                <th>magnitude (distance)</th>
                <th>what makes it similar</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {result.neighbors.map((n) => (
                <tr
                  className={`clickable ${n.positionId === selected ? "row-selected" : ""}`}
                  key={n.positionId}
                  onClick={() => setSelected(n.positionId)}
                >
                  <td>
                    {n.positionId}
                    {holdout.some((h) => h.positionId === n.positionId) && (
                      <span className="pill pill-met" title="held-out ground truth recovered">
                        ✓ held-out
                      </span>
                    )}
                  </td>
                  <td>{n.cosine.toFixed(3)}</td>
                  <td>{n.euclid.toFixed(2)}</td>
                  <td>
                    {n.topDims
                      .map((d) => `${d.weight.toFixed(2)}× ${d.atom} ${gridWord(d.gridIndex)}`)
                      .join(" · ") || "—"}
                  </td>
                  <td>
                    <button
                      className="demo-btn secondary s4-tl-btn"
                      data-testid={`disc-watch-${n.positionId}`}
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void watch(n.positionId);
                      }}
                    >
                      Add to watchlist
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="disc-eval">
            {evaluation && (
              <span>
                Evaluation: <strong>{evaluation.enriched} of {result.neighbors.length}</strong> of{" "}
                {reference}'s nearest trajectories have ≥2 recent gaps in {"{R3, R5, R8}"} — vs{" "}
                <strong>{(evaluation.popShare * 100).toFixed(0)}%</strong> of the population (
                {result.gapRich.size}/{result.positionCount}).{" "}
                {evaluation.enriched / result.neighbors.length > evaluation.popShare * 1.5
                  ? "That enrichment is what the shortlist is for."
                  : "Barely above the population share at this size — a hypothesis, not evidence."}
                {holdout.length > 0 && (
                  <>
                    {" "}
                    Secondary: <strong>{evaluation.hits.length} of {holdout.length}</strong> holdouts
                    recovered — too few to conclude. (The holdout asks a harder question: with one
                    rule's trigger events deleted at generation, do the REMAINING gaps still surface
                    the book — i.e. does the rest of the history predict the hidden part?)
                  </>
                )}
              </span>
            )}
          </div>
          <div className="disc-heatmaps">
            <Fingerprint
              atoms={result.atoms}
              gridDays={result.gridDays}
              max={heatMax}
              title={`${reference} — fingerprint (atom × time band)`}
              vector={result.vectors.get(reference) ?? []}
            />
            {selected && (
              <Fingerprint
                atoms={result.atoms}
                gridDays={result.gridDays}
                max={heatMax}
                title={`${selected} — fingerprint`}
                vector={result.vectors.get(selected) ?? []}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── Panel 3 · Peer decorrelation ─────────────────────────────────────────────

function PeerDecorrelation() {
  const [params, setParams] = useState(DECORR_DEFAULTS);
  const [result, setResult] = useState<DecorrResult | null>(null);
  const [r10, setR10] = useState<Map<string, string> | null>(null); // positionId → status
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const run = async () => {
    setBusy(true);
    try {
      setResult(await computeDecorrelation(AS_OF_DEFAULT, params));
      setR10(null);
      setNote("");
    } finally {
      setBusy(false);
    }
  };

  const proposeR10 = async () => {
    setBusy(true);
    try {
      await addRuleR10(params);
      // the SAME gap query now evaluates R10 — show the verdicts immediately
      const rows = await expectedControls(null, { ruleId: "R10" });
      setR10(new Map(rows.map((r) => [r.positionId, r.status])));
      setNote("R10 written to the Policy step — the gap query evaluates it from now on.");
    } finally {
      setBusy(false);
    }
  };

  const clustersAsAttributes = async () => {
    if (!result) return;
    setBusy(true);
    try {
      const n = await addBehaviourClusterAttributes(result.clusters);
      setNote(`${n} behaviour clusters written as risk attributes — S3/S4 can match on them; Reset removes them.`);
    } finally {
      setBusy(false);
    }
  };

  const num = (k: keyof typeof params, step = 1) => (
    <label className="inline-label" key={k}>
      {k}
      <input
        onChange={(e) => setParams({ ...params, [k]: Number(e.target.value) })}
        step={step}
        style={{ width: 70 }}
        type="number"
        value={params[k]}
      />
    </label>
  );

  return (
    <div className="panel disc-panel" data-testid="disc-panel-decorr">
      <h2>
        Peer decorrelation{" "}
        <DiscoveryExplainer markdown={decorrMd} panelId="decorrelation" title="Peer decorrelation" />
      </h2>
      <p className="hint">
        Your quants compute this already. What is new is that the signal sits in the{" "}
        <strong>same graph as the approvals</strong>, so it can be one condition among the others.
        A book whose marks stop moving with its peers gets a signal, dated at the first breach —
        visible as a marker on every financial timeline.
      </p>
      <div className="btn-row">
        {num("windowWeeks")}
        {num("threshold", 0.05)}
        {num("periods")}
        <button className="demo-btn" data-testid="disc-decorr-run" disabled={busy} onClick={run}>
          Compute peer correlations
        </button>
        {note && <span className="policy-note">{note}</span>}
      </div>
      {result && (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th>Position</th>
                <th>first breach</th>
                <th>correlation</th>
                <th>peer group</th>
                {r10 && <th>R10 verdict</th>}
              </tr>
            </thead>
            <tbody>
              {result.signals.map((s) => (
                <tr data-node-id={`DS-${s.positionId}`} key={s.positionId}>
                  <td>
                    <strong>{s.positionId}</strong>
                  </td>
                  <td>{s.at}</td>
                  <td>{s.correlation.toFixed(2)}</td>
                  <td>{s.peerGroup.replace(/^\|/, "").replace("|", " · ")}</td>
                  {r10 && (
                    <td>
                      <span className={`pill pill-${(r10.get(s.positionId) ?? "pending").toLowerCase()}`}>
                        {r10.get(s.positionId) ?? "—"}
                      </span>
                    </td>
                  )}
                </tr>
              ))}
              {result.signals.length === 0 && (
                <tr>
                  <td colSpan={4}>no decorrelation at these parameters</td>
                </tr>
              )}
            </tbody>
          </table>
          <p className="hint disc-honesty">
            Evaluation: {result.signals.length} of {result.positionCount} marked books decorrelate
            at these parameters — the two encoded cases and nothing else is the designed baseline;
            more than a handful would mean the threshold is noise. The exculpatory story is IN the
            signal: the false positive re-correlates right after its approved methodology change.
          </p>
          {result.clusters.length > 0 && (
            <p className="hint">
              Peer clusters (behaviour, not sector): {result.clusters.map((c) => `#${c.id} × ${c.members.length}`).join(" · ")}
            </p>
          )}
          <div className="btn-row">
            <button className="demo-btn secondary" data-testid="disc-decorr-r10" disabled={busy} onClick={proposeR10}>
              Add as rule R10 → Policy step
            </button>
            <button
              className="demo-btn secondary"
              data-testid="disc-decorr-clusters"
              disabled={busy || result.clusters.length === 0}
              onClick={clustersAsAttributes}
            >
              Use behaviour clusters as attributes → S3/S4
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ── the tab ──────────────────────────────────────────────────────────────────

export default function DiscoveryTab() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [epoch, setEpoch] = useState(0); // reset remounts the panels

  const reset = async () => {
    setBusy(true);
    try {
      await discoveryReset();
      setNote("Discovery reset — every Discovery write removed from the graph.");
      setEpoch((e) => e + 1);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="discovery-tab">
      <div className="business-problem">
        <div className="bp-title">Discovery</div>
        Rules find what you described. Structure finds what you didn't. Then structure
        becomes a rule.
      </div>
      <div className="btn-row">
        <button className="demo-btn danger" data-testid="disc-reset" disabled={busy} onClick={reset}>
          Reset Discovery
        </button>
        <span className="hint">
          Nothing here persists into the scenarios unless a panel's output button wrote it —
          and Reset removes those writes too.
        </span>
        {note && <span className="policy-note">{note}</span>}
      </div>
      <div key={epoch}>
        <ApprovalCircles />
        <Trajectories />
        <PeerDecorrelation />
      </div>
    </div>
  );
}
