#!/usr/bin/env python3
"""Pre-generate the AI-companion explanations for the scripted demo path.

Walks: Explore POS-TP (node view), S1–S4 on POS-TP and POS-FP, each S2 gap of
both, S3/S4 on the pattern — in EN and FR — and writes data/explanations.json
(+ a copy under app/public/data/) keyed by
    sha256(f"{scene}|{selectionId}|{canonical ControlObligation params}|{lang}")
The key computation MUST stay byte-identical to app/src/lib/companion.ts.

⚠ Re-run (`make explain`) after editing the Policy defaults or regenerating the
data — the key includes the active parameters, so stale entries simply stop
matching and the panel falls back to live Gemini calls.

Requires: loaded database (make data && make load) and GEMINI_API_KEY.
"""

import hashlib
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from google import genai  # noqa: E402

from mcp_server import (  # noqa: E402  (reuses driver, .env, gap query)
    AS_OF_DEFAULT,
    run_cypher,
    tool_expected_controls,
    tool_timeline,
)

OUT = ROOT / "data" / "explanations.json"
APP_OUT = ROOT / "app" / "public" / "data" / "explanations.json"
MODEL = "gemini-2.5-flash"
LANGS = ["en", "fr"]

# ── system prompts — mirrored from app/src/lib/companion.ts (keep in sync) ────

SYSTEM_EN = """You are the on-screen explanation companion of a mismarking (fraudulent-valuation) detection demo on a Neo4j graph.
The audience are SENIOR OPERATIONAL-RISK EXPERTS: never define IPV, MAP, P&L attribution, read-across or any business term. Explain what is on screen and how to read it.
Fixed shape, 3 to 5 sentences, in this order: (1) what you are looking at; (2) why the conjunction / the gap / the score is informative; (3) what an investigator would check next.
When events are involved, keep STRICT chronological order and cite event ids in parentheses, e.g. (PO-TP-03).
Your ONLY ground truth is the provided context (rows, obligation parameters, cypher). If something is not in it, say it is not shown here — never guess.
The graph detects conjunctions of weak signals, never fraud; a human establishes intent.
Respond in English. Plain prose, no headings, no bullet lists."""

SYSTEM_FR = """Tu es le compagnon d'explication à l'écran d'une démo de détection de mismarking (valorisation frauduleuse) sur un graphe Neo4j.
Le public est composé d'EXPERTS SENIORS du risque opérationnel : ne définis jamais IPV, MAP, attribution de P&L, read-across ni aucun terme métier. Explique ce qui est à l'écran et comment le lire.
Forme fixe, 3 à 5 phrases, dans cet ordre : (1) ce que vous regardez ; (2) pourquoi la conjonction / l'écart / le score est informatif ; (3) ce qu'un investigateur vérifierait ensuite.
Quand des événements sont impliqués, respecte STRICTEMENT l'ordre chronologique et cite les identifiants d'événements entre parenthèses, p. ex. (PO-TP-03).
Ta SEULE vérité terrain est le contexte fourni (lignes, paramètres d'obligations, cypher). Si une information n'y figure pas, dis qu'elle n'est pas affichée ici — ne devine jamais.
Le graphe détecte des conjonctions de signaux faibles, jamais la fraude ; l'intention relève d'un humain.
Réponds en français. Prose simple, sans titres ni listes à puces."""

GAP_QUERY_TEXT = (ROOT / "data" / "gap_query.cypher").read_text()


# ── cache key — byte-identical to companion.ts ───────────────────────────────

def fmt_param_value(v) -> str:
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def load_obligations() -> list[dict]:
    rows = run_cypher(
        "MATCH (o:ControlObligation) "
        "RETURN o.id AS id, o.slaDays AS slaDays, o.paramsJson AS paramsJson ORDER BY o.id")
    return [{"id": r["id"], "slaDays": r["slaDays"], "params": json.loads(r["paramsJson"] or "{}")}
            for r in rows]


def canonical_params(obligations: list[dict]) -> str:
    parts = []
    for o in sorted(obligations, key=lambda x: x["id"]):
        kv = ",".join(f"{k}={fmt_param_value(o['params'][k])}" for k in sorted(o["params"]))
        parts.append(f"{o['id']}{{slaDays={fmt_param_value(o['slaDays'])};{kv}}}")
    return ";".join(parts)


def cache_key(scene: str, selection_id: str, obligations: list[dict], lang: str) -> str:
    raw = f"{scene}|{selection_id}|{canonical_params(obligations)}|{lang}"
    return hashlib.sha256(raw.encode()).hexdigest()


# ── context builders (same DB, equivalent rows to what the app shows) ────────

def node_context(node_id: str) -> dict:
    rows = run_cypher(
        """MATCH (n) WHERE n.id = $id
           WITH n LIMIT 1
           OPTIONAL MATCH (n)-[r]-(m)
           WITH n, type(r) AS relType,
                CASE WHEN r IS NULL THEN null WHEN startNode(r) = n THEN 'out' ELSE 'in' END AS dir,
                count(*) AS cnt, collect(coalesce(m.name, m.id))[..4] AS sample
           RETURN [l IN labels(n) WHERE l <> 'Event'] AS labels, properties(n) AS props,
                  collect(CASE WHEN relType IS NULL THEN null
                               ELSE {type: relType, dir: dir, count: cnt, sample: sample} END) AS rels""",
        {"id": node_id})
    r = rows[0]
    return {"properties": r["props"], "neighbourhood": [x for x in r["rels"] if x]}


def conjunction_rows() -> list[dict]:
    return run_cypher(
        """MATCH (p:Position)-[:ON_DESK]->(d:Desk)
           OPTIONAL MATCH (p)-[:GENERATED_SIGNAL]->(s:PnLSignal)
           OPTIONAL MATCH (p)-[:OVERRIDDEN_BY]->(po:PriceOverride)
           OPTIONAL MATCH (p)-[:CHANGED_TO]->(mc:MethodologyChange)
           OPTIONAL MATCH (g:GovernanceGap {abstract: false})-[:ON_POSITION]->(p)
           WITH p, d, count(DISTINCT s) AS signals, count(DISTINCT po) AS overrides,
                count(DISTINCT mc) AS methodChanges, collect(DISTINCT g.ruleId) AS brokenRules
           WITH p, d, signals, overrides, methodChanges, brokenRules,
                (signals + overrides + methodChanges) * size(brokenRules) AS score
           WHERE score > 0
           RETURN p.id AS positionId, d.name AS desk, signals, overrides, methodChanges,
                  brokenRules, score ORDER BY score DESC LIMIT 12""")


def gaps_of(position_id: str) -> list[dict]:
    rows = tool_expected_controls(position_id)
    return [r for r in rows if r.get("status") in ("MISSED", "LATE")]


def pattern_context() -> dict:
    rows = run_cypher(
        """MATCH (pat:Pattern {id: 'PATTERN-TP'})
           OPTIONAL MATCH (pat)-[:REQUIRES]->(t)
           RETURN pat.name AS name, pat.fromIncident AS fromIncident,
                  collect({id: t.id, name: coalesce(t.name, t.type + '=' + t.value),
                           isGap: 'GovernanceGap' IN labels(t)}) AS requires""")
    return rows[0]


def readacross_rows() -> list[dict]:
    return run_cypher(
        """MATCH (pat:Pattern {id: 'PATTERN-TP'})-[:REQUIRES]->(t)
           WITH collect(t) AS targets
           MATCH (p:Position)
           WITH p, targets,
                [t IN targets WHERE
                   (t:RiskAttribute AND EXISTS { MATCH (p)-[:HAS_RISK_ATTRIBUTE]->(t) })
                   OR (t:GovernanceGap AND EXISTS {
                        MATCH (g:GovernanceGap {abstract: false, positionId: p.id})-[:INSTANCE_OF]->(t) })
                 | coalesce(t.name, t.type + '=' + t.value)] AS satisfied
           WITH p, targets, satisfied,
                toFloat(size(satisfied)) / size(targets) AS score
           WHERE score > 0.3
           RETURN p.id AS positionId, satisfied, score,
                  EXISTS { MATCH (:Incident)-[:CAUSED_BY]->(p) } AS confirmedIncident
           ORDER BY score DESC LIMIT 15""")


def user_message(payload: dict, obligations: list[dict], lang: str) -> str:
    head = ("Explique ce qui est à l'écran. Contexte (seule vérité terrain) :" if lang == "fr"
            else "Explain what is on screen. Context (the only ground truth):")
    obl = [{"id": o["id"], "slaDays": o["slaDays"], "params": o["params"]} for o in obligations]
    return (f"{head}\nscene: {payload['scene']}\n"
            f"selection: {payload['selectionId']} — {payload['title']}\n"
            f"rows:\n{json.dumps(payload['rows'], indent=1, default=str)}\n"
            f"active ControlObligation parameters:\n{json.dumps(obl, indent=1)}\n"
            f"cypher that produced the rows:\n{payload['cypher']}")


def build_scenes() -> list[dict]:
    scenes = []
    # Explore — the scripted reveal lands on POS-TP
    scenes.append({"scene": "explore", "selectionId": "POS-TP",
                   "title": "Position POS-TP (node view)",
                   "rows": node_context("POS-TP"),
                   "cypher": "// node inspector: properties + 1-hop relationship summary"})
    conj = conjunction_rows()
    for pos in ("POS-TP", "POS-FP"):
        scenes.append({"scene": "s1", "selectionId": pos,
                       "title": f"Conjunction ranking — {pos}", "rows": conj,
                       "cypher": "// S1 conjunction aggregation (see audit drawer in-app)"})
        timeline_rows = [{k: r.get(k) for k in ("id", "label", "at", "sourceAt", "description")}
                         for r in tool_timeline(pos)]
        controls = tool_expected_controls(pos)
        scenes.append({"scene": "s2", "selectionId": pos,
                       "title": f"Chronology & expected-vs-observed — {pos}",
                       "rows": {"timeline": timeline_rows, "expectedControls": controls},
                       "cypher": GAP_QUERY_TEXT[:2000] + "\n// … (full gap query, truncated for pregen)"})
        for rule_id in sorted({g["ruleId"] for g in gaps_of(pos)}):
            gap_rows = [g for g in controls if g["ruleId"] == rule_id and g["status"] != "MET"]
            scenes.append({"scene": "s2-gap", "selectionId": f"{pos}:{rule_id}",
                           "title": f"Gap {rule_id} — {pos}", "rows": gap_rows,
                           "cypher": GAP_QUERY_TEXT[:2000] + "\n// … (full gap query, truncated for pregen)"})
    pat = pattern_context()
    scenes.append({"scene": "s3", "selectionId": "PATTERN-TP",
                   "title": f"Pattern PATTERN-TP — abstracted from {pat['fromIncident']}",
                   "rows": pat, "cypher": "// S3 pattern MERGE + REQUIRES links"})
    ra = readacross_rows()
    scenes.append({"scene": "s4", "selectionId": "PATTERN-TP",
                   "title": "Read-across — every position vs the pattern",
                   "rows": {"matches": ra, "patternRequires": pat["requires"]},
                   "cypher": "// S4 read-across scoring: satisfied REQUIRES / total"})
    for pos in ("POS-TP", "POS-FP"):
        match = next((r for r in ra if r["positionId"] == pos), None)
        scenes.append({"scene": "s4", "selectionId": pos,
                       "title": f"Read-across match — {pos}",
                       "rows": {"match": match, "patternRequires": pat["requires"]},
                       "cypher": "// S4 read-across scoring: satisfied REQUIRES / total"})
    return scenes


def main() -> None:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise SystemExit("GEMINI_API_KEY not set (source .env)")
    client = genai.Client(api_key=api_key)
    obligations = load_obligations()
    print(f"asOf clock: {AS_OF_DEFAULT.date()} — params canon: {canonical_params(obligations)[:80]}…")

    existing = json.loads(OUT.read_text()) if OUT.exists() else {}
    out: dict[str, dict] = {}
    scenes = build_scenes()
    total = len(scenes) * len(LANGS)
    done = 0
    for scene in scenes:
        for lang in LANGS:
            done += 1
            key = cache_key(scene["scene"], scene["selectionId"], obligations, lang)
            if key in existing:
                out[key] = existing[key]
                print(f"[{done}/{total}] cached  {scene['scene']}:{scene['selectionId']} [{lang}]")
                continue
            system = SYSTEM_FR if lang == "fr" else SYSTEM_EN
            for attempt in range(3):
                try:
                    resp = client.models.generate_content(
                        model=MODEL,
                        contents=user_message(scene, obligations, lang),
                        config={"system_instruction": system})
                    text = (resp.text or "").strip()
                    if not text:
                        raise RuntimeError("empty response")
                    out[key] = {"text": text, "scene": scene["scene"],
                                "selectionId": scene["selectionId"], "lang": lang}
                    print(f"[{done}/{total}] generated {scene['scene']}:{scene['selectionId']} [{lang}]")
                    break
                except Exception as exc:
                    if attempt == 2:
                        raise
                    print(f"  retry ({exc})")
                    time.sleep(5)

    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False))
    APP_OUT.parent.mkdir(parents=True, exist_ok=True)
    APP_OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False))
    print(f"{len(out)} explanations -> {OUT} and {APP_OUT}")


if __name__ == "__main__":
    main()
