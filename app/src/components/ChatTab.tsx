// Assistant tab — Gemini 2.5 Flash composing the 7 typed tools from
// assistantTools.ts. Every Cypher the tools run lands in the audit drawer;
// the per-call trail is also fed back to the model as cypher_audit_trail
// (which it is instructed never to echo).
//
// Answers render as sanitised markdown (react-markdown, no raw HTML); each
// answer carries its tool results as a timeline/graph/table toggle — the
// financial PositionTimeline is the DEFAULT when the question investigated one
// position chronologically, the same NVL subgraph (event-time pinned) and the
// tables one toggle away — and a persistent row of suggestion chips whose
// clicked entry is replaced by a contextual follow-up (all answerable by the
// typed tools).

import { GoogleGenAI, type Content } from "@google/genai";
import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  executeTool,
  SYSTEM_PROMPT,
  TOOL_DECLARATIONS,
  type GraphPayload,
} from "../lib/assistantTools";
import { getQueryLog } from "../lib/neo4j";
import GraphView, { type GNode, type GRel } from "./GraphView";
import PositionTimeline from "./PositionTimeline";
import ResultGrid from "./ResultGrid";
import GlossaryText from "./Term";
import "./chat.css";

const MODEL = "gemini-2.5-flash";
const MAX_ITERATIONS = 6;

// ── persistent suggestion chips with contextual follow-ups ──────────────────
// Every hint is answerable by the typed tools (timeline, expected_controls,
// who_approved, divergence, read_across, policy_params, list_positions).

const INITIAL_HINTS = [
  "Reconstruct what happened to POS-TP, in order, and tell me which control should have fired",
  "Why is POS-FP not an incident?",
  "Which positions partially match the confirmed pattern today?",
  "What changes if the IPV divergence threshold is 100 bps?",
];

const FOLLOW_UPS: Record<string, string> = {
  [INITIAL_HINTS[0]]: "Which of these controls should have fired on POS-TP, and when exactly?",
  "Which of these controls should have fired on POS-TP, and when exactly?":
    "Who approved the methodology change MC-VAR-2012, and were they independent?",
  "Who approved the methodology change MC-VAR-2012, and were they independent?":
    "Does any other position look like POS-TP today?",
  "Does any other position look like POS-TP today?":
    "Show the observed-vs-proxy divergence history of POS-TP",
  [INITIAL_HINTS[1]]: "Which controls did fire on POS-FP, in chronological order?",
  "Which controls did fire on POS-FP, in chronological order?":
    "Who approved the price overrides on POS-FP?",
  [INITIAL_HINTS[2]]: "Reconstruct the timeline of the top partial match",
  "Reconstruct the timeline of the top partial match":
    "Which desks concentrate the current governance gaps?",
  [INITIAL_HINTS[3]]: "List the current parameters of all nine control obligations",
  "List the current parameters of all nine control obligations":
    "Which positions would still be flagged with only 3 broken rules or more?",
};

interface ToolViz {
  toolName: string;
  args: string;
  rows: Record<string, unknown>[];
  graph?: GraphPayload;
}

interface ChatMessage {
  role: "user" | "assistant" | "tool" | "error";
  text: string;
  toolName?: string;
  toolArgs?: string;
  rowCount?: number;
  viz?: ToolViz[]; // attached to assistant answers
}

function trailFromLog(startIdx: number): string {
  return getQueryLog()
    .slice(startIdx)
    .map((e, i) => `// Step ${i + 1} (${e.durationMs}ms, ${e.rowCount} rows)\n${e.cypher}`)
    .join("\n\n");
}

// ── answer visualisation: timeline / graph / table toggle ────────────────────

// tools whose use signals a chronological / price question — the financial
// timeline is then the DEFAULT answer view (same "timeline first" philosophy
// as S1); the subgraph and the tables stay one toggle away
const TIMELINE_TOOLS = new Set(["timeline", "divergence", "expected_controls"]);

/** The one position this answer investigated, if it is exactly one. */
function answerPosition(viz: ToolViz[]): { positionId: string | null; asDefault: boolean } {
  const ids = new Set<string>();
  let chrono = false;
  for (const v of viz) {
    try {
      const pid = (JSON.parse(v.args) as Record<string, unknown>).positionId;
      if (typeof pid === "string" && pid) {
        ids.add(pid);
        if (TIMELINE_TOOLS.has(v.toolName)) chrono = true;
      }
    } catch {
      // unparseable args — ignore
    }
  }
  return ids.size === 1 ? { positionId: [...ids][0], asDefault: chrono } : { positionId: null, asDefault: false };
}

function graphToView(viz: ToolViz[]): { nodes: GNode[]; rels: GRel[] } {
  const nodes = new Map<string, GNode>();
  const rels: GRel[] = [];
  viz.forEach((v, vi) => {
    if (!v.graph) return;
    const ordered = v.graph.ordered === true;
    v.graph.nodes.forEach((n) => {
      if (nodes.has(n.id)) return;
      const g: GNode = { id: n.id, label: n.label, caption: n.caption ?? n.id };
      if (ordered && n.order !== undefined) {
        // event-time axis, left-to-right; zigzag y so captions stay readable
        g.x = n.order === -1 ? -140 : n.order * 120;
        g.y = n.order === -1 ? 0 : (n.order % 2 === 0 ? -45 : 45);
        g.pinned = true;
      }
      nodes.set(n.id, g);
    });
    v.graph.rels.forEach((r, i) => rels.push({ id: `v${vi}-${r.id}-${i}`, from: r.from, to: r.to, type: r.type }));
  });
  return { nodes: [...nodes.values()], rels };
}

function AnswerViz({ viz }: { viz: ToolViz[] }) {
  const { positionId, asDefault } = answerPosition(viz);
  const [mode, setMode] = useState<"timeline" | "graph" | "table">(
    positionId && asDefault ? "timeline" : "graph",
  );
  const graph = graphToView(viz);
  const hasGraph = graph.nodes.length > 0;
  const effective =
    mode === "timeline" && positionId ? "timeline" : mode === "graph" && hasGraph ? "graph" : mode === "graph" ? "table" : mode;
  return (
    <div className="answer-viz">
      <div className="answer-viz-toggle">
        {positionId && (
          <button
            className={effective === "timeline" ? "active" : ""}
            data-testid="answer-viz-timeline"
            onClick={() => setMode("timeline")}
          >
            📈 timeline
          </button>
        )}
        {hasGraph && (
          <button className={effective === "graph" ? "active" : ""} onClick={() => setMode("graph")}>
            graph
          </button>
        )}
        <button className={effective === "table" ? "active" : ""} onClick={() => setMode("table")}>
          table
        </button>
        <span className="hint-inline">
          {viz.map((v) => v.toolName).join(" · ")} — click a node to inspect it; table ids open
          Explore
        </span>
      </div>
      {effective === "timeline" && positionId ? (
        // the same one-query financial view as S1/S2/S4 — the model never sees it
        <PositionTimeline height={300} positionId={positionId} />
      ) : effective === "graph" ? (
        // click = inspect in place; the inspector's "Open in Explore →" jumps tabs
        <GraphView height={320} nodes={graph.nodes} rels={graph.rels} />
      ) : (
        viz
          .filter((v) => v.rows.length > 0)
          .map((v, i) => (
            <div className="answer-viz-table" key={i}>
              <div className="hint">
                {v.toolName}({v.args})
              </div>
              <ResultGrid rows={v.rows} />
            </div>
          ))
      )}
    </div>
  );
}

// ── the tab ──────────────────────────────────────────────────────────────────

export default function ChatTab() {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY as string | undefined;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hints, setHints] = useState<string[]>(INITIAL_HINTS);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const historyRef = useRef<Content[]>([]);

  if (!apiKey) {
    return (
      <div className="panel chat-empty">
        <h2>Assistant not configured</h2>
        <p className="hint">
          Set <code>VITE_GEMINI_API_KEY</code> in <code>app/.env</code> (derived from{" "}
          <code>inputs/.env</code> by <code>make env</code>) and reload.
        </p>
      </div>
    );
  }

  const push = (m: ChatMessage) => setMessages((prev) => [...prev, m]);

  const advanceHints = (clicked: string) => {
    setHints((prev) => {
      const idx = prev.indexOf(clicked);
      if (idx === -1) return prev; // typed question — chips unchanged
      const next = [...prev];
      const followUp = FOLLOW_UPS[clicked];
      if (followUp && !prev.includes(followUp)) {
        next[idx] = followUp;
      } else {
        // exhausted chain: fall back to any initial hint not currently shown
        const fresh = INITIAL_HINTS.find((h) => !prev.includes(h) && h !== clicked);
        if (fresh) next[idx] = fresh;
      }
      return next;
    });
  };

  async function ask(question: string) {
    if (busy || !question.trim()) return;
    setInput("");
    push({ role: "user", text: question });
    advanceHints(question);
    setBusy(true);
    const viz: ToolViz[] = [];
    try {
      const ai = new GoogleGenAI({ apiKey });
      historyRef.current.push({ role: "user", parts: [{ text: question }] });

      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const resp = await ai.models.generateContent({
          model: MODEL,
          contents: historyRef.current,
          config: {
            systemInstruction: SYSTEM_PROMPT,
            tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
          },
        });

        const content = resp.candidates?.[0]?.content;
        if (!content) throw new Error("Empty response from the model");
        historyRef.current.push(content);

        const calls = (content.parts ?? []).filter((p) => p.functionCall);
        if (calls.length === 0) {
          push({ role: "assistant", text: resp.text ?? "(no answer)", viz: [...viz] });
          break;
        }

        const responses: Content = { role: "user", parts: [] };
        for (const part of calls) {
          const fc = part.functionCall!;
          const name = fc.name ?? "unknown";
          const args = (fc.args ?? {}) as Record<string, unknown>;
          const logStart = getQueryLog().length;
          let payload: string;
          let rowCount = 0;
          try {
            const result = await executeTool(name, args);
            rowCount = result.rows.length;
            viz.push({
              toolName: name,
              args: JSON.stringify(args),
              rows: result.rows as Record<string, unknown>[],
              graph: result.graph,
            });
            // the model gets the rows (not the display graph) + the audit trail
            payload = JSON.stringify({ result: result.rows, cypher_audit_trail: trailFromLog(logStart) });
          } catch (e) {
            payload = JSON.stringify({ error: (e as Error).message });
          }
          push({ role: "tool", text: "", toolName: name, toolArgs: JSON.stringify(args), rowCount });
          responses.parts!.push({ functionResponse: { name, response: { result: payload } } });
        }
        historyRef.current.push(responses);
        if (i === MAX_ITERATIONS - 1) {
          push({ role: "error", text: "Stopped after too many tool iterations." });
        }
      }
    } catch (e) {
      push({ role: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const chips = (
    <div className="chat-suggestions">
      {hints.map((s, i) => (
        <button
          className="chat-chip"
          data-testid={`chat-chip-${i}`}
          disabled={busy}
          key={s}
          onClick={() => ask(s)}
        >
          {s}
        </button>
      ))}
    </div>
  );

  return (
    <div className="chat-container">
      <div className="business-problem">
        <GlossaryText>
          <div className="bp-title">Why this tab exists</div>
          A natural-language, <strong>chronological</strong> investigation is a validation
          criterion for this demo. The assistant composes <strong>typed tools</strong> over the
          same audited query functions the UI uses — it is not free-form text-to-Cypher. Open
          the Cypher drawer while it answers.
        </GlossaryText>
      </div>

      <div className="chat-messages">
        {messages.map((m, i) =>
          m.role === "tool" ? (
            <div className="chat-tool" key={i}>
              ⚙ <code>{m.toolName}</code>
              <span className="chat-tool-args">{m.toolArgs}</span>
              <span className="chat-tool-rows">{m.rowCount} rows</span>
            </div>
          ) : (
            <div className={`chat-bubble chat-${m.role}`} key={i}>
              {m.role === "assistant" ? (
                <>
                  <div className="chat-markdown">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>
                  </div>
                  {m.viz && m.viz.length > 0 && <AnswerViz viz={m.viz} />}
                </>
              ) : (
                m.text
              )}
            </div>
          ),
        )}
        {busy && <div className="chat-bubble chat-assistant chat-thinking">Investigating…</div>}
        {chips}
      </div>

      <div className="chat-input-row">
        <input
          className="chat-input"
          data-testid="chat-input"
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ask(input)}
          placeholder="Ask about a position, a control, a chronology…"
          value={input}
        />
        <button className="demo-btn" disabled={busy} onClick={() => ask(input)}>
          Ask
        </button>
      </div>
    </div>
  );
}
