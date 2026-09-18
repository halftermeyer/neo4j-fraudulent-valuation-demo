// AI companion — grounded on-screen explanations, from any tab.
//
// An "Explain" click sends EXACTLY: the scene id, the rows the scenario query
// returned (or the selected node's already-loaded details), the active
// ControlObligation parameters and the Cypher that produced the rows. No free
// graph traversal. The typed Assistant tools are reused ONLY for follow-up
// questions typed in the panel, still scoped to the current selection.
//
// Responses come from a pre-generated cache (data/explanations.json, built by
// scripts/pregen_explanations.py and keyed by sha256(scene|selection|params|lang))
// or from a live Gemini call on a miss. Every request+response is logged to the
// audit drawer like a Cypher call, with the context payload as `contextSent`.

import { GoogleGenAI } from "@google/genai";
import { executeTool, TOOL_DECLARATIONS } from "./assistantTools";
import { focusNodeMention } from "./focus";
import { getQueryLog, pushLogEntry } from "./neo4j";
import { listObligations, type Obligation } from "./queries";

export type Lang = "en" | "fr";

export interface ExplainPayload {
  scene: "explore" | "s1" | "s2" | "s2-gap" | "s3" | "s4";
  selectionId: string;
  title: string; // human label shown in the panel
  rows: unknown; // the exact rows / node details already on screen
  cypher: string; // the statements that produced them
}

export interface CompanionEntry {
  id: number;
  kind: "explain" | "ask";
  scene: string;
  selectionId: string;
  title: string;
  question?: string;
  text?: string;
  error?: string;
  pregenerated: boolean;
  lang: Lang;
}

// ── module-level store (same pattern as the audit log) ──────────────────────

interface CompanionState {
  open: boolean;
  lang: Lang;
  busy: boolean;
  entries: CompanionEntry[];
  lastPayload: ExplainPayload | null;
}

const state: CompanionState = { open: false, lang: "en", busy: false, entries: [], lastPayload: null };
let _id = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function getCompanionState(): CompanionState {
  return state;
}
export function onCompanionChange(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function toggleCompanion(open?: boolean): void {
  state.open = open ?? !state.open;
  notify();
}
export function setCompanionLang(lang: Lang): void {
  state.lang = lang;
  notify();
}

// ── system prompts (mirrored in scripts/pregen_explanations.py — keep in sync) ──

const SYSTEM_EN = `You are the on-screen explanation companion of a mismarking (fraudulent-valuation) detection demo on a Neo4j graph.
The audience are SENIOR OPERATIONAL-RISK EXPERTS: never define IPV, MAP, P&L attribution, read-across or any business term. Explain what is on screen and how to read it.
Fixed shape, 3 to 5 sentences, in this order: (1) what you are looking at; (2) why the conjunction / the gap / the score is informative; (3) what an investigator would check next.
When events are involved, keep STRICT chronological order and cite event ids in parentheses, e.g. (PO-TP-03).
Your ONLY ground truth is the provided context (rows, obligation parameters, cypher). If something is not in it, say it is not shown here — never guess.
The graph detects conjunctions of weak signals, never fraud; a human establishes intent.
Respond in English. Plain prose, no headings, no bullet lists.`;

const SYSTEM_FR = `Tu es le compagnon d'explication à l'écran d'une démo de détection de mismarking (valorisation frauduleuse) sur un graphe Neo4j.
Le public est composé d'EXPERTS SENIORS du risque opérationnel : ne définis jamais IPV, MAP, attribution de P&L, read-across ni aucun terme métier. Explique ce qui est à l'écran et comment le lire.
Forme fixe, 3 à 5 phrases, dans cet ordre : (1) ce que vous regardez ; (2) pourquoi la conjonction / l'écart / le score est informatif ; (3) ce qu'un investigateur vérifierait ensuite.
Quand des événements sont impliqués, respecte STRICTEMENT l'ordre chronologique et cite les identifiants d'événements entre parenthèses, p. ex. (PO-TP-03).
Ta SEULE vérité terrain est le contexte fourni (lignes, paramètres d'obligations, cypher). Si une information n'y figure pas, dis qu'elle n'est pas affichée ici — ne devine jamais.
Le graphe détecte des conjonctions de signaux faibles, jamais la fraude ; l'intention relève d'un humain.
Réponds en français. Prose simple, sans titres ni listes à puces.`;

export function systemPrompt(lang: Lang): string {
  return lang === "fr" ? SYSTEM_FR : SYSTEM_EN;
}

// ── cache key — MUST match scripts/pregen_explanations.py byte for byte ──────

function fmtParamValue(v: unknown): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

export function canonicalParams(obligations: Obligation[]): string {
  return [...obligations]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((o) => {
      const kv = Object.keys(o.params)
        .sort()
        .map((k) => `${k}=${fmtParamValue(o.params[k])}`)
        .join(",");
      return `${o.id}{slaDays=${o.slaDays};${kv}}`;
    })
    .join(";");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function cacheKey(
  scene: string,
  selectionId: string,
  obligations: Obligation[],
  lang: Lang,
): Promise<string> {
  return sha256Hex(`${scene}|${selectionId}|${canonicalParams(obligations)}|${lang}`);
}

// ── pre-generated + in-memory caches ────────────────────────────────────────

let _pregen: Record<string, { text: string }> | null | undefined;
const _memory = new Map<string, string>();

async function pregenCache(): Promise<Record<string, { text: string }>> {
  if (_pregen === undefined) {
    try {
      const resp = await fetch("/data/explanations.json");
      _pregen = resp.ok ? await resp.json() : null;
    } catch {
      _pregen = null;
    }
  }
  return _pregen ?? {};
}

// ── the Cypher that produced the rows: capture a run's audit slice ──────────

export async function captureCypher<T>(fn: () => Promise<T>): Promise<{ result: T; cypher: string }> {
  const start = getQueryLog().length;
  const result = await fn();
  const cypher = getQueryLog()
    .slice(start)
    .map((e) => e.cypher)
    .join(";\n\n");
  return { result, cypher };
}

// ── the two entry points ────────────────────────────────────────────────────

function userMessage(payload: ExplainPayload, obligations: Obligation[], lang: Lang): string {
  const head =
    lang === "fr"
      ? "Explique ce qui est à l'écran. Contexte (seule vérité terrain) :"
      : "Explain what is on screen. Context (the only ground truth):";
  return `${head}
scene: ${payload.scene}
selection: ${payload.selectionId} — ${payload.title}
rows:
${JSON.stringify(payload.rows, null, 1)}
active ControlObligation parameters:
${JSON.stringify(obligations.map((o) => ({ id: o.id, slaDays: o.slaDays, params: o.params })), null, 1)}
cypher that produced the rows:
${payload.cypher}`;
}

async function callGemini(system: string, contents: string): Promise<string> {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY as string | undefined;
  if (!apiKey) throw new Error("VITE_GEMINI_API_KEY not set — live explanations unavailable");
  const ai = new GoogleGenAI({ apiKey });
  const resp = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents,
    config: { systemInstruction: system },
  });
  const text = resp.text?.trim();
  if (!text) throw new Error("empty response from the model");
  return text;
}

function logToAudit(
  kind: string,
  payload: ExplainPayload,
  obligations: Obligation[],
  lang: Lang,
  durationMs: number,
  text?: string,
  error?: string,
  pregenerated = false,
): void {
  pushLogEntry({
    timestamp: new Date(),
    cypher: `// AI companion — ${kind} ${payload.scene}:${payload.selectionId} [${lang}]${pregenerated ? " [pre-generated]" : " [live Gemini]"}`,
    params: {
      contextSent: {
        scene: payload.scene,
        selectionId: payload.selectionId,
        rows: payload.rows,
        obligationParams: Object.fromEntries(
          obligations.map((o) => [o.id, { slaDays: o.slaDays, ...o.params }]),
        ),
        cypher: payload.cypher,
      },
    },
    durationMs,
    rowCount: text ? 1 : 0,
    results: text ? [{ response: text }] : undefined,
    error,
    group: "AI companion",
  });
}

/** Explain button entry point — grounded, cached, audited. */
export async function requestExplain(payload: ExplainPayload): Promise<void> {
  state.open = true;
  state.busy = true;
  state.lastPayload = payload;
  notify();
  const lang = state.lang;
  const start = performance.now();
  const entry: CompanionEntry = {
    id: ++_id,
    kind: "explain",
    scene: payload.scene,
    selectionId: payload.selectionId,
    title: payload.title,
    pregenerated: false,
    lang,
  };
  try {
    const obligations = await listObligations(); // active params — part of the grounding
    const key = await cacheKey(payload.scene, payload.selectionId, obligations, lang);
    const pre = (await pregenCache())[key];
    if (pre) {
      entry.text = pre.text;
      entry.pregenerated = true;
    } else if (_memory.has(key)) {
      entry.text = _memory.get(key);
    } else {
      entry.text = await callGemini(systemPrompt(lang), userMessage(payload, obligations, lang));
      _memory.set(key, entry.text);
    }
    logToAudit("explain", payload, obligations, lang,
      Math.round(performance.now() - start), entry.text, undefined, entry.pregenerated);
  } catch (e) {
    entry.error = (e as Error).message;
    logToAudit("explain", payload, [], lang, Math.round(performance.now() - start), undefined, entry.error);
  }
  // focus the first node id the explanation cites (graph or table) BEFORE the text shows
  if (entry.text) focusNodeMention(entry.text);
  state.entries = [...state.entries, entry];
  state.busy = false;
  notify();
}

/** Glossary click — "show me how <term> appears in this graph", grounded on the
 *  current selection when one exists, on the graphHint alone otherwise. */
export async function askGlossary(term: string, graphHint: string): Promise<void> {
  state.open = true;
  notify();
  await askAboutThis(
    `Show me how "${term}" appears in this graph for the current selection.`,
    `Glossary hint (how the concept appears in this graph): ${graphHint}`,
  );
}

/** "Ask about this" — typed tools only, scoped to the current selection. */
export async function askAboutThis(question: string, extraContext?: string): Promise<void> {
  const payload: ExplainPayload = state.lastPayload ?? {
    scene: "explore",
    selectionId: "none",
    title: "no current selection",
    rows: [],
    cypher: "// no scenario has been run yet",
  };
  if (!question.trim()) return;
  state.busy = true;
  notify();
  const lang = state.lang;
  const start = performance.now();
  const entry: CompanionEntry = {
    id: ++_id,
    kind: "ask",
    scene: payload.scene,
    selectionId: payload.selectionId,
    title: payload.title,
    question,
    pregenerated: false,
    lang,
  };
  try {
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY as string | undefined;
    if (!apiKey) throw new Error("VITE_GEMINI_API_KEY not set");
    const obligations = await listObligations();
    const ai = new GoogleGenAI({ apiKey });
    const scopeRule =
      payload.selectionId === "none"
        ? lang === "fr"
          ? "\nAucune sélection courante : appuie-toi sur l'indice fourni et n'utilise les outils que pour illustrer le concept, avec parcimonie."
          : "\nNo current selection: rely on the provided hint and use the tools only to illustrate the concept, sparingly."
        : lang === "fr"
          ? `\nLa question porte sur la sélection courante (${payload.selectionId}). N'utilise les outils QUE pour cette sélection ; ne parcours pas le reste du graphe.`
          : `\nThe question concerns the current selection (${payload.selectionId}). Use the tools ONLY for this selection; do not roam the rest of the graph.`;
    const history: object[] = [
      {
        role: "user",
        parts: [{
          text: `${userMessage(payload, obligations, lang)}${extraContext ? `\n${extraContext}` : ""}\n\nQuestion: ${question}`,
        }],
      },
    ];
    for (let i = 0; i < 4; i++) {
      const resp = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: history,
        config: {
          systemInstruction: systemPrompt(lang) + scopeRule,
          tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        },
      });
      const content = resp.candidates?.[0]?.content;
      if (!content) throw new Error("empty response from the model");
      history.push(content);
      const calls = (content.parts ?? []).filter((p) => p.functionCall);
      if (calls.length === 0) {
        entry.text = resp.text?.trim() ?? "(no answer)";
        break;
      }
      const responses = { role: "user", parts: [] as object[] };
      for (const part of calls) {
        const fc = part.functionCall!;
        let result: unknown;
        try {
          // tools return {rows, graph}; the model only needs the rows
          result = (await executeTool(fc.name ?? "", (fc.args ?? {}) as Record<string, unknown>)).rows;
        } catch (e) {
          result = { error: (e as Error).message };
        }
        responses.parts.push({
          functionResponse: { name: fc.name, response: { result: JSON.stringify(result) } },
        });
      }
      history.push(responses);
      if (i === 3) entry.error = "stopped after too many tool iterations";
    }
    logToAudit(`ask "${question.slice(0, 60)}"`, payload, obligations, lang,
      Math.round(performance.now() - start), entry.text, entry.error);
  } catch (e) {
    entry.error = (e as Error).message;
    logToAudit(`ask "${question.slice(0, 60)}"`, payload, [], lang,
      Math.round(performance.now() - start), undefined, entry.error);
  }
  if (entry.text) focusNodeMention(entry.text);
  state.entries = [...state.entries, entry];
  state.busy = false;
  notify();
}
