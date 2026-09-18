// Scenarios tab — the four sales arguments (S1 Conjunction, S2 Chronology,
// S3 Abstraction, S4 Read-across) + the Policy panel. Each scenario opens with
// the business problem, then runs the real query/algorithm live on click.
// S4 row-click jumps to S2 preloaded with that position (the false-positive
// click-through is the point: its controls did happen; a human closes it).

import { useCallback, useMemo, useState } from "react";
import {
  expectedControls,
  timeline,
  type GapRow,
  type TimelineEvent,
} from "../lib/queries";
import {
  addRequires,
  chronologyChain,
  createPatternFromIncident,
  fetchHoldout,
  getPattern,
  listRequireCandidates,
  positionNeighborhood,
  predictHeldOutLinks,
  removeRequires,
  runCommunityDetection,
  runConjunction,
  scoreReadAcross,
  type ChainRow,
  type ConjunctionRow,
  type HoldoutLink,
  type Neighborhood,
  type PatternInfo,
  type PredictedLink,
  type ReadAcrossRow,
  type RequireCandidate,
} from "../lib/scenarioQueries";
import { captureCypher } from "../lib/companion";
import { ExplainButton } from "./CompanionPanel";
import GraphView, { GREY, TYPE_COLORS, type GNode, type GRel } from "./GraphView";
import PolicyPanel from "./PolicyPanel";
import GlossaryText from "./Term";
import "./scenarios.css";

type SubTab = "s1" | "s2" | "s3" | "s4" | "policy";

const SUB_TABS: { id: SubTab; label: string }[] = [
  { id: "s1", label: "S1 · Conjunction" },
  { id: "s2", label: "S2 · Chronology" },
  { id: "s3", label: "S3 · Abstraction" },
  { id: "s4", label: "S4 · Read-across" },
  { id: "policy", label: "Policy panel" },
];

const fmtDate = (s: string | null | undefined) => (s ? String(s).slice(0, 10) : "—");

function neighborhoodToGraph(
  nb: Neighborhood,
  highlightCommunity: number | null,
): { nodes: GNode[]; rels: GRel[] } {
  const nodes = nb.nodes.map((n) => {
    const label = n.labels.find((l) => l !== "Event") ?? n.labels[0];
    const grey =
      highlightCommunity !== null &&
      (n.communityId === null || n.communityId !== highlightCommunity);
    return {
      id: n.id,
      label,
      caption: n.caption.length > 28 ? n.caption.slice(0, 28) + "…" : n.caption,
      grey,
    };
  });
  const ids = new Set(nodes.map((n) => n.id));
  const rels = nb.rels
    .filter((r) => ids.has(r.f) && ids.has(r.t))
    .map((r, i) => ({ id: `r${i}`, from: r.f, to: r.t, type: r.ty }));
  return { nodes, rels };
}

// ───────────────────────────── S1 ─────────────────────────────

function S1({ onOpenChronology }: { onOpenChronology: (id: string) => void }) {
  const [rows, setRows] = useState<ConjunctionRow[]>([]);
  const [runCypher, setRunCypher] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [nb, setNb] = useState<Neighborhood | null>(null);
  const [community, setCommunity] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const run = async () => {
    setBusy(true);
    try {
      const { result: r, cypher } = await captureCypher(() => runConjunction());
      setRunCypher(cypher);
      setRows(r);
      const first = r[0]?.positionId ?? null;
      setSelected(first);
      if (first) setNb(await positionNeighborhood(first));
      setCommunity(null);
    } finally {
      setBusy(false);
    }
  };

  const select = async (id: string) => {
    setSelected(id);
    setNb(await positionNeighborhood(id));
    setCommunity(null);
  };

  const detect = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const { communityCount } = await runCommunityDetection();
      const fresh = await positionNeighborhood(selected);
      setNb(fresh);
      const mine = fresh.nodes.find((n) => n.id === selected)?.communityId ?? null;
      setCommunity(mine);
      setNote(
        `Louvain found ${communityCount} communities; the coloured one is the community of ${selected} — the community IS the pattern, the grey graph is everything it is not.`,
      );
    } finally {
      setBusy(false);
    }
  };

  const graph = useMemo(() => (nb ? neighborhoodToGraph(nb, community) : null), [nb, community]);

  return (
    <>
      <div className="business-problem">
        <GlossaryText>
          <div className="bp-title">The problem today</div>
          Each control sees one signal at a time: a P&L break in one report, an override in
          another, a late IPV in a third — <strong>each below its own threshold, none alerting.</strong>{" "}
          Assembling them per position is a manual, quarterly, spreadsheet exercise.{" "}
          <strong>How to read the screen:</strong> one query walks all connections around every
          position and counts what co-occurs. The ranking is the conjunction — not any single alarm.
        </GlossaryText>
      </div>
      <div className="btn-row">
        <button className="demo-btn" data-testid="s1-run" disabled={busy} onClick={run}>
          Run the conjunction query
        </button>
        <button className="demo-btn secondary" data-testid="s1-louvain" disabled={busy || !selected} onClick={detect}>
          GDS · Louvain communities
        </button>
        {note && <span className="hint">{note}</span>}
      </div>
      {rows.length > 0 && (
        <div className="s1-layout">
          <div className="panel s1-table">
            <div className="card-head">
              <h2>Positions ranked by conjunction</h2>
              <ExplainButton
                payload={() => ({
                  scene: "s1",
                  selectionId: selected ?? rows[0]?.positionId ?? "?",
                  title: `Conjunction ranking — ${selected ?? rows[0]?.positionId ?? ""}`,
                  rows: rows.slice(0, 12),
                  cypher: runCypher,
                })}
              />
            </div>
            <p className="hint">
              <GlossaryText>
                Click a row to draw its neighbourhood. Double meaning intended: score = (events)
                × (distinct broken rules).
              </GlossaryText>
            </p>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Position</th>
                  <th>Desk</th>
                  <th>P&L signals</th>
                  <th>Overrides</th>
                  <th>Method Δ</th>
                  <th>Broken rules</th>
                  <th>Score</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 12).map((r) => (
                  <tr
                    className={`clickable ${r.positionId === selected ? "row-selected" : ""}`}
                    key={r.positionId}
                    onClick={() => select(r.positionId)}
                  >
                    <td>{r.positionId}</td>
                    <td>{r.desk}</td>
                    <td>{r.signals}</td>
                    <td>{r.overrides}</td>
                    <td>{r.methodChanges}</td>
                    <td>
                      {r.brokenRules.map((x) => (
                        <span className="pill pill-missed" key={x}>
                          {x}
                        </span>
                      ))}
                    </td>
                    <td>
                      <strong>{r.conjunctionScore}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {selected && (
              <div className="btn-row">
                <button className="demo-btn secondary" onClick={() => onOpenChronology(selected)}>
                  Open {selected} in S2 chronology →
                </button>
              </div>
            )}
          </div>
          {graph && (
            <div className="panel s1-graph">
              <h2>{selected} — the shape of the conjunction</h2>
              <GraphView height={520} nodes={graph.nodes} onNodeClick={() => {}} rels={graph.rels} />
              <Legend />
            </div>
          )}
        </div>
      )}
    </>
  );
}

function Legend() {
  const entries: [string, string][] = [
    ["Position", TYPE_COLORS.Position],
    ["PriceOverride", TYPE_COLORS.PriceOverride],
    ["PnLSignal", TYPE_COLORS.PnLSignal],
    ["MethodologyChange", TYPE_COLORS.MethodologyChange],
    ["IPVReview", TYPE_COLORS.IPVReview],
    ["Approval", TYPE_COLORS.Approval],
    ["GovernanceGap", TYPE_COLORS.GovernanceGap],
    ["Person", TYPE_COLORS.Person],
    ["outside community", GREY],
  ];
  return (
    <div className="legend">
      {entries.map(([label, color]) => (
        <span className="legend-item" key={label}>
          <span className="legend-dot" style={{ background: color }} /> {label}
        </span>
      ))}
    </div>
  );
}

// ───────────────────────────── S2 ─────────────────────────────

function S2({ positionId, setPositionId }: { positionId: string; setPositionId: (s: string) => void }) {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [controls, setControls] = useState<GapRow[]>([]);
  const [chain, setChain] = useState<ChainRow[]>([]);
  const [asOf, setAsOf] = useState("2023-01-01");
  const [busy, setBusy] = useState(false);
  const [runCypher, setRunCypher] = useState("");

  const run = useCallback(async () => {
    setBusy(true);
    try {
      const { result, cypher } = await captureCypher(async () => ({
        ev: await timeline(positionId),
        ch: await chronologyChain(positionId),
        ctl: await expectedControls(positionId, { asOf: `${asOf}T00:00:00Z` }),
      }));
      setEvents(result.ev);
      setChain(result.ch);
      setControls(result.ctl);
      setRunCypher(cypher);
    } finally {
      setBusy(false);
    }
  }, [positionId, asOf]);

  const slimEvents = () =>
    events.map((e) => ({
      id: e.id,
      label: e.label,
      at: e.at,
      sourceAt: e.sourceAt,
      description: e.description ? String(e.description).slice(0, 140) : undefined,
    }));

  return (
    <>
      <div className="business-problem">
        <GlossaryText>
          <div className="bp-title">The problem today</div>
          Reconstructing one book's story means stitching e-mails, IPV packs, committee minutes and
          P&L reports — weeks of work after the fact. <strong>How to read the screen:</strong> events
          are chained in event-time in the graph; the timeline below is one traversal, and the
          expected-vs-observed table is one parameterised query over the nine control obligations:{" "}
          <em>which control should have fired here, and did not.</em> The Assistant tab answers the
          same question in natural language over the same queries.
        </GlossaryText>
      </div>
      <div className="btn-row">
        <label className="inline-label">
          Position
          <input data-testid="s2-position" onChange={(e) => setPositionId(e.target.value)} value={positionId} />
        </label>
        <label className="inline-label">
          As of
          <input onChange={(e) => setAsOf(e.target.value)} type="date" value={asOf} />
        </label>
        <button className="demo-btn" data-testid="s2-run" disabled={busy} onClick={run}>
          Reconstruct
        </button>
        <span className="hint">
          Set “as of” mid-2022 to see the same gaps flagged while the pattern is still forming —
          early detection, not autopsy.
        </span>
      </div>
      {events.length > 0 && (
        <div className="s2-layout">
          <div className="panel s2-timeline">
            <h2>Chronology — {positionId}</h2>
            <div className="timeline">
              {events.map((e) => (
                <div className={`tl-item tl-${e.label.toLowerCase()}`} key={e.id}>
                  <span className="tl-dot" style={{ background: TYPE_COLORS[e.label] ?? "#888" }} />
                  <div className="tl-body">
                    <div className="tl-head">
                      <strong>{e.label}</strong>
                      <span className="tl-date">{fmtDate(e.at)}</span>
                      {e.sourceAt && String(e.sourceAt).slice(0, 10) !== String(e.at).slice(0, 10) && (
                        <span className="tl-source">authentic: {fmtDate(e.sourceAt)}</span>
                      )}
                      {typeof e.props.amountUsdM === "number" && (
                        <span className="pill pill-info">{String(e.props.amountUsdM)} m$</span>
                      )}
                    </div>
                    {e.description && <div className="tl-desc">{e.description}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="s2-right">
            <div className="panel">
              <div className="card-head">
                <h2>Expected vs observed (as of {asOf})</h2>
                <ExplainButton
                  testId="explain-s2-card"
                  payload={() => ({
                    scene: "s2",
                    selectionId: positionId,
                    title: `Chronology & expected-vs-observed — ${positionId}`,
                    rows: { timeline: slimEvents(), expectedControls: controls },
                    cypher: runCypher,
                  })}
                />
              </div>
              <p className="hint">
                <GlossaryText>
                  One parameterised gap query for all nine rules — thresholds read live from the
                  ControlObligation nodes (see Policy panel).
                </GlossaryText>
              </p>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Rule</th>
                    <th>Trigger</th>
                    <th>Expected control</th>
                    <th>Due by</th>
                    <th>Observed</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {controls.map((c, i) => (
                    <tr className={c.status === "MET" ? "" : "row-gap"} key={i}>
                      <td>
                        <strong>{c.ruleId}</strong> {c.ruleName}
                      </td>
                      <td>
                        {c.triggerLabel} <span className="hint-inline">{fmtDate(c.triggerAt)}</span>
                      </td>
                      <td>{c.expectedControl}</td>
                      <td>{fmtDate(c.dueBy)}</td>
                      <td>{c.observedEventId ? fmtDate(c.observedAt) : "—"}</td>
                      <td>
                        <span className={`pill pill-${c.status.toLowerCase()}`}>{c.status}</span>
                        {c.status !== "MET" && (
                          <ExplainButton
                            payload={() => ({
                              scene: "s2-gap",
                              selectionId: `${positionId}:${c.ruleId}`,
                              title: `Gap ${c.ruleId} (${c.ruleName}) — ${positionId}`,
                              rows: [c],
                              cypher: runCypher,
                            })}
                            small
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {chain.length > 0 && (
              <div className="panel">
                <h2>The chain the graph walked (QPP)</h2>
                <p className="hint">
                  <code>{"(:PriceOverride)(()-[:NEXT]->()){1,10}(:IPVReview)"}</code> — overrides
                  connected to the review that later judged them, purely by event order.
                </p>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Override</th>
                      <th>→ IPV review</th>
                      <th>events between</th>
                      <th>days between</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chain.slice(0, 8).map((c, i) => (
                      <tr key={i}>
                        <td>{c.fromId}</td>
                        <td>{c.toId}</td>
                        <td>{c.hops}</td>
                        <td>{c.daysBetween ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

// ───────────────────────────── S3 ─────────────────────────────

function S3() {
  const [pattern, setPattern] = useState<PatternInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [runCypher, setRunCypher] = useState("");

  const run = async () => {
    setBusy(true);
    try {
      const { result, cypher } = await captureCypher(() => createPatternFromIncident("INC-TP"));
      setPattern(result);
      setRunCypher(cypher);
    } finally {
      setBusy(false);
    }
  };

  const graph = useMemo(() => {
    if (!pattern) return null;
    const nodes: GNode[] = [
      { id: pattern.id, label: "Pattern", caption: pattern.name, size: 40 },
      ...pattern.requires.map((r) => ({
        id: r.id,
        label: r.isGap ? "GovernanceGap" : "RiskAttribute",
        caption: r.name,
      })),
    ];
    const rels: GRel[] = pattern.requires.map((r, i) => ({
      id: `req${i}`,
      from: pattern.id,
      to: r.id,
      type: "REQUIRES",
    }));
    return { nodes, rels };
  }, [pattern]);

  return (
    <>
      <div className="business-problem">
        <GlossaryText>
          <div className="bp-title">The problem today</div>
          After a loss event, the lesson stays trapped in the instrument it happened to: read-across
          reviews are run by hand, per asset class, months later.{" "}
          <strong>How to read the screen:</strong> from the confirmed incident, one query builds a{" "}
          <strong>template</strong> — the risk attributes and the governance gaps that carried the
          case. No instrument name, no desk, no dates. It is a shape, not a lookup.
        </GlossaryText>
      </div>
      <div className="btn-row">
        <button className="demo-btn" data-testid="s3-run" disabled={busy} onClick={run}>
          Abstract the confirmed case → :Pattern
        </button>
      </div>
      {pattern && graph && (
        <div className="s1-layout">
          <div className="panel">
            <div className="card-head">
              <h2>{pattern.name}</h2>
              <ExplainButton
                payload={() => ({
                  scene: "s3",
                  selectionId: pattern.id,
                  title: `Pattern ${pattern.id} — abstracted from ${pattern.fromIncident}`,
                  rows: pattern,
                  cypher: runCypher,
                })}
              />
            </div>
            <p className="hint">
              Built from incident <code>{pattern.fromIncident}</code>. REQUIRES ={" "}
              {pattern.requires.length} conditions — every one instrument-agnostic:
            </p>
            <div className="chips">
              {pattern.requires.map((r) => (
                <span className={`chip ${r.isGap ? "chip-gap" : "chip-attr"}`} key={r.id}>
                  {r.name}
                </span>
              ))}
            </div>
            <p className="hint">
              <GlossaryText>
                The template deliberately excludes <code>deskId</code> and <code>issuerSector</code>:
                the pattern must travel across desks and sectors. Add them back in S4 to see the
                match set shrink — pattern size is a presenter's choice, not a system limit.
              </GlossaryText>
            </p>
          </div>
          <div className="panel s1-graph">
            <h2>The pattern as a graph object</h2>
            <GraphView height={460} nodes={graph.nodes} rels={graph.rels} />
          </div>
        </div>
      )}
    </>
  );
}

// ───────────────────────────── S4 ─────────────────────────────

function S4({ onOpenChronology }: { onOpenChronology: (id: string) => void }) {
  const [rows, setRows] = useState<ReadAcrossRow[]>([]);
  const [runCypher, setRunCypher] = useState("");
  const [pattern, setPattern] = useState<PatternInfo | null>(null);
  const [candidates, setCandidates] = useState<RequireCandidate[]>([]);
  const [addSel, setAddSel] = useState("");
  const [pred, setPred] = useState<PredictedLink[] | null>(null);
  const [holdout, setHoldout] = useState<HoldoutLink[]>([]);
  const [busy, setBusy] = useState(false);

  const refreshPattern = async () => {
    const p = await getPattern();
    setPattern(p);
    return p;
  };

  const run = async () => {
    setBusy(true);
    try {
      const { result, cypher } = await captureCypher(async () => {
        const p = await refreshPattern();
        if (p.requires.length === 0) {
          await createPatternFromIncident("INC-TP");
          await refreshPattern();
        }
        return scoreReadAcross();
      });
      setRows(result);
      setRunCypher(cypher);
      setCandidates(await listRequireCandidates());
    } finally {
      setBusy(false);
    }
  };

  const widen = async (id: string, add: boolean) => {
    setBusy(true);
    try {
      if (add) await addRequires(id);
      else await removeRequires(id);
      await refreshPattern();
      setRows(await scoreReadAcross());
    } finally {
      setBusy(false);
    }
  };

  const predict = async () => {
    setBusy(true);
    try {
      setHoldout(await fetchHoldout());
      setPred(await predictHeldOutLinks());
    } finally {
      setBusy(false);
    }
  };

  const recovered = useMemo(() => {
    if (!pred) return 0;
    return holdout.filter((h) =>
      pred.some(
        (p) => p.positionId === h.from && p.candidates.some((c) => c.attributeId === h.to),
      ),
    ).length;
  }, [pred, holdout]);

  return (
    <>
      <div className="business-problem">
        <GlossaryText>
          <div className="bp-title">The problem today</div>
          “Could this happen elsewhere?” takes a task force a quarter, instrument by instrument.{" "}
          <strong>How to read the screen:</strong> the template from S3 is matched against{" "}
          <strong>every position at once</strong>. Score = satisfied conditions / total. 1.00 is the
          confirmed case; everything between 0.5 and 1.0 is the early-detection story — the pattern
          forming before the loss. Click a row to audit that position's chronology in S2.
        </GlossaryText>
      </div>
      <div className="btn-row">
        <button className="demo-btn" data-testid="s4-run" disabled={busy} onClick={run}>
          Run read-across
        </button>
        <button className="demo-btn secondary" data-testid="s4-predict" disabled={busy || rows.length === 0} onClick={predict}>
          GDS · predict held-out links
        </button>
      </div>

      {pattern && rows.length > 0 && (
        <div className="panel">
          <h2>Widen / narrow the pattern live</h2>
          <div className="chips">
            {pattern.requires.map((r) => (
              <span className={`chip ${r.isGap ? "chip-gap" : "chip-attr"}`} key={r.id}>
                {r.name}
                <button className="chip-x" disabled={busy} onClick={() => widen(r.id, false)}>
                  ×
                </button>
              </span>
            ))}
            <select onChange={(e) => setAddSel(e.target.value)} value={addSel}>
              <option value="">+ add condition…</option>
              {candidates
                .filter((c) => !pattern.requires.some((r) => r.id === c.id))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
            <button
              className="demo-btn secondary"
              disabled={busy || !addSel}
              onClick={() => {
                widen(addSel, true);
                setAddSel("");
              }}
            >
              Add
            </button>
          </div>
          <p className="hint">
            The scores re-rank on every change — pattern size is not self-censored by the tool.
          </p>
        </div>
      )}

      {rows.length > 0 && (
        <div className="panel">
          <div className="card-head">
            <h2>Every position vs the pattern</h2>
            <ExplainButton
              payload={() => ({
                scene: "s4",
                selectionId: pattern?.id ?? "PATTERN-TP",
                title: "Read-across — every position vs the pattern",
                rows: { matches: rows.slice(0, 15), patternRequires: pattern?.requires ?? [] },
                cypher: runCypher,
              })}
            />
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Score</th>
                <th>Position</th>
                <th>Desk</th>
                <th>Satisfied</th>
                <th>Missing</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 15).map((r) => (
                <tr
                  className="clickable"
                  data-testid={`s4-row-${r.positionId}`}
                  key={r.positionId}
                  onClick={() => onOpenChronology(r.positionId)}
                >
                  <td>
                    <strong>{(r.score * 100).toFixed(0)}%</strong>
                    {r.confirmedIncident && <span className="pill pill-missed">incident</span>}
                    {r.positionId === "POS-FP" && (
                      <span className="pill pill-met">assessed FP</span>
                    )}
                  </td>
                  <td>{r.positionId}</td>
                  <td>{r.desk}</td>
                  <td>
                    {r.satisfied.map((s) => (
                      <span className="pill pill-met" key={s} title={s}>
                        {s.length > 26 ? s.slice(0, 26) + "…" : s}
                      </span>
                    ))}
                  </td>
                  <td>
                    {r.missing.map((s) => (
                      <span className="pill pill-pending" key={s} title={s}>
                        {s.length > 26 ? s.slice(0, 26) + "…" : s}
                      </span>
                    ))}
                  </td>
                  <td>
                    <ExplainButton
                      payload={() => ({
                        scene: "s4",
                        selectionId: r.positionId,
                        title: `Read-across match — ${r.positionId} (${(r.score * 100).toFixed(0)}%)`,
                        rows: { match: r, patternRequires: pattern?.requires ?? [] },
                        cypher: runCypher,
                      })}
                      small
                    />
                    <span className="hint-inline"> chronology →</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="hint">
            <GlossaryText>
              <strong>POS-FP</strong> is the deliberate false positive: the shape matches, but open
              its chronology — its controls did happen (approved, IPV-challenged, MAP-reviewed).
              The graph surfaces the conjunction; a human establishes intent.
            </GlossaryText>
          </p>
        </div>
      )}

      {pred && (
        <div className="panel">
          <h2>Predicted links vs held-out ground truth</h2>
          <p className="hint">
            <strong>
              {holdout.length} Position→RiskAttribute links were removed at generation time; the
              similarity model recovers {recovered} of {holdout.length} in its top-3 candidates.
            </strong>{" "}
            This is validation against held-out ground truth — not circular confirmation of the
            pattern.
          </p>
          <table className="data-table">
            <thead>
              <tr>
                <th>Position</th>
                <th>Missing attribute type</th>
                <th>Top candidates (GDS node similarity)</th>
              </tr>
            </thead>
            <tbody>
              {pred.map((p) => (
                <tr key={`${p.positionId}-${p.missingType}`}>
                  <td>{p.positionId}</td>
                  <td>{p.missingType}</td>
                  <td>
                    {p.candidates.map((c) => {
                      const hit = holdout.some(
                        (h) => h.from === p.positionId && h.to === c.attributeId,
                      );
                      return (
                        <span className={`pill ${hit ? "pill-met" : "pill-pending"}`} key={c.attributeId}>
                          {c.attributeId.replace("RA-", "")} ({c.score}) {hit ? "✓ held-out" : ""}
                        </span>
                      );
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ───────────────────────────── tab shell ─────────────────────────────

export default function ScenariosTab() {
  const [sub, setSub] = useState<SubTab>("s1");
  const [s2Position, setS2Position] = useState("POS-TP");
  const [policyEpoch, setPolicyEpoch] = useState(0);

  const openChronology = (positionId: string) => {
    setS2Position(positionId);
    setSub("s2");
  };

  return (
    <div className="scenarios-container">
      <div className="sub-nav">
        {SUB_TABS.map((t) => (
          <button
            className={`sub-tab ${sub === t.id ? "active" : ""}`}
            data-testid={`subtab-${t.id}`}
            key={t.id}
            onClick={() => setSub(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {/* key={policyEpoch} clears stale results after a policy change: rerun to see the new answers */}
      <div key={policyEpoch}>
        {sub === "s1" && <S1 onOpenChronology={openChronology} />}
        {sub === "s2" && <S2 positionId={s2Position} setPositionId={setS2Position} />}
        {sub === "s3" && <S3 />}
        {sub === "s4" && <S4 onOpenChronology={openChronology} />}
      </div>
      {sub === "policy" && <PolicyPanel onChanged={() => setPolicyEpoch((e) => e + 1)} />}
    </div>
  );
}
