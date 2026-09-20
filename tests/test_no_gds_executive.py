"""The executive flow (Explore, Policy, S1–S4, Assistant) runs NO gds.* procedure.

Structure-driven analysis lives exclusively in the Discovery tab
(app/src/lib/discoveryQueries.ts, behind the Technical toggle). This test greps
the query modules the executive scenarios use — if a gds. call sneaks back into
any of them, it fails with the offending line.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

EXECUTIVE_QUERY_FILES = [
    "app/src/lib/scenarioQueries.ts",  # S1–S4
    "app/src/lib/queries.ts",  # gap query, policy, ingest, shared lookups
    "app/src/lib/timelineQuery.ts",  # PositionTimeline
    "app/src/lib/assistantTools.ts",  # the Assistant's typed tools
    "app/src/components/ExploreTab.tsx",  # ingest + reveal + schema peek
    "app/src/components/ScenariosTab.tsx",
    "app/src/components/SchemaPeek.tsx",
    "mcp_server.py",  # MCP mirror of the assistant tools
]


def test_executive_flow_invokes_no_gds():
    offenders = []
    for rel in EXECUTIVE_QUERY_FILES:
        text = (ROOT / rel).read_text()
        for i, line in enumerate(text.splitlines(), 1):
            if "gds." in line:
                offenders.append(f"{rel}:{i}: {line.strip()}")
    assert not offenders, "gds.* found in the executive flow:\n" + "\n".join(offenders)
