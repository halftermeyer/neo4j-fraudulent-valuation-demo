#!/usr/bin/env python3
"""Remove every Discovery write from the graph — the Python mirror of
discoveryReset() in app/src/lib/discoveryQueries.ts (keep the statements in
sync). Used as the pre-clean step of `make video-technical` so recording
attempts never pollute each other, and available to operators."""

import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from neo4j import GraphDatabase

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
load_dotenv(ROOT / "inputs" / ".env")

STATEMENTS = [
    "MATCH (o:ControlObligation) WHERE o.id IN ['R-C1', 'R10'] DETACH DELETE o",
    "MATCH ()-[r:SIMILAR_TRAJECTORY]->() DELETE r",
    "MATCH ()-[r:CORRELATES_WITH]->() DELETE r",
    "MATCH (ds:DecorrelationSignal) DETACH DELETE ds",
    "MATCH (w:WatchlistEntry) DETACH DELETE w",
    "MATCH (ra:RiskAttribute {type: 'behaviourCluster'}) DETACH DELETE ra",
    "MATCH (p:Position) REMOVE p.trajectory, p.markReturns",
    "MATCH (g:GovernanceGap {abstract: false}) WHERE g.ruleId IN ['R-C1', 'R10'] DETACH DELETE g",
]


def main() -> None:
    driver = GraphDatabase.driver(
        os.environ["NEO4J_URI"],
        auth=(os.environ["NEO4J_USER"], os.environ["NEO4J_PASSWORD"]))
    with driver.session(database=os.environ.get("NEO4J_DATABASE", "neo4j")) as s:
        for q in STATEMENTS:
            s.run(q)
    driver.close()
    print("discovery reset: every Discovery write removed")


if __name__ == "__main__":
    sys.exit(main())
