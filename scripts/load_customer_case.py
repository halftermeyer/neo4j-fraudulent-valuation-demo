#!/usr/bin/env python3
"""Load a customer-provided second true positive from a filled
templates/customer_case_template.xlsx into the graph.

Usage:
  uv run python scripts/load_customer_case.py path/to/filled_case.xlsx

Encodes the workbook through the same conventions as the built-in case encoder
(generate_data.py): role-based Person nodes, event nodes with `at` datetimes,
typed relationships from the data model, a per-position :NEXT chain, RiskAttribute
links for the instrument SHAPE (never identity), then re-materialises the
GovernanceGaps with data/gap_query.cypher and asserts the declared rules_broken —
the same acceptance check the built-in case passes.
"""

import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from neo4j import GraphDatabase
from openpyxl import load_workbook

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
load_dotenv(ROOT / "inputs" / ".env")

REL_FOR_LABEL = {
    "MethodologyChange": "CHANGED_TO",
    "PriceOverride": "OVERRIDDEN_BY",
    "IPVReview": "REVIEWED_BY",
    "MAPReview": "REVIEWED_BY",
    "PnLSignal": "GENERATED_SIGNAL",
    "Control": "SUBJECT_TO_CONTROL",
    "Escalation": "ESCALATED_TO",
}
ALLOWED_LABELS = set(REL_FOR_LABEL) | {
    "Approval", "Evidence", "Incident", "CorrectiveAction", "RootCause",
}


def sheet_rows(ws):
    headers = [c.value for c in ws[1]]
    for row in ws.iter_rows(min_row=2, values_only=True):
        if all(v is None for v in row):
            continue
        yield dict(zip(headers, row))


def main(path: str) -> None:
    wb = load_workbook(path)
    pos = next(sheet_rows(wb["Position"]))
    instr = next(sheet_rows(wb["Instrument"]))
    events = sorted(sheet_rows(wb["Event"]), key=lambda r: int(r["seq"]))

    pos_id = str(pos["id"])
    driver = GraphDatabase.driver(
        os.environ["NEO4J_URI"],
        auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
    db = os.environ.get("NEO4J_DATABASE", "neo4j")

    with driver.session(database=db) as s:
        s.run(
            """MERGE (p:Position {id: $id})
               SET p.name = $name, p.openedAt = datetime($openedAt), p.synthetic = true,
                   p.validTo = CASE WHEN $closedAt IS NULL THEN null ELSE datetime($closedAt) END
               MERGE (i:Instrument {id: 'INSTR-' + $id})
               SET i.name = 'customer case instrument (shape only)', i.synthetic = true
               MERGE (p)-[:OF_INSTRUMENT]->(i)""",
            id=pos_id, name=str(pos["name"]),
            openedAt=f"{pos['openedAt']}T12:00:00"[:19],
            closedAt=(f"{pos['closedAt']}T12:00:00"[:19] if pos.get("closedAt") else None))
        for atype in ("sector", "maturityBucket", "liquidityTier", "methodologyFamily"):
            key = "issuerSector" if atype == "sector" else atype
            if instr.get(atype):
                s.run(
                    """MERGE (ra:RiskAttribute {id: 'RA-' + $t + '-' + $v})
                       SET ra.type = $t, ra.value = $v
                       WITH ra MATCH (p:Position {id: $pid})
                       MERGE (p)-[:HAS_RISK_ATTRIBUTE]->(ra)""",
                    t=key, v=str(instr[atype]), pid=pos_id)

        prev_id = None
        declared: set[str] = set()
        for e in events:
            label = str(e["event_label"])
            if label not in ALLOWED_LABELS:
                raise SystemExit(f"unsupported event_label {label}")
            eid = str(e["event_id"])
            at = f"{e['date']}T12:00:00"[:19]
            declared |= {r for r in str(e.get("rules_broken") or "").split(";") if r}
            s.run(
                f"""MERGE (ev:{label}:Event {{id: $id}})
                    SET ev.at = datetime($at), ev.positionId = $pid,
                        ev.description = $desc, ev.actorRole = $actor,
                        ev.sourceRef = $src, ev.datePrecision = $prec""",
                id=eid, at=at, pid=pos_id, desc=str(e.get("description") or ""),
                actor=str(e.get("actor_role") or ""), src=str(e.get("source") or ""),
                prec=str(e.get("date_precision") or "day"))
            rel = REL_FOR_LABEL.get(label)
            if rel:
                s.run(
                    f"MATCH (p:Position {{id: $pid}}), (ev:Event {{id: $id}}) "
                    f"MERGE (p)-[:{rel}]->(ev)", pid=pos_id, id=eid)
            if prev_id:
                s.run(
                    "MATCH (a:Event {id: $a}), (b:Event {id: $b}) MERGE (a)-[:NEXT]->(b)",
                    a=prev_id, b=eid)
            prev_id = eid

        # recompute gaps with THE gap query and verify the declared rules
        gap_query = (ROOT / "data" / "gap_query.cypher").read_text()
        as_of = datetime(2023, 1, 1, tzinfo=timezone.utc)
        broken = {
            r["ruleId"] for r in s.run(gap_query, positionId=pos_id, ruleId=None, asOf=as_of)
            if r["status"] in ("MISSED", "LATE")
        }
        print(f"declared rules_broken: {sorted(declared)}")
        print(f"gap query returns:    {sorted(broken)}")
        if declared and broken != declared:
            print("MISMATCH — adjust the workbook (or the expectation) before the demo.")
            sys.exit(1)
        print("Case loaded and consistent. Re-run the app's gap materialisation "
              "(Policy panel Apply/Reset, or re-ingest) to refresh :GovernanceGap nodes.")
    driver.close()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(sys.argv[1])
