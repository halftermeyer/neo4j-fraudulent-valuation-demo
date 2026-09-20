"""Assistant workstream tests (first-class per the prompt).

Layer 1 — deterministic: the typed tools (shared by the app's Assistant and
mcp_server.py) must reconstruct the chronology and the expected-vs-observed
picture reliably, straight against the loaded database.

Layer 2 — LLM integration (skipped without GEMINI_API_KEY): Gemini composes the
same tools and must answer the canonical validation question — "reconstruct what
happened, in order, and tell me which control should have fired" — naming the
right events in the right order and the right ControlObligations.
"""

import json
import os
import sys
from pathlib import Path

import pytest
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
load_dotenv(ROOT / "inputs" / ".env")
sys.path.insert(0, str(ROOT))

import mcp_server  # noqa: E402  (needs env loaded first)


# ── deterministic tool-layer tests ───────────────────────────────────────────

def test_timeline_is_chronological():
    events = mcp_server.tool_timeline("POS-TP")
    assert len(events) > 20
    ats = [e["at"] for e in events]
    assert ats == sorted(ats), "timeline must be ordered by event time"
    assert events[0]["id"] in ("MAP-TP-2011Q3", "MP-2011Q4")

    order = [e["id"] for e in events]

    def idx(eid: str) -> int:
        assert eid in order, f"{eid} missing from timeline"
        return order.index(eid)

    # authentic order: override series starts Jan 6, VaR change Jan 27,
    # VCG quarter-end review Mar 30, incident May 10
    assert idx("PO-TP-01") < idx("MC-VAR-2012") < idx("IPV-Q1") < idx("INC-TP")


def test_timeline_keeps_authentic_dates_and_sources():
    events = mcp_server.tool_timeline("POS-TP")
    mc = next(e for e in events if e["id"] == "MC-VAR-2012")
    assert mc["at"].startswith("2022-01-27"), "demo clock = authentic + 10y"
    assert mc["sourceAt"].startswith("2012-01-27"), "authentic date preserved"
    assert mc["sourceRef"] and "PSI" in mc["sourceRef"]


def test_expected_controls_tp():
    rows = mcp_server.tool_expected_controls("POS-TP")
    gaps = {r["ruleId"] for r in rows if r["status"] in ("MISSED", "LATE")}
    assert gaps == {"R1", "R2", "R3", "R4", "R5", "R6", "R8", "R9"}
    # R7 has no row at the default asOf: POS-TP closed (transferred) in 2022-07,
    # and R7 only evaluates positions active at asOf. The anchor MAPReview shows
    # up when evaluating DURING the case window:
    during = mcp_server.tool_expected_controls("POS-TP", "2022-06-01T00:00:00")
    r7 = [r for r in during if r["ruleId"] == "R7"]
    assert r7 and all(r["status"] == "MET" for r in r7), \
        "the anchor MAPReview must make R7 MET during the case window"


def test_expected_controls_fp():
    rows = mcp_server.tool_expected_controls("POS-FP")
    gaps = {r["ruleId"] for r in rows if r["status"] in ("MISSED", "LATE")}
    assert gaps == {"R2", "R4", "R6"}


def test_who_approved_flags_same_desk():
    rows = mcp_server.tool_who_approved("PO-TP-03")
    assert rows, "override approvals must be visible"
    assert any(r["sameDesk"] for r in rows), "desk-head approval must be flagged same-desk (R8)"
    rows2 = mcp_server.tool_who_approved("MC-FP-2022")
    assert rows2 and all(not r["sameDesk"] for r in rows2)
    assert all(r["evidenced"] for r in rows2)


def test_read_across_excludes_confirmed_case():
    matches = mcp_server.tool_read_across(2)
    ids = [m["positionId"] for m in matches]
    assert "POS-TP" not in ids, "confirmed incident is excluded from early detection"
    assert "POS-FP" in ids, "the false positive must surface as a partial match"


# ── LLM integration (the validation criterion) ───────────────────────────────

GEMINI_TOOLS = [
    {
        "name": "timeline",
        "description": "Chronological event reconstruction for a position.",
        "parameters": {
            "type": "object",
            "properties": {"positionId": {"type": "string"}},
            "required": ["positionId"],
        },
    },
    {
        "name": "expected_controls",
        "description": "Expected-vs-observed for every ControlObligation R1..R9 (MET/LATE/MISSED/PENDING).",
        "parameters": {
            "type": "object",
            "properties": {"positionId": {"type": "string"}},
            "required": ["positionId"],
        },
    },
]

SYSTEM_PROMPT = (
    "You are the investigation assistant of a mismarking detection demo. "
    "The graph detects conjunctions of weak signals, not fraud; a human establishes intent. "
    "When asked to reconstruct a case, answer chronologically in event-time order and finish "
    "with the controls that should have fired, naming ControlObligation ids (R1..R9) and their "
    "status. POS-TP is the confirmed public case; dates are shifted +10 years (authentic dates "
    "in sourceAt). Use the tools; do not invent events."
)

QUESTION = (
    "Reconstruct what happened to position POS-TP, in order, and tell me which "
    "control should have fired and did not."
)


def _execute(name: str, args: dict):
    if name == "timeline":
        return mcp_server.tool_timeline(args["positionId"])
    if name == "expected_controls":
        return mcp_server.tool_expected_controls(args["positionId"])
    raise ValueError(name)


def _ask_model() -> str:
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])
    config = types.GenerateContentConfig(
        system_instruction=SYSTEM_PROMPT,
        tools=[types.Tool(function_declarations=GEMINI_TOOLS)],
    )
    contents = [types.Content(role="user", parts=[types.Part.from_text(text=QUESTION)])]

    final_text = ""
    for _ in range(6):
        resp = client.models.generate_content(
            model="gemini-2.5-flash", contents=contents, config=config)
        content = resp.candidates[0].content
        contents.append(content)
        calls = [p.function_call for p in (content.parts or []) if p.function_call]
        if not calls:
            final_text = resp.text or ""
            break
        parts = []
        for fc in calls:
            result = _execute(fc.name, dict(fc.args))
            parts.append(types.Part.from_function_response(
                name=fc.name, response={"result": json.dumps(result, default=str)[:60000]}))
        contents.append(types.Content(role="user", parts=parts))
    return final_text


@pytest.mark.skipif(not os.getenv("GEMINI_API_KEY"), reason="GEMINI_API_KEY not set")
def test_llm_reconstructs_chronology_and_names_controls():
    # the model's phrasing is stochastic: one retry for pure answer-shape variance
    # (same policy as the video recorder), diagnostics printed on the final failure
    last_error: AssertionError | None = None
    for attempt in range(2):
        try:
            _assert_chronology(_ask_model().lower())
            return
        except AssertionError as e:
            last_error = e
            print(f"attempt {attempt + 1} failed: {e}", flush=True)
    raise last_error  # type: ignore[misc]


def _assert_chronology(text: str) -> None:
    assert text, "the model must produce a final answer"

    # the chronology: informal methodology change -> override series -> IPV upheld
    # the marks. FIRST mention of each (max() over find() let a LATE re-mention of
    # the change — e.g. in a "controls that should have fired" section — inflate
    # its index and flake the ordering assertion). The verdict is anchored on the
    # specific review id when the model cites it, as its instructions require.
    def first(*needles: str) -> int:
        hits = [text.find(n) for n in needles]
        hits = [h for h in hits if h >= 0]
        return min(hits) if hits else -1

    def tiered(*tiers: tuple[str, ...]) -> int:
        for needles in tiers:
            idx = first(*needles)
            if idx >= 0:
                return idx
        return -1

    change_idx = tiered(("mc-mark",), ("marking practice",))
    override_idx = first("override")
    ipv_idx = tiered(("ipv-q1",), ("vcg", "independent price", "upheld"), ("ipv",))
    assert change_idx >= 0, "must mention the informal marking-practice change"
    assert override_idx >= 0, "must mention the price override series"
    assert ipv_idx >= 0, "must mention the IPV/VCG review"
    assert change_idx < ipv_idx, (
        f"chronology must be respected: change@{change_idx} must precede IPV verdict@{ipv_idx}; "
        f"answer head: {text[:300]!r}")

    named_rules = [r for r in ("r1", "r2", "r3", "r5") if r in text]
    assert len(named_rules) >= 2, f"must name at least two of R1/R2/R3/R5, got {named_rules}"
