// AI companion side panel — persistent across tab changes (mounted in App),
// toggled from the top bar, sits next to the audit drawer. Explanations are
// GROUNDED: they receive only what is on screen (see lib/companion.ts).

import { useEffect, useRef, useState } from "react";
import {
  askAboutThis,
  getCompanionState,
  onCompanionChange,
  requestExplain,
  setCompanionLang,
  toggleCompanion,
  type ExplainPayload,
  type Lang,
} from "../lib/companion";

/** The "Explain" button placed on scenario cards, rows and the node inspector. */
export function ExplainButton({
  payload,
  small,
}: {
  payload: () => ExplainPayload | Promise<ExplainPayload>;
  small?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={small ? "explain-btn explain-btn-small" : "explain-btn"}
      disabled={busy}
      onClick={async (e) => {
        e.stopPropagation();
        setBusy(true);
        try {
          await requestExplain(await payload());
        } finally {
          setBusy(false);
        }
      }}
      title="Grounded explanation of what is on screen — context shown in the Cypher drawer"
    >
      ✦ Explain
    </button>
  );
}

export default function CompanionPanel() {
  const [, force] = useState(0);
  const [question, setQuestion] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => onCompanionChange(() => force((n) => n + 1)), []);
  const s = getCompanionState();

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [s.entries.length, s.busy]);

  if (!s.open) return null;

  const langBtn = (lang: Lang, label: string) => (
    <button
      className={`companion-lang ${s.lang === lang ? "active" : ""}`}
      onClick={() => setCompanionLang(lang)}
    >
      {label}
    </button>
  );

  return (
    <aside className="companion-panel">
      <div className="companion-head">
        <h2>✦ AI companion</h2>
        <div className="companion-head-actions">
          {langBtn("en", "EN")}
          {langBtn("fr", "FR")}
          <button className="companion-lang" onClick={() => toggleCompanion(false)}>✕</button>
        </div>
      </div>
      <p className="companion-hint">
        Explanations are grounded: the model receives only the rows on screen, the active policy
        parameters and the Cypher that produced them — the exact context is in the Cypher drawer.
      </p>
      <div className="companion-body" ref={bodyRef}>
        {s.entries.length === 0 && !s.busy && (
          <div className="companion-empty">
            Click <strong>✦ Explain</strong> on any scenario card, gap row, match row or selected
            node.
          </div>
        )}
        {s.entries.map((e) => (
          <div className="companion-entry" key={e.id}>
            <div className="companion-entry-head">
              <span className="pill pill-info">{e.scene}</span>
              <span className="companion-entry-title">{e.title}</span>
              {e.pregenerated && <span className="pill pill-met">pre-generated</span>}
              {!e.pregenerated && e.text && <span className="pill pill-pending">live</span>}
            </div>
            {e.question && <div className="companion-question">“{e.question}”</div>}
            {e.text && <div className="companion-text">{e.text}</div>}
            {e.error && <div className="companion-error">⚠ {e.error}</div>}
          </div>
        ))}
        {s.busy && <div className="companion-thinking">Explaining…</div>}
      </div>
      <div className="companion-ask">
        <input
          disabled={s.busy || !s.lastPayload}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && question.trim()) {
              askAboutThis(question);
              setQuestion("");
            }
          }}
          placeholder={
            s.lastPayload
              ? `Ask about this (${s.lastPayload.selectionId})…`
              : "Ask about this — click Explain first"
          }
          value={question}
        />
        <button
          className="demo-btn"
          disabled={s.busy || !s.lastPayload || !question.trim()}
          onClick={() => {
            askAboutThis(question);
            setQuestion("");
          }}
        >
          Ask
        </button>
      </div>
    </aside>
  );
}
