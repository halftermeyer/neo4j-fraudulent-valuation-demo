// Opt-in Glossary layer — session-only toggle (never persisted), OFF by default.
// Source of truth: src/content/glossary.json, curated by hand. Matching is
// whole-word, case-insensitive, first occurrence per paragraph scope, applied
// ONLY where a <GlossaryText> wrapper was deliberately placed (business-problem
// blocks, scenario cards, companion answers) — never in code, ids or the drawer.

import GLOSSARY from "../content/glossary.json";

export interface GlossaryEntry {
  term: string;
  aliases: string[];
  short: string;
  graphHint: string;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface CompiledEntry extends GlossaryEntry {
  regex: RegExp; // no /g — used for a single search per scan step
}

export const ENTRIES: CompiledEntry[] = (GLOSSARY as GlossaryEntry[]).map((e) => ({
  ...e,
  // custom word boundaries: \b misbehaves around '&', '-' and digits ("LOD 1")
  regex: new RegExp(
    `(?<![\\w&])(${[e.term, ...e.aliases].map(escapeRegex).join("|")})(?![\\w&])`,
    "i",
  ),
}));

// ── session store (module-level, same pattern as the audit log) ──────────────

let enabled = false;
const listeners = new Set<() => void>();

export function isGlossaryOn(): boolean {
  return enabled;
}

export function toggleGlossary(on?: boolean): void {
  enabled = on ?? !enabled;
  listeners.forEach((l) => l());
}

export function onGlossaryChange(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Earliest unseen term match in a text fragment (longest wins on ties). */
export function findFirstMatch(
  text: string,
  seen: Set<string>,
): { index: number; length: number; entry: CompiledEntry } | null {
  let best: { index: number; length: number; entry: CompiledEntry } | null = null;
  for (const entry of ENTRIES) {
    if (seen.has(entry.term)) continue;
    const m = entry.regex.exec(text);
    if (!m) continue;
    if (!best || m.index < best.index || (m.index === best.index && m[0].length > best.length)) {
      best = { index: m.index, length: m[0].length, entry };
    }
  }
  return best;
}
