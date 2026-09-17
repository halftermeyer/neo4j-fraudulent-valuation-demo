// Assistant tab — Gemini 2.5 Flash composing the 7 typed tools from
// assistantTools.ts. Every Cypher the tools run lands in the audit drawer;
// the per-call trail is also fed back to the model as cypher_audit_trail
// (which it is instructed never to echo).

import { GoogleGenAI, type Content } from "@google/genai";
import { useRef, useState } from "react";
import { executeTool, SYSTEM_PROMPT, TOOL_DECLARATIONS } from "../lib/assistantTools";
import { getQueryLog } from "../lib/neo4j";
import "./chat.css";

const MODEL = "gemini-2.5-flash";
const MAX_ITERATIONS = 6;

const SUGGESTIONS = [
  "Reconstruct what happened to POS-TP, in order, and tell me which control should have fired",
  "Why is POS-FP not an incident?",
  "Which positions partially match the confirmed pattern today?",
  "What changes if the IPV divergence threshold is 100 bps?",
];

interface ChatMessage {
  role: "user" | "assistant" | "tool" | "error";
  text: string;
  toolName?: string;
  toolArgs?: string;
  rowCount?: number;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// minimal markdown: code fences, inline code, bold, italics, headings, lists, tables stay preformatted
function formatMarkdown(raw: string): string {
  let s = escapeHtml(raw);
  s = s.replace(/```([\s\S]*?)```/g, (_, code) => `<pre>${code}</pre>`);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|\n)### (.*)/g, "$1<strong>$2</strong>");
  s = s.replace(/(^|\n)## (.*)/g, "$1<strong>$2</strong>");
  s = s.replace(/(^|\n)[-•] (.*)/g, "$1&nbsp;• $2");
  s = s.replace(/\n/g, "<br/>");
  return s;
}

function trailFromLog(startIdx: number): string {
  return getQueryLog()
    .slice(startIdx)
    .map(
      (e, i) =>
        `// Step ${i + 1} (${e.durationMs}ms, ${e.rowCount} rows)\n${e.cypher}`,
    )
    .join("\n\n");
}

export default function ChatTab() {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY as string | undefined;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
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

  async function ask(question: string) {
    if (busy || !question.trim()) return;
    setInput("");
    push({ role: "user", text: question });
    setBusy(true);
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
          push({ role: "assistant", text: resp.text ?? "(no answer)" });
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
            rowCount = Array.isArray(result) ? result.length : 1;
            payload = JSON.stringify({ result, cypher_audit_trail: trailFromLog(logStart) });
          } catch (e) {
            payload = JSON.stringify({ error: (e as Error).message });
          }
          push({
            role: "tool",
            text: "",
            toolName: name,
            toolArgs: JSON.stringify(args),
            rowCount,
          });
          responses.parts!.push({
            functionResponse: { name, response: { result: payload } },
          });
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

  return (
    <div className="chat-container">
      <div className="business-problem">
        <div className="bp-title">Why this tab exists</div>
        A natural-language, <strong>chronological</strong> investigation is a validation
        criterion for this demo. The assistant composes <strong>typed tools</strong> over the
        same audited query functions the UI uses — it is not free-form text-to-Cypher. Open the
        Cypher drawer while it answers.
      </div>

      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="chat-suggestions">
            {SUGGESTIONS.map((s) => (
              <button className="chat-chip" key={s} onClick={() => ask(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
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
                <div dangerouslySetInnerHTML={{ __html: formatMarkdown(m.text) }} />
              ) : (
                m.text
              )}
            </div>
          ),
        )}
        {busy && <div className="chat-bubble chat-assistant chat-thinking">Investigating…</div>}
      </div>

      <div className="chat-input-row">
        <input
          className="chat-input"
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
