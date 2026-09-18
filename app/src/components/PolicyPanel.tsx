// Policy panel — the nine ControlObligations with live-editable parameters.
// Apply rewrites the ControlObligation properties and re-materialises the
// GovernanceGaps with the same gap query; S2/S4 and the Assistant change on
// their next run WITHOUT regenerating data. Reset restores the CSV defaults.

import { useCallback, useEffect, useState } from "react";
import {
  listObligations,
  resetObligations,
  updateObligationParams,
  type Obligation,
} from "../lib/queries";

export default function PolicyPanel({ onChanged }: { onChanged: () => void }) {
  const [obligations, setObligations] = useState<Obligation[]>([]);
  const [edits, setEdits] = useState<Record<string, Record<string, number | boolean>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");

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

  const apply = async (o: Obligation) => {
    setBusy(o.id);
    try {
      const merged = { ...o.params, ...edits[o.id] };
      const sla = edits[o.id]?.slaDays;
      await updateObligationParams(o.id, merged, typeof sla === "number" ? sla : undefined);
      setNote(`${o.id} applied — gaps recomputed with the same gap query`);
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
      setNote("all parameters restored to the CSV defaults — gaps recomputed");
      await refresh();
      onChanged();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="panel policy-panel">
      <h2>Policy panel — control obligations</h2>
      <p className="hint">
        Parameters are set before the demo. Edit one live to answer{" "}
        <em>“and if the threshold were 50&nbsp;bps?”</em> — Apply recomputes the gaps with the
        same query; scenario results and the Assistant change on their next run. No data is
        regenerated.
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
              <span className={`pill ${o.severity === "high" ? "pill-missed" : "pill-pending"}`}>
                {o.severity}
              </span>
              <span className="pill pill-info">{o.timing}</span>
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
              {busy === o.id ? "Recomputing…" : "Apply"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
