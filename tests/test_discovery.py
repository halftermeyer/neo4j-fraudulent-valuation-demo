"""Discovery panel 3 — peer decorrelation and the R10 candidate rule.

The signal computation (scripts/discovery_signals.py) is the source of truth the
app mirrors. These tests pin the story the panel must tell:
  * exactly the two encoded cases decorrelate — POS-TP (flat book, never tracked
    its peers) and POS-FP (froze at the stale model through the 2022 shock);
  * once the Discovery panel proposes R10, the SAME gap query separates them:
    TP breaks it (no resolution in the window), FP is MET (its pre-approved
    methodology change explains the decorrelation).
Everything the test writes is removed afterwards — the acceptance sets never
see R10 or the signals.
"""

import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest
from dotenv import load_dotenv
from neo4j import GraphDatabase

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
load_dotenv(ROOT / ".env")
load_dotenv(ROOT / "inputs" / ".env")

import discovery_signals as ds  # noqa: E402

GAP_QUERY = (ROOT / "data" / "gap_query.cypher").read_text()
AS_OF = datetime(2023, 1, 1, tzinfo=timezone.utc)

CREATE_R10 = """
MERGE (o:ControlObligation {id: 'R10'})
SET o.name = 'Peer decorrelation resolution',
    o.status = 'industry practice, not a rule',
    o.severity = 'medium', o.timing = 'AFTER', o.slaDays = 30,
    o.triggerEvent = 'DecorrelationSignal',
    o.requiredControl = 'Pre-approved MethodologyChange effective around the signal OR IPVReview within slaDays',
    o.requiredByRole = 'Desk head + IPV',
    o.gapDefinition = 'DecorrelationSignal with neither an approved methodology change nor an IPV review resolving it',
    o.paramsJson = '{"windowWeeks": 8, "decorrThreshold": 0.45, "decorrPeriods": 2}'
"""

CLEANUP = ["MATCH (o:ControlObligation {id: 'R10'}) DETACH DELETE o", ds.DELETE_SIGNALS]


@pytest.fixture(scope="module")
def session():
    driver = GraphDatabase.driver(
        os.environ["NEO4J_URI"],
        auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
    with driver.session(database=os.environ.get("NEO4J_DATABASE", "neo4j")) as s:
        yield s
        for q in CLEANUP:  # never leave Discovery writes behind
            s.run(q)
    driver.close()


def test_marks_exist_and_are_chained(session):
    n = session.run("MATCH (m:Mark) RETURN count(m) AS c").single()["c"]
    assert n > 5000, "weekly trader marks missing — regenerate the data"
    chained = session.run(
        "MATCH (m:Mark {positionId: 'POS-FP'}) WHERE (m)-[:NEXT]-() RETURN count(m) AS c"
    ).single()["c"]
    assert chained > 0, ":Mark events must sit in the per-position NEXT chains"


def test_decorrelation_signals_separate_cases(session):
    signals = ds.signals_from_db(session, AS_OF)
    by_pos = {s["positionId"]: s for s in signals}
    assert "POS-TP" in by_pos, "the flat mismarked book must decorrelate"
    assert "POS-FP" in by_pos, "the frozen-model book must decorrelate at the shock"
    # a quant signal must not precede the behaviour it detects: POS-TP's signal
    # sits INSIDE the override series (PO-TP-01 2022-01-06 .. PO-TP-12 2022-03-23)
    assert "2022-01-06" <= by_pos["POS-TP"]["at"] <= "2022-03-23", \
        f"POS-TP signal {by_pos['POS-TP']['at']} outside the mark-drift window"
    # FP's signal must sit at the 2022 shock, BEFORE its approved change takes effect
    assert by_pos["POS-FP"]["at"] >= "2022-09-01" and by_pos["POS-FP"]["at"] <= "2022-10-19"
    honest = [s for s in signals if s["positionId"] not in ("POS-TP", "POS-FP")]
    # the planted mix: 2 benign (explained) + 1 near-miss, nothing accidental
    assert 2 <= len(honest) <= 6, f"unexpected honest decorrelation count ({len(honest)})"


def test_r10_separates_tp_from_fp(session):
    try:
        session.run(ds.DELETE_SIGNALS)
        signals = ds.signals_from_db(session, AS_OF)
        session.run(ds.WRITE_SIGNALS, signals=signals,
                    window=ds.WINDOW_WEEKS, threshold=ds.DECORR_THRESHOLD)
        session.run(CREATE_R10)
        rows = list(session.run(GAP_QUERY, positionId=None, ruleId="R10", asOf=AS_OF))
        status = {r["positionId"]: r["status"] for r in rows}
        assert status.get("POS-TP") in ("MISSED", "LATE"), \
            f"POS-TP must break R10, got {status.get('POS-TP')}"
        assert status.get("POS-FP") == "MET", \
            f"POS-FP must be MET on R10 (approved change explains it), got {status.get('POS-FP')}"
        # the panel's designed read: ~5 rows, 2 MISSED — the confirmed case and
        # ONE live near-miss (quiet IPV cycle, no recalibration); benign books MET
        missed = {p for p, st in status.items() if st in ("MISSED", "LATE")}
        met = {p for p, st in status.items() if st == "MET"}
        assert len(missed) == 2 and "POS-TP" in missed, f"expected 2 broken, got {sorted(missed)}"
        assert len(met) >= 3 and "POS-FP" in met, f"expected ≥3 MET incl. POS-FP, got {sorted(met)}"
    finally:
        for q in CLEANUP:
            session.run(q)
