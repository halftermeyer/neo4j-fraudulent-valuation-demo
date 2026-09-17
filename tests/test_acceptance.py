"""Acceptance tests for the two encoded cases (DATA_PLAN §4).

Expected rule sets are read from the inputs CSVs AT TEST TIME (never hard-coded)
and the real data/gap_query.cypher is executed against the loaded database —
the same text the app and the MCP server run.

Prerequisite: `make data && make load` against the database in .env / inputs/.env.
"""

import csv
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import pytest
from dotenv import load_dotenv
from neo4j import GraphDatabase

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
load_dotenv(ROOT / "inputs" / ".env")

GAP_QUERY = (ROOT / "data" / "gap_query.cypher").read_text()
AS_OF = datetime(2023, 1, 1, tzinfo=timezone.utc)


@pytest.fixture(scope="module")
def session():
    driver = GraphDatabase.driver(
        os.environ["NEO4J_URI"],
        auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
    with driver.session(database=os.environ.get("NEO4J_DATABASE", "neo4j")) as s:
        yield s
    driver.close()


def obligations_csv() -> list[dict]:
    with open(ROOT / "inputs" / "control_obligations.csv") as f:
        return list(csv.DictReader(f))


def events_csv() -> list[dict]:
    with open(ROOT / "inputs" / "public_true_positive_2012.csv") as f:
        return list(csv.DictReader(f))


def gap_rules(session, position_id: str) -> set[str]:
    """Run the app's gap query and return the distinct broken rules (MISSED|LATE)."""
    result = session.run(GAP_QUERY, positionId=position_id, ruleId=None, asOf=AS_OF)
    return {r["ruleId"] for r in result if r["status"] in ("MISSED", "LATE")}


def test_csv_columns_agree():
    """union(rules_broken) of the 19 events == default_broken_by_TP of the rules file."""
    union = set()
    for row in events_csv():
        union |= {r for r in row["rules_broken"].split(";") if r}
    declared = {o["id"] for o in obligations_csv() if o["default_broken_by_TP"] == "true"}
    # R7 is MET by design via the encoder-added anchor MAPReview (DECISIONS.md #2)
    assert union == declared, f"CSV inconsistency: events say {sorted(union)}, rules file says {sorted(declared)}"


def test_true_positive_gap_set(session):
    expected = {o["id"] for o in obligations_csv() if o["default_broken_by_TP"] == "true"}
    actual = gap_rules(session, "POS-TP")
    assert actual == expected, f"POS-TP gaps {sorted(actual)} != expected {sorted(expected)}"


def test_false_positive_gap_set(session):
    expected = {o["id"] for o in obligations_csv() if o["default_broken_by_FP"] == "true"}
    actual = gap_rules(session, "POS-FP")
    assert actual == expected, f"POS-FP gaps {sorted(actual)} != expected {sorted(expected)}"


def test_materialised_gaps_match_live_query(session):
    """The :GovernanceGap nodes written at load time must agree with a live run —
    same query, same text, same answer."""
    for pos in ("POS-TP", "POS-FP"):
        live = gap_rules(session, pos)
        stored = {r["ruleId"] for r in session.run(
            "MATCH (g:GovernanceGap {abstract: false, positionId: $pos}) "
            "RETURN DISTINCT g.ruleId AS ruleId", pos=pos)}
        assert stored == live, f"{pos}: materialised {sorted(stored)} != live {sorted(live)}"


def test_holdout_links_removed(session):
    """S4 link-prediction ground truth: held-out links must be absent from the graph."""
    holdout = json.loads((ROOT / "data" / "holdout_links.json").read_text())
    assert len(holdout) > 0
    for h in holdout:
        n = session.run(
            "MATCH (a {id: $f})-[:HAS_RISK_ATTRIBUTE]->(b {id: $t}) RETURN count(*) AS c",
            f=h["from"], t=h["to"]).single()["c"]
        assert n == 0, f"holdout link {h} still present"
