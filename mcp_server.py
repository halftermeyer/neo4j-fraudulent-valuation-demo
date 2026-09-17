#!/usr/bin/env python3
"""MCP server for the mismarking demo (cosmo-rd pattern).

Exposes the SAME seven typed tools as the app's Assistant tab
(app/src/lib/assistantTools.ts), plus load_demo / run_query, over the
`mismarking` Neo4j database. Every tool returns a cypher_audit_trail so an MCP
client (Claude, etc.) can show its work, exactly like the app's audit drawer.

Run:  uv run python mcp_server.py            (stdio)
      uv run python mcp_server.py --sse      (SSE transport)
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from threading import local

from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP
from neo4j import GraphDatabase
from neo4j.time import DateTime as Neo4jDateTime

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")
load_dotenv(ROOT / "inputs" / ".env")

NEO4J_URI = os.getenv("NEO4J_URI", "bolt://127.0.0.1:7687")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "")
NEO4J_DATABASE = os.getenv("NEO4J_DATABASE", "neo4j")

AS_OF_DEFAULT = datetime(2023, 1, 1, tzinfo=timezone.utc)  # dataset clock end
GAP_QUERY = (ROOT / "data" / "gap_query.cypher").read_text()

mcp = FastMCP(
    "Mismarking Detection Demo",
    instructions=(
        "Neo4j graph of a fraudulent-valuation (mismarking) detection demo. "
        "The graph does not detect fraud: it detects the conjunction of weak "
        "signals fraud leaves behind; a human establishes intent. POS-TP is the "
        "confirmed public case (dates shifted +10y; authentic dates in sourceAt, "
        "citations in sourceRef); POS-FP is the assessed false positive. "
        "Tool results include cypher_audit_trail — surface it when asked how an "
        "answer was obtained."
    ),
)

driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))

_thread_local = local()


def _get_trail() -> list[str]:
    if not hasattr(_thread_local, "trail"):
        _thread_local.trail = []
    return _thread_local.trail


def _reset_trail() -> None:
    _thread_local.trail = []


def _fmt_query(query: str, params: dict | None) -> str:
    header = ""
    if params:
        header = "// Parameters: " + ", ".join(f"{k}: {v}" for k, v in params.items()) + "\n"
    return header + query.strip()


def _to_plain(value):
    if isinstance(value, Neo4jDateTime):
        return str(value)
    if isinstance(value, list):
        return [_to_plain(v) for v in value]
    if isinstance(value, dict):
        return {k: _to_plain(v) for k, v in value.items()}
    return value


def run_cypher(query: str, params: dict | None = None) -> list[dict]:
    _get_trail().append(_fmt_query(query, params))
    with driver.session(database=NEO4J_DATABASE) as session:
        return [_to_plain(dict(r)) for r in session.run(query, params or {})]


def _build_response(results, label: str = "results", graph: dict | None = None) -> str:
    audit = "\n\n".join(f"// Step {i + 1}\n{q}" for i, q in enumerate(_get_trail()))
    payload = {label: results, "cypher_audit_trail": audit}
    if graph is not None:
        payload["graph"] = graph  # same shape as app/src/lib/assistantTools.ts ToolResult.graph
    return json.dumps(payload, indent=2, default=str)


# ── graph-shaped payloads (mirror of assistantTools.ts builders) ─────────────

def _timeline_graph(position_id: str, rows: list[dict]) -> dict:
    events = [r for r in rows if r.get("label") not in ("MarketPrice", "Curve")][:60]
    nodes = [{"id": position_id, "label": "Position", "caption": position_id, "order": -1}] + [
        {"id": e["id"], "label": e["label"],
         "caption": f"{e['label']} {str(e['at'])[:10]}", "order": i}
        for i, e in enumerate(events)
    ]
    rels = [{"id": f"next-{i}", "from": events[i]["id"], "to": e["id"], "type": "NEXT"}
            for i, e in enumerate(events[1:])]
    if events:
        rels.insert(0, {"id": "pos-first", "from": position_id, "to": events[0]["id"],
                        "type": "FIRST_EVENT"})
    return {"nodes": nodes, "rels": rels, "ordered": True}


def _expected_controls_graph(position_id: str, rows: list[dict]) -> dict:
    nodes = {position_id: {"id": position_id, "label": "Position", "caption": position_id}}
    rels = []
    for i, r in enumerate(rows[:60]):
        rule = r["ruleId"]
        nodes.setdefault(rule, {"id": rule, "label": "ControlObligation",
                                "caption": f"{rule} {r['ruleName']}"})
        trig = r.get("triggerEventId")
        if trig and trig != position_id:
            if trig not in nodes:
                nodes[trig] = {"id": trig, "label": r.get("triggerLabel") or "Event",
                               "caption": trig}
                rels.append({"id": f"t-{i}", "from": position_id, "to": trig, "type": "HAS_EVENT"})
            rels.append({"id": f"s-{i}", "from": trig, "to": rule, "type": r["status"]})
    return {"nodes": list(nodes.values()), "rels": rels}


def _who_approved_graph(event_id: str, rows: list[dict]) -> dict:
    nodes = {event_id: {"id": event_id, "label": "Event", "caption": event_id}}
    rels = []
    for i, r in enumerate(rows):
        a = str(r.get("approvalId") or f"approval-{i}")
        nodes[a] = {"id": a, "label": "Approval", "caption": a}
        rels.append({"id": f"a-{i}", "from": event_id, "to": a, "type": "APPROVED_BY"})
        if r.get("approver"):
            p = str(r["approver"])
            nodes[p] = {"id": p, "label": "Person",
                        "caption": f"{p} ({r.get('approverRole') or '?'})"}
            rels.append({"id": f"p-{i}", "from": a, "to": p, "type": "APPROVED_BY"})
            if r.get("approverDesk"):
                d = str(r["approverDesk"])
                nodes[d] = {"id": d, "label": "Desk", "caption": d}
                rels.append({"id": f"d-{i}", "from": p, "to": d, "type": "ON_DESK"})
    return {"nodes": list(nodes.values()), "rels": rels}


def _read_across_graph(rows: list[dict]) -> dict:
    nodes, rels = {}, []
    for r in rows[:15]:
        pid = r["positionId"]
        nodes[pid] = {"id": pid, "label": "Position", "caption": pid}
        for rule in r.get("rules") or []:
            nodes.setdefault(rule, {"id": rule, "label": "GovernanceGap", "caption": rule})
            rels.append({"id": f"{pid}-{rule}", "from": pid, "to": rule, "type": "HAS_GAP"})
    return {"nodes": list(nodes.values()), "rels": rels}


# ── plain functions (importable by tests without starting the server) ────────

def tool_list_positions() -> list[dict]:
    return run_cypher(
        """MATCH (p:Position)-[:ON_DESK]->(d:Desk)
        OPTIONAL MATCH (p)-[:OF_INSTRUMENT]->(i:Instrument)
        OPTIONAL MATCH (g:GovernanceGap {abstract: false})-[:ON_POSITION]->(p)
        RETURN p.id AS id, p.name AS name, d.id AS desk, d.name AS deskName,
               i.sector AS sector, count(g) AS gapCount,
               coalesce(p.synthetic, false) AS synthetic
        ORDER BY gapCount DESC, id""",
    )


def tool_timeline(position_id: str) -> list[dict]:
    return run_cypher(
        """MATCH (e:Event {positionId: $positionId})
        OPTIONAL MATCH (:Event)-[nx:NEXT]->(e)
        RETURN e.id AS id, [l IN labels(e) WHERE l <> 'Event'][0] AS label,
               toString(e.at) AS at, toString(e.sourceAt) AS sourceAt,
               e.description AS description, e.sourceRef AS sourceRef,
               nx.timeDelta AS timeDeltaDays
        ORDER BY e.at""",
        {"positionId": position_id},
    )


def tool_expected_controls(position_id: str, as_of: str | None = None) -> list[dict]:
    as_of_dt = (
        datetime.fromisoformat(as_of).replace(tzinfo=timezone.utc)
        if as_of
        else AS_OF_DEFAULT
    )
    rows = run_cypher(GAP_QUERY, {"positionId": position_id, "ruleId": None, "asOf": as_of_dt})
    return sorted(rows, key=lambda r: str(r.get("triggerAt")))


def tool_who_approved(event_id: str) -> list[dict]:
    return run_cypher(
        """MATCH (t:Event {id: $eventId})-[:APPROVED_BY]->(a:Approval)
        OPTIONAL MATCH (a)-[:APPROVED_BY]->(by)
        OPTIONAL MATCH (by)-[:ON_DESK]->(d:Desk)
        OPTIONAL MATCH (p:Position {id: t.positionId})-[:ON_DESK]->(pd:Desk)
        OPTIONAL MATCH (a)-[:EVIDENCED_BY]->(ev:Evidence)
        RETURN a.id AS approvalId, toString(a.at) AS approvedAt,
               by.name AS approver, by.role AS approverRole, d.id AS approverDesk,
               pd.id AS positionDesk, (d IS NOT NULL AND d = pd) AS sameDesk,
               count(ev) > 0 AS evidenced""",
        {"eventId": event_id},
    )


def tool_divergence(position_id: str) -> list[dict]:
    return run_cypher(
        """MATCH (p:Position {id: $positionId})-[:OF_INSTRUMENT]->(i:Instrument)
        MATCH (obs:MarketPrice)-[:PRICE_OF]->(i)
        OPTIONAL MATCH (obs)-[c:COMPARED_WITH]->(proxy:MarketPrice)-[:PRICE_OF]->(i)
        WITH obs, proxy, c WHERE obs.source IN ['TRACE', 'trader mark']
        RETURN toString(obs.at) AS at, obs.clean AS observed, obs.source AS source,
               proxy.clean AS proxy, c.divergenceBps AS divergenceBps
        ORDER BY obs.at""",
        {"positionId": position_id},
    )


def tool_read_across(min_rules: int = 2) -> list[dict]:
    return run_cypher(
        """MATCH (g:GovernanceGap {abstract: false})-[:ON_POSITION]->(p:Position)
        WHERE NOT EXISTS { MATCH (:Incident)-[:CAUSED_BY]->(p) }
        WITH p, collect(DISTINCT g.ruleId) AS rules
        WHERE size(rules) >= $minRules
        MATCH (p)-[:ON_DESK]->(d:Desk)
        RETURN p.id AS positionId, p.name AS name, d.name AS desk,
               rules, size(rules) AS ruleCount
        ORDER BY ruleCount DESC LIMIT 25""",
        {"minRules": min_rules},
    )


def tool_policy_params() -> list[dict]:
    rows = run_cypher(
        """MATCH (o:ControlObligation)
        RETURN o.id AS id, o.name AS name, o.timing AS timing, o.slaDays AS slaDays,
               o.paramsJson AS paramsJson, o.gapDefinition AS gapDefinition
        ORDER BY o.id""",
    )
    for r in rows:
        r["params"] = json.loads(r.pop("paramsJson") or "{}")
    return rows


def _load_statements() -> list[str]:
    """Split data/load_data.cypher into runnable statements.
    Drops line comments and cypher-shell :param directives (their values are
    supplied as session params instead)."""
    content = (ROOT / "data" / "load_data.cypher").read_text()
    statements = []
    for chunk in content.split(";\n"):
        lines = [
            ln for ln in chunk.split("\n")
            if ln.strip() and not ln.strip().startswith("//") and not ln.strip().startswith(":param")
        ]
        if lines:
            statements.append("\n".join(lines))
    return statements


def tool_load_demo() -> dict:
    params = {"positionId": None, "ruleId": None, "asOf": AS_OF_DEFAULT}
    ok, failed, errors = 0, 0, []
    with driver.session(database=NEO4J_DATABASE) as session:
        for stmt in _load_statements():
            try:
                session.run(stmt, params).consume()
                ok += 1
            except Exception as exc:  # keep going, report at the end
                failed += 1
                if len(errors) < 5:
                    errors.append(f"{stmt[:80]}… -> {exc}")
    counts = run_cypher(
        "MATCH (n) UNWIND labels(n) AS l WITH l, count(*) AS c "
        "WHERE l <> 'Event' RETURN l AS label, c ORDER BY c DESC LIMIT 15"
    )
    return {"statements_ok": ok, "statements_failed": failed, "errors": errors, "counts": counts}


# ── MCP tool registrations ───────────────────────────────────────────────────

@mcp.tool()
def list_positions() -> str:
    """List all positions with desk, sector and governance-gap count (worst first)."""
    _reset_trail()
    return _build_response(tool_list_positions(), "positions")


@mcp.tool()
def timeline(positionId: str) -> str:
    """Chronological reconstruction of everything that happened to a position
    (methodology changes, overrides, IPV/MAP reviews, P&L signals, approvals,
    escalations, incident, corrective actions), in event-time order."""
    _reset_trail()
    rows = tool_timeline(positionId)
    return _build_response(rows, "timeline", graph=_timeline_graph(positionId, rows))


@mcp.tool()
def expected_controls(positionId: str, asOf: str | None = None) -> str:
    """Expected-vs-observed evaluation of every ControlObligation (R1..R9) for a
    position: which control should have fired, when it was due, what was observed,
    status MET | LATE | MISSED | PENDING. LATE and MISSED are governance gaps."""
    _reset_trail()
    rows = tool_expected_controls(positionId, asOf)
    return _build_response(rows, "evaluations", graph=_expected_controls_graph(positionId, rows))


@mcp.tool()
def who_approved(eventId: str) -> str:
    """Who approved a MethodologyChange/PriceOverride: role, desk, same-desk flag
    (segregation of duties, R8) and whether the approval is evidenced (R9)."""
    _reset_trail()
    rows = tool_who_approved(eventId)
    return _build_response(rows, "approvals", graph=_who_approved_graph(eventId, rows))


@mcp.tool()
def divergence(positionId: str) -> str:
    """Observed price vs proxy-model price history with divergence in bps."""
    _reset_trail()
    return _build_response(tool_divergence(positionId), "prices")


@mcp.tool()
def read_across(minRules: int = 2) -> str:
    """Positions (excluding confirmed incidents) accumulating governance gaps on
    at least minRules distinct obligations — partial matches / early detection."""
    _reset_trail()
    rows = tool_read_across(minRules)
    return _build_response(rows, "matches", graph=_read_across_graph(rows))


@mcp.tool()
def policy_params() -> str:
    """Current parameters of every ControlObligation (thresholds, SLAs, windows)."""
    _reset_trail()
    return _build_response(tool_policy_params(), "obligations")


@mcp.tool()
def load_demo() -> str:
    """Load (or reload) the full demo dataset from data/load_data.cypher into the
    configured database, then report node counts. Destructive: starts by wiping."""
    _reset_trail()
    _get_trail().append("// streamed data/load_data.cypher statement by statement")
    return _build_response(tool_load_demo(), "load_result")


@mcp.tool()
def run_query(query: str, params: str | None = None) -> str:
    """Run an ad-hoc read Cypher query (JSON-encoded params optional). Prefer the
    typed tools; this exists for exploration."""
    _reset_trail()
    p = json.loads(params) if params else {}
    return _build_response(run_cypher(query, p), "rows")


if __name__ == "__main__":
    if "--sse" in sys.argv:
        mcp.run(transport="sse")
    else:
        mcp.run()
