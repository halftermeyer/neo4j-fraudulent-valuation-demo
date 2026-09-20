// "How it works" — an in-app stepper per Discovery panel. Content is markdown
// (one file per panel under src/content/discovery/, editable without code),
// slides split on `---`, KaTeX for the formulas. Inside these explainers the
// technical vocabulary IS allowed (Louvain, kNN, Pearson, embedding) — the ban
// applies to panel titles and result copy. Never "prediction".
// ← → navigate, Esc closes; the open is logged to the audit drawer so the
// presenter can show it was consulted.

import "katex/dist/katex.min.css";
import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { pushLogEntry } from "../lib/neo4j";

export default function DiscoveryExplainer({
  panelId,
  title,
  markdown,
}: {
  panelId: string;
  title: string;
  markdown: string;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const slides = markdown.split(/\n---\n/).map((s) => s.trim());

  const show = () => {
    setStep(0);
    setOpen(true);
    pushLogEntry({
      timestamp: new Date(),
      cypher: `// Discovery explainer opened — ${title} (${slides.length} steps)`,
      params: { panel: panelId },
      durationMs: 0,
      rowCount: slides.length,
      group: "Discovery",
    });
  };

  const move = useCallback(
    (d: number) => setStep((s) => Math.min(Math.max(s + d, 0), slides.length - 1)),
    [slides.length],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      else if (e.key === "ArrowRight") move(1);
      else if (e.key === "ArrowLeft") move(-1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, move]);

  return (
    <>
      <button
        className="disc-explainer-btn"
        data-testid={`disc-how-${panelId}`}
        onClick={show}
        title="How it works — a short technical stepper (stays on this tab)"
      >
        How it works
      </button>
      {open && (
        <div className="disc-explainer-overlay" onClick={() => setOpen(false)}>
          <div className="disc-explainer-modal" onClick={(e) => e.stopPropagation()}>
            <div className="disc-explainer-head">
              <strong>{title} — how it works</strong>
              <span className="disc-explainer-step">
                {step + 1} / {slides.length}
              </span>
              <button className="node-inspector-close" onClick={() => setOpen(false)}>
                ✕
              </button>
            </div>
            <div className="disc-explainer-body">
              <ReactMarkdown rehypePlugins={[rehypeKatex]} remarkPlugins={[remarkGfm, remarkMath]}>
                {slides[step]}
              </ReactMarkdown>
            </div>
            <div className="disc-explainer-nav">
              <button className="demo-btn secondary" disabled={step === 0} onClick={() => move(-1)}>
                ← previous
              </button>
              <span className="hint-inline">← → keys · Esc closes</span>
              <button
                className="demo-btn secondary"
                data-testid={`disc-how-${panelId}-next`}
                disabled={step === slides.length - 1}
                onClick={() => move(1)}
              >
                next →
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
