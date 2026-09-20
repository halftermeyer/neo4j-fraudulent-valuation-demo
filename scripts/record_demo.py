#!/usr/bin/env python3
"""Record the narrated demo video's screen track.

Parses the ```scene blocks from demo-script.md (the storyboard is the single
source of truth), synthesizes narration per scene (scripts/tts.py, cached)
unless --no-audio, then drives the running app with Playwright (headless
Chromium, 1920x1080, video recording on): reset -> ingest layer by layer ->
every scene in order. Each scene runs its UI action, waits for the render to
settle, then holds for the narration duration + 1 s. Scene boundaries land in
dist/scenes.json for scripts/assemble_video.py.

Fails loudly (exit 1, scene id named) if any selector is missing.
"""

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

DIST = ROOT / "dist"
SCRIPT_MD = ROOT / "demo-script.md"

# vocabulary gate: banned in every narration unless the script's ```scene-config
# `vocabulary:` allow-list lifts the term. "prediction" and "alert" can NOT be
# lifted — they are banned in every cut.
BANNED_WORDS = ["prediction", "alert", "regulation-driven", "GDS", "algorithm",
                "Louvain", "link prediction"]
HARD_BANNED = ["prediction", "alert"]

KNOWN_SCENES = [
    # executive cut (demo-script.md)
    "intro", "ingest-market", "ingest-governance", "ingest-cases", "schema-peek",
    "policy-framework", "policy-compute", "s1-conjunction", "s1-graph",
    "s2-chronology", "s2-gaps", "explain-click",
    "s3-pattern", "s4-readacross", "s4-false-positive", "s4-widen",
    "assistant-question", "outro",
    # technical cut (demo-script-technical.md) — deterministic, no LLM scene
    "tech-cold-open", "tech-policy-provenance", "tech-gap-branches",
    "tech-s2-engine", "tech-pattern-node", "tech-matching-query",
    "tech-discovery-open", "tech-circles", "tech-trajectories",
    "tech-decorrelation", "tech-reset", "tech-mcp-close",
]

TITLE_HTML = """
<html><body style="margin:0;width:1920px;height:1080px;display:flex;flex-direction:column;
justify-content:center;align-items:center;font-family:Inter,Helvetica,Arial,sans-serif;
background:linear-gradient(135deg,#0b297d 0%,#006fd6 70%,#00b4d8 100%);color:#fff">
<div style="font-size:58px;font-weight:800;letter-spacing:-1px;max-width:1500px;text-align:center">
Fraudulent valuation — from weak signals to read-across</div>
<div style="font-size:28px;max-width:1100px;text-align:center;margin-top:28px;opacity:.94;line-height:1.5">
The graph does not detect fraud. It detects the shape fraud leaves behind —
a human establishes intent.</div>
<div style="font-size:20px;margin-top:56px;opacity:.75;border:1px solid rgba(255,255,255,.5);
border-radius:20px;padding:8px 24px">Neo4j + GDS · RISK ORM demo</div>
</body></html>
"""


def parse_config(md_path: Path) -> dict:
    """The optional ```scene-config block: title/subtitle for the card, `output`
    (file stem, default 'demo'), `vocabulary` (comma allow-list lifting entries
    from BANNED_WORDS — except the hard-banned ones)."""
    text = md_path.read_text()
    m = re.search(r"```scene-config\n(.*?)```", text, flags=re.DOTALL)
    cfg = {"output": "demo", "title": None, "subtitle": None, "vocabulary": []}
    if m:
        for line in m.group(1).splitlines():
            if ":" not in line:
                continue
            k, v = line.split(":", 1)
            k, v = k.strip(), v.strip()
            if k == "vocabulary":
                cfg[k] = [w.strip() for w in v.split(",") if w.strip()]
            elif k in cfg:
                cfg[k] = v
    return cfg


def check_vocabulary(scenes: list[dict], cfg: dict, script: Path) -> None:
    allowed = {w.lower() for w in cfg["vocabulary"]}
    hard = {w.lower() for w in HARD_BANNED}
    banned = [w for w in BANNED_WORDS if w.lower() not in allowed or w.lower() in hard]
    offenders = []
    for s in scenes:
        low = s["narration"].lower()
        for w in banned:
            if re.search(r"(?<![\w-])" + re.escape(w.lower()) + r"(?![\w-])", low):
                offenders.append(f"{s['id']}: banned word '{w}'")
    if offenders:
        raise SystemExit(f"vocabulary gate failed for {script.name}:\n" + "\n".join(offenders))


def parse_scenes(md_path: Path) -> list[dict]:
    text = md_path.read_text()
    blocks = re.findall(r"```scene\n(.*?)```", text, flags=re.DOTALL)
    scenes = []
    for block in blocks:
        m_id = re.search(r"^id:\s*(\S+)", block, flags=re.MULTILINE)
        m_narr = re.search(r"^narration:\s*(.*)", block, flags=re.MULTILINE | re.DOTALL)
        if not m_id or not m_narr:
            raise SystemExit(f"storyboard block missing id/narration:\n{block[:200]}")
        narration = " ".join(line.strip() for line in m_narr.group(1).splitlines() if line.strip())
        scenes.append({"id": m_id.group(1), "narration": narration})
    ids = [s["id"] for s in scenes]
    if not scenes:
        raise SystemExit(f"no ```scene blocks found in {md_path.name}")
    dupes = {i for i in ids if ids.count(i) > 1}
    if dupes:
        raise SystemExit(f"duplicate scene ids: {dupes}")
    unknown = [i for i in ids if i not in KNOWN_SCENES]
    if unknown:
        raise SystemExit(f"unknown scene ids (recorder has no action for them): {unknown}")
    return scenes


def probe_base_url() -> str:
    import urllib.request

    for port in range(5173, 5177):
        url = f"http://localhost:{port}"
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:
                if "Mismarking" in resp.read(4096).decode(errors="ignore"):
                    return url
        except Exception:
            continue
    raise SystemExit("no dev server serving the Mismarking app on ports 5173-5176 — run `npm run dev` in app/")


def words_estimate_seconds(text: str) -> float:
    return max(4.0, len(text.split()) / 2.6 + 1.0)


class Recorder:
    FAST_SPEED = 8.0  # "time travel": dead waits are compressed 8× at assembly

    def __init__(self, page, t_start: float):
        self.page = page
        self.t_start = t_start
        self.scene_fast: list[dict] = []  # fast-forward windows of the current scene
        self._fast_t0: float | None = None

    def now(self) -> float:
        return time.monotonic() - self.t_start

    def fast_begin(self) -> None:
        self._fast_t0 = self.now()

    def fast_end(self, label: str = "fast-forwarded") -> None:
        """Close a fast-forward window (absolute recording time). The assembler
        speeds this interval up FAST_SPEED× and remaps everything after it;
        `label` lands in the on-screen ⏩ badge."""
        if self._fast_t0 is None:
            return
        t1 = self.now()
        if t1 - self._fast_t0 > 3.0:  # not worth a whoosh below 3 s
            self.scene_fast.append(
                {"from": round(self._fast_t0, 3), "to": round(t1, 3),
                 "speed": self.FAST_SPEED, "label": label})
        self._fast_t0 = None

    # ── shared helpers ──
    def tid(self, testid: str, timeout: int = 30_000):
        loc = self.page.get_by_test_id(testid)
        loc.wait_for(state="visible", timeout=timeout)
        return loc

    def tab(self, name: str):
        self.page.get_by_role("tab", name=name).or_(
            self.page.get_by_role("button", name=name)
        ).first.click()
        self.page.wait_for_timeout(500)

    def ingest(self, layer: str):
        self.tid(f"ingest-{layer}").click()
        # the load is a long nondeterministic wait (the daily price series made the
        # market layer heavy) — time-travel through it, like the assistant's wait
        self.fast_begin()
        self.page.get_by_test_id(f"ingest-{layer}").get_by_text("Loaded ✓").wait_for(timeout=600_000)
        self.fast_end("data loading")
        self.page.wait_for_timeout(800)

    # ── one method per scene id ──
    def scene_intro(self):
        self.tid("reset-db").click()
        self.fast_begin()
        self.page.get_by_text("database emptied").wait_for(timeout=120_000)
        self.fast_end("database reset")
        self.page.wait_for_timeout(600)

    def scene_ingest_market(self):
        self.ingest("market")

    def scene_ingest_governance(self):
        self.ingest("governance")

    def scene_ingest_cases(self):
        self.ingest("cases")

    # ── technical-cut helpers ──
    def zoom(self, factor: float):
        """Page zoom for drawer legibility at 1080p (document.body.style.zoom)."""
        self.page.evaluate(f"document.body.style.zoom = '{factor}'")
        self.page.wait_for_timeout(400)

    def drawer(self, want_open: bool):
        is_open = self.page.locator(".audit-drawer.open").count() > 0
        if is_open == want_open:
            return
        if want_open:
            self.page.locator(".audit-toggle").click()
        else:
            # the open drawer covers the edge toggle — use its own Close button
            self.page.locator(".audit-drawer.open").get_by_role(
                "button", name="Close", exact=True).click()
        self.page.wait_for_timeout(500)

    def drawer_show(self, group_text: str, zoom: float = 1.2, entry_text: str | None = None):
        """Open the drawer, expand the named query group and one entry (the first,
        or the one whose title matches `entry_text`) so the Cypher is ON SCREEN,
        zoomed for legibility. Robust to state left by earlier drawer scenes
        (expanded entries persist in React state)."""
        self.zoom(1.0)
        self.drawer(True)
        # match the group by its HEAD text (entry bodies may contain anything)
        group = self.page.locator(
            ".audit-group",
            has=self.page.locator(".audit-group-head", has_text=group_text),
        ).first
        head = group.locator(".audit-group-head").first
        for _ in range(4):
            if group.locator(".audit-entry-head").count() > 0:
                break
            head.scroll_into_view_if_needed()
            head.click()
            self.page.wait_for_timeout(700)
        else:
            raise RuntimeError(f"drawer_show: no entries appeared for group {group_text!r}")
        entry = (group.locator(".audit-entry", has_text=entry_text).first
                 if entry_text else group.locator(".audit-entry").first)
        if entry.locator(".audit-entry-body").count() == 0:
            entry.locator(".audit-entry-head").first.scroll_into_view_if_needed()
            entry.locator(".audit-entry-head").first.click()
            self.page.wait_for_timeout(400)
        entry.locator(".audit-entry-body").first.scroll_into_view_if_needed()
        self.zoom(zoom)

    def overlay_terminal(self, command: str, output: str):
        """A terminal-styled overlay with a REAL command's captured output —
        used for the make-test line and the MCP tool call (both deterministic)."""
        import html as html_mod
        body = html_mod.escape(output)[:4000]
        cmd = html_mod.escape(command)
        self.page.evaluate(
            """(html) => {
              let d = document.getElementById('__tech_overlay');
              if (!d) { d = document.createElement('div'); d.id = '__tech_overlay';
                        document.body.appendChild(d); }
              d.innerHTML = html;
            }""",
            f"""<div style="position:fixed;left:8%;right:8%;top:12%;bottom:14%;z-index:999;
                 background:#0c1220;color:#d7e3f4;border-radius:12px;padding:26px 30px;
                 font:15px/1.5 'SF Mono',Menlo,monospace;box-shadow:0 24px 60px rgba(0,0,0,.5);
                 overflow:hidden;white-space:pre-wrap">
                 <div style="color:#7ee787">$ {cmd}</div>\n{body}</div>""",
        )
        self.page.wait_for_timeout(400)

    def overlay_off(self):
        self.page.evaluate("document.getElementById('__tech_overlay')?.remove()")

    def frame_on(self, locator, block: str = "end", settle_ms: int = 1_200):
        """Cinematic framing: smooth-scroll what the narration talks about into
        view. Fails loudly (locator.evaluate raises) if the target is missing."""
        locator.first.evaluate(
            "(el, block) => el.scrollIntoView({behavior: 'smooth', block})", block)
        self.page.wait_for_timeout(settle_ms)

    def scene_schema_peek(self):
        self.tid("schema-peek-market").click()
        self.page.locator(".schema-peek-pop .schema-peek-sample").wait_for(timeout=60_000)
        self.frame_on(self.page.locator(".schema-peek-pop"), "center")
        self.page.wait_for_timeout(1_500)

    def scene_policy_framework(self):
        self.tab("Scenarios")
        self.tid("subtab-policy").click()
        self.page.get_by_text("R1", exact=False).first.wait_for(timeout=60_000)
        self.frame_on(self.page.locator(".policy-grid"), "start")
        self.page.wait_for_timeout(1_500)

    def scene_policy_compute(self):
        self.frame_on(self.tid("policy-compute"), "center")
        self.tid("policy-compute").click()
        self.tid("gap-summary", timeout=120_000)
        self.frame_on(self.tid("gap-summary"), "center")
        self.page.wait_for_timeout(1_500)

    def scene_s1_conjunction(self):
        self.tid("subtab-s1").click()
        self.tid("s1-run").click()
        self.page.get_by_text("Positions ranked").wait_for(timeout=120_000)
        # the conjunction opens on the FINANCIAL timeline — wait for the chart
        self.page.locator(".position-timeline canvas").first.wait_for(timeout=120_000)
        self.frame_on(self.page.locator(".s1-layout"), "start")
        self.page.wait_for_timeout(2_500)

    def scene_s1_graph(self):
        # the network behind the chart: the conjunction coloured, the rest grey
        self.tid("s1-show-graph").click()
        self.page.locator(".s1-graph .graph-canvas").first.wait_for(timeout=60_000)
        self.frame_on(self.page.locator(".s1-graph .graph-canvas"), "center")
        self.page.wait_for_timeout(2_500)

    def scene_s2_chronology(self):
        self.tid("subtab-s2").click()
        self.tid("s2-position").fill("POS-TP")
        self.tid("s2-run").click()
        self.page.get_by_text("MISSED").first.wait_for(timeout=120_000)
        # the financial timeline sits above the chronology — let it render and frame it
        self.page.locator(".position-timeline canvas").first.wait_for(timeout=120_000)
        self.frame_on(self.page.locator(".position-timeline"), "center")
        self.page.wait_for_timeout(1_500)

    def scene_s2_gaps(self):
        self.page.get_by_text("Expected vs observed").first.scroll_into_view_if_needed()
        self.page.wait_for_timeout(800)

    def scene_s3_pattern(self):
        # the companion panel (left open by the explain scene) would crowd S3
        if self.page.get_by_test_id("companion-close").count() > 0:
            self.page.get_by_test_id("companion-close").click()
            self.page.wait_for_timeout(400)
        self.tid("subtab-s3").click()
        self.tid("s3-run").click()
        self.page.get_by_text("REQUIRES").first.wait_for(timeout=120_000)
        self.frame_on(self.page.locator(".graph-canvas"), "end")
        self.page.wait_for_timeout(2_500)

    def scene_s4_readacross(self):
        self.tid("subtab-s4").click()
        self.tid("s4-run").click()
        self.page.get_by_text("100%").first.wait_for(timeout=120_000)
        self.frame_on(self.page.get_by_text("Every position vs the pattern"), "start")
        self.page.wait_for_timeout(1_500)

    def scene_s4_false_positive(self):
        self.frame_on(self.tid("s4-row-POS-FP"), "center")
        self.tid("s4-row-POS-FP").click()
        self.tid("s2-run").click()
        self.page.get_by_text("MISSED").first.wait_for(timeout=120_000)
        self.page.locator(".position-timeline canvas").first.wait_for(timeout=120_000)
        self.page.wait_for_timeout(1_000)

    def scene_s4_widen(self):
        # back to the matcher (S4 state resets on subtab switch — rerun, live)
        self.tid("subtab-s4").click()
        self.tid("s4-run").click()
        self.page.get_by_text("100%").first.wait_for(timeout=120_000)
        chips = self.page.locator(".chips")
        self.frame_on(chips, "center")
        # remove a condition — the scores re-rank — then put it back
        chips.locator(".chip", has_text="maturityBucket").locator(".chip-x").click()
        self.page.wait_for_timeout(1_800)
        self.page.locator(".chips select").select_option(label="maturityBucket=10Y+")
        self.page.get_by_role("button", name="Add", exact=True).click()
        self.page.wait_for_timeout(1_800)
        # the structural condition (same-desk approval, in the default pattern):
        # drop it — the set widens — then restore it — the set tightens
        chips.locator(".chip", has_text="Segregation of duties").locator(".chip-x").click()
        self.page.wait_for_timeout(1_800)
        self.page.locator(".chips select").select_option(label="Gap: Segregation of duties")
        self.page.get_by_role("button", name="Add", exact=True).click()
        self.page.wait_for_timeout(1_800)
        self.frame_on(self.page.get_by_text("Every position vs the pattern"), "start")
        self.page.wait_for_timeout(1_000)

    def scene_explain_click(self):
        # one Explain click on a GAP row (R5 — the review that upheld the marks);
        # the S2 gap table is already on screen from the previous scene
        self.page.get_by_test_id("explain-gap-R5").first.click()
        self.page.locator(".companion-entry").first.wait_for(timeout=120_000)
        self.page.wait_for_timeout(800)

    def scene_assistant_question(self):
        # The one live-LLM step: the answer may come without tool calls (no
        # .answer-viz) or fail transiently — accept any final assistant bubble
        # and retry ONCE with a typed question before failing loudly.
        from playwright.sync_api import TimeoutError as PWTimeout

        # the companion panel (left open by the explain scene) would cover the
        # question — close it first
        if self.page.get_by_test_id("companion-close").count() > 0:
            self.page.get_by_test_id("companion-close").click()
            self.page.wait_for_timeout(400)
        self.tab("Assistant")
        self.tid("chat-chip-0").click()
        self.page.wait_for_timeout(1_500)  # let the question bubble land on screen
        self.fast_begin()  # …then time-travel through the model's tool calls
        answered = ".answer-viz, .chat-bubble.chat-assistant:not(.chat-thinking)"

        def got_real_answer() -> bool:
            if self.page.locator(".answer-viz").count() > 0:
                return True
            bubbles = self.page.locator(".chat-bubble.chat-assistant:not(.chat-thinking)")
            return bubbles.count() > 0

        try:
            self.page.locator(answered).first.wait_for(timeout=240_000)
        except PWTimeout:
            print("  assistant: no answer in 240s — retrying with a typed question", flush=True)
        if not got_real_answer():
            self.tid("chat-input").fill(
                "Reconstruct what happened to POS-TP, in order, "
                "and tell me which control should have fired")
            self.page.keyboard.press("Enter")
            self.page.locator(answered).first.wait_for(timeout=240_000)
        if not got_real_answer():
            raise RuntimeError("assistant-question: no assistant answer after retry")
        self.fast_end("model tool calls")  # answer is on screen — back to real time
        # single-position chronology → the answer opens on its financial timeline;
        # give the chart a beat to render (non-fatal if the model answered text-only)
        try:
            self.page.locator(".answer-viz canvas").first.wait_for(timeout=15_000)
        except Exception:
            print("  assistant: no timeline canvas in the answer (text-only?)", flush=True)
        self.frame_on(self.page.locator(".answer-viz, .chat-bubble.chat-assistant").last, "end")
        self.page.wait_for_timeout(3_000)

    def scene_outro(self):
        target = self.page.locator(".answer-viz, .chat-bubble.chat-assistant").last
        if target.count() > 0:
            target.scroll_into_view_if_needed()
        self.page.wait_for_timeout(1_000)

    # ── technical cut (demo-script-technical.md) — deterministic, no LLM ──────

    def scene_tech_cold_open(self):
        # cold open on the LOADED database: one schema peek per layer, drawer open
        for layer in ("market", "governance", "cases"):
            self.tid(f"schema-peek-{layer}").click()
            self.page.locator(".schema-peek-pop .schema-peek-sample").wait_for(timeout=60_000)
            self.page.wait_for_timeout(6_000)
            self.page.mouse.click(24, 620)  # click-away closes
            self.page.wait_for_timeout(400)
        self.drawer_show("Schema peek: cases layer", zoom=1.15)
        self.page.wait_for_timeout(24_000)

    def scene_tech_policy_provenance(self):
        self.zoom(1.0)
        self.drawer(False)
        self.tab("Scenarios")
        self.tid("subtab-policy").click()
        self.page.get_by_text("R1", exact=False).first.wait_for(timeout=60_000)
        self.frame_on(self.page.locator(".policy-grid"), "start")
        # hover a Source label: the verbatim quote + link on screen
        self.page.locator(".policy-source").nth(1).hover()
        self.page.wait_for_timeout(26_000)

    def scene_tech_gap_branches(self):
        self.fast_begin()
        self.tid("policy-compute").click()
        self.tid("gap-summary", timeout=120_000)
        self.fast_end("gap recomputation")
        self.frame_on(self.tid("gap-summary"), "center")
        self.page.wait_for_timeout(1_500)
        # the single gap query, on screen: UNION branches in the drawer (the
        # entry with the file banner, not the obligation lookup before it)
        self.drawer_show("Compute governance gaps", zoom=1.2, entry_text="═")
        self.page.wait_for_timeout(45_000)

    def scene_tech_s2_engine(self):
        self.zoom(1.0)
        self.drawer(False)
        self.tid("subtab-s2").click()
        self.tid("s2-position").fill("POS-TP")
        self.tid("s2-run").click()
        self.page.get_by_text("MISSED").first.wait_for(timeout=120_000)
        self.page.locator(".position-timeline canvas").first.wait_for(timeout=120_000)
        self.page.wait_for_timeout(1_500)
        # a marker popover: the three graph-written prices (hunt along the band)
        box = self.page.locator(".position-timeline canvas").first.bounding_box()
        found = False
        for fy in (0.28, 0.33, 0.24, 0.38):
            for fx in [0.35 + 0.02 * i for i in range(21)]:
                self.page.mouse.click(box["x"] + box["width"] * fx, box["y"] + box["height"] * fy)
                if self.page.locator(".tlx-popover").count() > 0:
                    found = True
                    break
            if found:
                break
        if not found:
            raise RuntimeError("tech-s2-engine: no timeline marker popover found")
        self.page.wait_for_timeout(9_000)
        self.page.mouse.click(30, 700)  # close the popover
        self.drawer_show("S2 · QPP governance chain", zoom=1.2)
        self.page.wait_for_timeout(18_000)

    def scene_tech_pattern_node(self):
        self.zoom(1.0)
        self.drawer(False)
        self.tid("subtab-s3").click()
        self.tid("s3-run").click()
        self.page.get_by_text("REQUIRES").first.wait_for(timeout=120_000)
        self.frame_on(self.page.locator(".graph-canvas"), "center")
        self.page.wait_for_timeout(1_500)
        self.drawer_show("S3 · Abstract the confirmed case", zoom=1.2)
        self.page.wait_for_timeout(30_000)

    def scene_tech_matching_query(self):
        self.zoom(1.0)
        self.drawer(False)
        self.tid("subtab-s4").click()
        self.tid("s4-run").click()
        self.page.get_by_text("100%").first.wait_for(timeout=120_000)
        self.drawer_show("S4 · Read-across", zoom=1.2)
        self.page.wait_for_timeout(32_000)
        self.zoom(1.0)
        self.drawer(False)
        # drop the structural condition — the set widens — then restore it
        chips = self.page.locator(".chips")
        self.frame_on(chips, "center")
        chips.locator(".chip", has_text="Segregation of duties").locator(".chip-x").click()
        self.page.wait_for_timeout(1_800)
        self.page.locator(".chips select").select_option(label="Gap: Segregation of duties")
        self.page.get_by_role("button", name="Add", exact=True).click()
        self.page.wait_for_timeout(1_800)

    def scene_tech_discovery_open(self):
        self.tid("tech-toggle").click()
        self.page.get_by_role("tab", name="Discovery").click()
        self.page.get_by_text("Structure finds what you didn't").wait_for(timeout=30_000)
        self.page.wait_for_timeout(5_000)

    def scene_tech_circles(self):
        self.fast_begin()
        self.tid("disc-circles-run").click()
        self.page.locator(".disc-circles-table tbody tr").first.wait_for(timeout=240_000)
        self.fast_end("graph computation")
        self.frame_on(self.page.locator(".disc-circles-table"), "center")
        self.page.wait_for_timeout(2_000)
        self.drawer_show("Discovery · approval circles", zoom=1.2, entry_text="louvain")
        self.page.wait_for_timeout(26_000)
        self.zoom(1.0)
        self.drawer(False)
        self.tid("disc-circles-propose").click()
        self.page.get_by_text("badged candidate").wait_for(timeout=60_000)
        # the candidate lands in the Policy step
        self.tab("Scenarios")
        self.tid("subtab-policy").click()
        self.frame_on(self.page.get_by_text("R-C1").first, "center")
        self.page.wait_for_timeout(4_500)
        # back to Discovery; the explainer, paged to the modularity slide
        self.page.get_by_role("tab", name="Discovery").click()
        self.tid("disc-how-circles").click()
        self.page.locator(".disc-explainer-modal").wait_for(timeout=30_000)
        for _ in range(2):
            self.page.keyboard.press("ArrowRight")
            self.page.wait_for_timeout(1_400)
        self.page.wait_for_timeout(12_000)
        self.page.keyboard.press("Escape")

    def scene_tech_trajectories(self):
        self.fast_begin()
        self.tid("disc-traj-run").click()
        self.page.locator('[data-testid="disc-panel-traj"] tbody tr').first.wait_for(timeout=300_000)
        self.fast_end("graph computation")
        self.frame_on(self.page.locator(".disc-heatmaps"), "center")
        self.page.wait_for_timeout(16_000)
        self.frame_on(self.page.locator(".disc-eval"), "center")
        self.page.wait_for_timeout(6_000)
        # explainer: page to the published worked-example slide
        self.tid("disc-how-trajectories").click()
        self.page.locator(".disc-explainer-modal").wait_for(timeout=30_000)
        self.page.keyboard.press("ArrowRight")
        self.page.get_by_text("Proven against the published example").wait_for(timeout=10_000)
        self.page.wait_for_timeout(18_000)
        self.page.keyboard.press("Escape")
        # output button → the S4 receiver row with provenance
        self.page.locator('[data-testid^="disc-watch-"]').first.click()
        self.page.get_by_text("added to the S4 watchlist").wait_for(timeout=60_000)
        self.tab("Scenarios")
        self.tid("subtab-s4").click()
        self.tid("s4-watchlist", timeout=30_000)
        self.frame_on(self.tid("s4-watchlist"), "center")
        self.page.wait_for_timeout(5_000)
        self.page.get_by_role("tab", name="Discovery").click()

    def scene_tech_decorrelation(self):
        self.fast_begin()
        self.tid("disc-decorr-run").click()
        self.page.locator('[data-testid="disc-panel-decorr"] tbody tr').first.wait_for(timeout=300_000)
        self.fast_end("graph computation")
        self.frame_on(self.page.locator('[data-testid="disc-panel-decorr"]'), "start")
        self.page.wait_for_timeout(5_000)
        self.drawer_show("Discovery · peer decorrelation", zoom=1.2)
        self.page.wait_for_timeout(22_000)
        self.zoom(1.0)
        self.drawer(False)
        # ALL Discovery interactions BEFORE navigating: the tab unmounts on a
        # tab switch and the panel's result state (and its buttons) would vanish
        self.tid("disc-decorr-r10").click()
        self.page.get_by_text("the gap query evaluates it").wait_for(timeout=120_000)
        self.frame_on(self.page.locator('[data-testid="disc-panel-decorr"] table'), "center")
        self.page.wait_for_timeout(6_000)
        self.tid("disc-how-decorrelation").click()
        self.page.locator(".disc-explainer-modal").wait_for(timeout=30_000)
        for _ in range(5):
            self.page.keyboard.press("ArrowRight")
            self.page.wait_for_timeout(500)
        self.page.get_by_text("is not a control").first.wait_for(timeout=10_000)
        self.page.wait_for_timeout(6_500)
        self.page.keyboard.press("Escape")
        self.tid("disc-decorr-clusters").click()
        self.page.get_by_text("behaviour clusters written").wait_for(timeout=60_000)
        # the ▼ marker sits between the overrides on POS-TP's timeline
        self.tab("Scenarios")
        self.tid("subtab-s2").click()
        self.tid("s2-position").fill("POS-TP")
        self.tid("s2-run").click()
        self.page.locator(".position-timeline canvas").first.wait_for(timeout=120_000)
        self.frame_on(self.page.locator(".position-timeline"), "center")
        self.page.wait_for_timeout(6_000)
        # the new attributes are in the graph — visible in Explore's counters
        self.tab("Explore")
        self.frame_on(self.page.locator(".db-counts"), "center")
        self.page.wait_for_timeout(4_500)

    def scene_tech_reset(self):
        self.page.get_by_role("tab", name="Discovery").click()
        self.tid("disc-reset").click()
        self.page.get_by_text("every Discovery write removed").wait_for(timeout=60_000)
        self.page.wait_for_timeout(1_200)
        # the guarantee, on screen: the REAL test output, captured now
        proc = subprocess.run(
            ["uv", "run", "pytest", "tests/test_no_gds_executive.py", "-v", "--no-header"],
            capture_output=True, text=True, cwd=ROOT)
        lines = [ln for ln in proc.stdout.splitlines()
                 if "test_executive" in ln or "passed" in ln]
        self.overlay_terminal("uv run pytest tests/test_no_gds_executive.py -v",
                              "\n".join(lines))
        self.page.wait_for_timeout(18_000)
        self.overlay_off()

    def scene_tech_mcp_close(self):
        # one REAL tool call against the same typed tools the Assistant uses
        code = ("import json, mcp_server; rows = mcp_server.tool_expected_controls('POS-TP'); "
                "broken = [r for r in rows if r['status'] in ('MISSED','LATE')]; "
                "print(json.dumps(broken[:3], indent=1, default=str)); "
                "print(f'... {len(broken)} broken controls on POS-TP')")
        proc = subprocess.run(["uv", "run", "python", "-c", code],
                              capture_output=True, text=True, cwd=ROOT)
        self.overlay_terminal(
            "python -c \"mcp_server.tool_expected_controls('POS-TP')\"  # MCP typed tool",
            proc.stdout or proc.stderr)
        self.page.wait_for_timeout(20_000)
        self.overlay_off()
        self.drawer(True)  # end on the audit drawer
        self.page.wait_for_timeout(6_000)

    def run_scene(self, scene_id: str):
        method = getattr(self, "scene_" + scene_id.replace("-", "_"))
        method()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-audio", action="store_true", help="silent cut for pacing checks")
    ap.add_argument("--base", default=None, help="app base URL (default: probe 5173-5176)")
    ap.add_argument("--script", default=str(SCRIPT_MD),
                    help="storyboard markdown (default: demo-script.md)")
    args = ap.parse_args()

    script = Path(args.script)
    cfg = parse_config(script)
    name = cfg["output"]
    scenes = parse_scenes(script)
    check_vocabulary(scenes, cfg, script)
    print(f"{len(scenes)} scenes parsed from {script.name} (cut '{name}', vocabulary gate passed)")

    audio: dict[str, Path | None] = {}
    durations: dict[str, float] = {}
    if args.no_audio:
        for s in scenes:
            audio[s["id"]] = None
            durations[s["id"]] = words_estimate_seconds(s["narration"])
    else:
        from tts import duration_seconds, get_provider, synthesize

        provider = get_provider()
        for s in scenes:
            print(f"tts: {s['id']}")
            wav = synthesize(s["narration"], DIST / "audio", provider=provider)
            audio[s["id"]] = wav
            durations[s["id"]] = duration_seconds(wav)

    base = args.base or probe_base_url()
    print(f"recording against {base}")

    from playwright.sync_api import TimeoutError as PWTimeout
    from playwright.sync_api import sync_playwright

    (DIST / "raw").mkdir(parents=True, exist_ok=True)
    results = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)

        # title card (separate, non-recorded context) — per-script title/subtitle
        title_html = TITLE_HTML
        if cfg["title"]:
            title_html = re.sub(
                r'(letter-spacing:-1px[^>]*>)\n?.*?(</div>)',
                lambda m: m.group(1) + "\n" + cfg["title"] + m.group(2),
                title_html, count=1, flags=re.DOTALL)
        if cfg["subtitle"]:
            title_html = re.sub(
                r'(line-height:1\.5">)\n?.*?(</div>)',
                lambda m: m.group(1) + "\n" + cfg["subtitle"] + m.group(2),
                title_html, count=1, flags=re.DOTALL)
        tctx = browser.new_context(viewport={"width": 1920, "height": 1080})
        tpage = tctx.new_page()
        tpage.set_content(title_html)
        tpage.wait_for_timeout(400)
        tpage.screenshot(path=str(DIST / f"title-{name}.png"))
        tctx.close()

        ctx = browser.new_context(
            viewport={"width": 1920, "height": 1080},
            record_video_dir=str(DIST / "raw"),
            record_video_size={"width": 1920, "height": 1080},
        )
        page = ctx.new_page()
        page.on("dialog", lambda d: d.accept())
        page.goto(base)
        page.get_by_text("Fraudulent Valuation").first.wait_for(timeout=30_000)

        rec = Recorder(page, time.monotonic())
        for s in scenes:
            sid = s["id"]
            rec.scene_fast = []
            t0 = rec.now()
            print(f"scene {sid} @ {t0:6.1f}s")
            try:
                rec.run_scene(sid)
            except PWTimeout as exc:
                print(f"scene {sid}: selector missing/failed: {exc}", file=sys.stderr)
                ctx.close()
                browser.close()
                sys.exit(1)
            elapsed = rec.now() - t0
            # fast-forward windows are compressed at assembly — the narration must
            # cover the COMPRESSED scene, so hold against the compressed elapsed
            saved = sum((w["to"] - w["from"]) * (1 - 1 / w["speed"]) for w in rec.scene_fast)
            hold = max(0.0, durations[sid] + 1.0 - (elapsed - saved))
            if hold:
                page.wait_for_timeout(int(hold * 1000))
            results.append({
                "id": sid,
                "start": round(t0, 2),
                "end": round(rec.now(), 2),
                "narration": s["narration"],
                "audio": str(audio[sid].relative_to(DIST)) if audio[sid] else None,
                "fast": rec.scene_fast,
            })

        video = page.video
        ctx.close()  # flushes the webm
        raw_path = Path(video.path())
        browser.close()

    session = DIST / "raw" / f"{name}.webm"
    if raw_path != session:
        session.unlink(missing_ok=True)
        raw_path.rename(session)

    index = DIST / f"scenes-{name}.json"
    index.write_text(json.dumps({
        "video": f"raw/{name}.webm",
        "title_card": f"title-{name}.png",
        "scenes": results,
    }, indent=1))
    total = results[-1]["end"]
    print(f"recorded {len(results)} scenes, {total:.0f}s -> {session} + {index}")


if __name__ == "__main__":
    main()
