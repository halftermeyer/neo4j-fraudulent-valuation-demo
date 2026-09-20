// Policy panel — step 2 of the flow (Explore → Policy → S1…S4): the nine
// ControlObligations with live-editable parameters and a rule-provenance label,
// ending with the visible "Compute governance gaps" step. Apply/Compute rewrite
// ControlObligation properties and re-materialise the GovernanceGaps with the
// same gap query; S1 stays locked until gaps have been computed once this
// session. Reset restores the CSV defaults.
//
// Provenance labels come from app/src/content/rules_provenance.json (mirrors
// docs/rules-provenance.md): every threshold below is an indicative placeholder,
// never a regulation-derived value.

import { Tooltip } from "@neo4j-ndl/react";
import { useCallback, useEffect, useState } from "react";
import provenance from "../content/rules_provenance.json";
import { markGapsComputed } from "../lib/gapSession";
import {
  computeGaps,
  listObligations,
  resetObligations,
  updateObligationParams,
  type GapRuleSummary,
  type Obligation,
} from "../lib/queries";

interface Provenance {
  status: string;
  source: string;
  quote: string;
  url: string;
}

const PROVENANCE = provenance as unknown as Record<string, Provenance>;

const STATUS_CLASS: Record<string, string> = {
  "regulatory requirement": "pill-met",
  "supervisory guidance": "pill-info",
  "industry practice, not a rule": "pill-pending",
  "public case finding": "pill-missed",
};

function SourceLabel({ ruleId }: { ruleId: string }) {
  const p = PROVENANCE[ruleId];
  if (!p) return null;
  const regulationInformed =
    p.status === "regulatory requirement" || p.status === "supervisory guidance";
  return (
    <Tooltip isPortaled type="simple">
      <Tooltip.Trigger
        className="policy-source"
        htmlAttributes={{
          onClick: () => window.open(p.url, "_blank", "noopener"),
          "aria-label": `${p.source} — ${p.quote}`,
        }}
      >
        <span className={`pill ${STATUS_CLASS[p.status] ?? "pill-info"}`}>{p.status}</span>
        {regulationInformed && <span className="policy-source-tag">regulation-informed</span>}
      </Tooltip.Trigger>
      <Tooltip.Content>
        <span className="policy-source-tip">
          {p.source}: “{p.quote}” — click to open the source. Thresholds below stay
          placeholders.
        </span>
      </Tooltip.Content>
    </Tooltip>
  );
}

export default function PolicyPanel({ onChanged }: { onChanged: () => void }) {
  const [obligations, setObligations] = useState<Obligation[]>([]);
  const [edits, setEdits] = useState<Record<string, Record<string, number | boolean>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [summary, setSummary] = useState<GapRuleSummary[] | null>(null);
  const [gapCount, setGapCount] = useState(0);

  const refresh = useCallback(async () => {
    setObligations(await listObligations());
    setEdits({});
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const setParam = (rid: string, key: string, value: number | boolean) => {
    setEdits((prev) => ({ ...prev, [rid]: { ...prev[rid], [key]: value } }));
  };

  const compute = async () => {
    setBusy("compute");
    try {
      const { summary: s, gapCount: n } = await computeGaps();
      setSummary(s);
      setGapCount(n);
      markGapsComputed(); // unlocks S1 for this session
      setNote(`${n} governance gaps materialised — same gap query every screen runs`);
      onChanged();
    } catch (e) {
      setNote(`compute failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const apply = async (o: Obligation) => {
    setBusy(o.id);
    try {
      const merged = { ...o.params, ...edits[o.id] };
      const sla = edits[o.id]?.slaDays;
      await updateObligationParams(o.id, merged, typeof sla === "number" ? sla : undefined);
      setNote(`${o.id} applied — recompute the gaps to see the new answer`);
      setSummary(null); // stale counts: the visible compute step re-creates them
      await refresh();
      onChanged();
    } catch (e) {
      setNote(`apply failed: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const reset = async () => {
    setBusy("reset");
    try {
      await resetObligations();
      setNote("all parameters restored to the CSV defaults — recompute the gaps");
      setSummary(null);
      await refresh();
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="panel policy-panel">
      <h2>Policy — the bank's control framework, formalised</h2>
      <p className="hint">
        Formalisation of the bank's own control framework. Default values are indicative
        placeholders, to be replaced by the institution's thresholds. Each rule carries its
        provenance (hover the label): a public source it echoes — never a claim that the
        threshold itself is regulation-derived. Edit one live to answer{" "}
        <em>“and if the threshold were 50&nbsp;bps?”</em>, then recompute the gaps below —
        no data is regenerated. Full provenance: <code>docs/rules-provenance.md</code>.
      </p>
      <div className="btn-row">
        <button
          className="demo-btn danger"
          data-testid="policy-reset"
          disabled={busy !== null}
          onClick={reset}
        >
          Reset to CSV defaults
        </button>
        {note && <span className="policy-note">{note}</span>}
      </div>
      <div className="policy-grid">
        {obligations.map((o) => (
          <div className="policy-card" key={o.id}>
            <div className="policy-card-head">
              <strong>
                {o.id} · {o.name}
              </strong>
              {o.status?.startsWith("candidate") ? (
                <span className="pill pill-pending" title={o.status}>
                  {o.status}
                </span>
              ) : (
                <span className={`pill ${o.severity === "high" ? "pill-missed" : "pill-pending"}`}>
                  {o.severity}
                </span>
              )}
              <span className="pill pill-info">{o.timing}</span>
            </div>
            <div className="policy-card-source">
              <span className="hint-inline">Source&nbsp;</span>
              <SourceLabel ruleId={o.id} />
            </div>
            <p className="policy-gapdef">{o.gapDefinition}</p>
            <div className="policy-params">
              {o.timing !== "STRUCTURAL" && (
                <label>
                  slaDays
                  <input
                    onChange={(e) => setParam(o.id, "slaDays", Number(e.target.value))}
                    type="number"
                    value={Number(edits[o.id]?.slaDays ?? o.slaDays)}
                  />
                </label>
              )}
              {Object.entries(o.params).map(([k, v]) =>
                typeof v === "boolean" ? (
                  <label key={k}>
                    {k}
                    <input
                      checked={Boolean(edits[o.id]?.[k] ?? v)}
                      onChange={(e) => setParam(o.id, k, e.target.checked)}
                      type="checkbox"
                    />
                  </label>
                ) : (
                  <label key={k}>
                    {k}
                    <input
                      data-testid={`policy-${o.id}-${k}`}
                      onChange={(e) => setParam(o.id, k, Number(e.target.value))}
                      step={k === "unexplainedThreshold" ? 0.005 : 1}
                      type="number"
                      value={Number(edits[o.id]?.[k] ?? v)}
                    />
                  </label>
                ),
              )}
            </div>
            <button
              className="demo-btn secondary"
              data-testid={`policy-apply-${o.id}`}
              disabled={busy !== null || !edits[o.id]}
              onClick={() => apply(o)}
            >
              {busy === o.id ? "Applying…" : "Apply"}
            </button>
          </div>
        ))}
      </div>

      {/* the flow's visible step: obligations → computed gaps → scenarios */}
      <div className="policy-compute">
        <h2>Compute governance gaps</h2>
        <p className="hint">
          One parameterised query for all nine rules, expected vs observed, thresholds read
          live from the nodes above — then materialised as <code>:GovernanceGap</code> nodes
          with the same text (open the Cypher drawer). S1 unlocks after the first run.
        </p>
        <div className="btn-row">
          <button
            className="demo-btn"
            data-testid="policy-compute"
            disabled={busy !== null || obligations.length === 0}
            onClick={compute}
          >
            {busy === "compute" ? "Computing…" : "Compute governance gaps"}
          </button>
          {summary && (
            <span className="hint">
              {gapCount} gaps materialised across the population — counts per rule below.
            </span>
          )}
        </div>
        {summary && (
          <table className="data-table" data-testid="gap-summary">
            <thead>
              <tr>
                <th>Rule</th>
                <th>MET</th>
                <th>LATE</th>
                <th>MISSED</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((s) => (
                <tr key={s.ruleId}>
                  <td>
                    <strong>{s.ruleId}</strong> {s.ruleName}
                  </td>
                  <td>
                    <span className="pill pill-met">{s.MET}</span>
                  </td>
                  <td>
                    <span className={`pill ${s.LATE > 0 ? "pill-pending" : ""}`}>{s.LATE}</span>
                  </td>
                  <td>
                    <span className={`pill ${s.MISSED > 0 ? "pill-missed" : ""}`}>{s.MISSED}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
