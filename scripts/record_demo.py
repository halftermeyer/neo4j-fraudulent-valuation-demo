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
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

DIST = ROOT / "dist"
SCRIPT_MD = ROOT / "demo-script.md"

KNOWN_SCENES = [
    "intro", "ingest-market", "ingest-governance", "ingest-cases",
    "schema-peek", "explore-position", "explore-signals",
    "policy-framework", "policy-compute",
    "s1-conjunction", "s1-community",
    "s2-chronology", "s2-gaps", "s3-pattern", "s4-readacross", "s4-predict",
    "s4-false-positive", "policy-change", "explain-click", "assistant-question",
    "outro",
]

TITLE_HTML = """
<html><body style="margin:0;width:1920px;height:1080px;display:flex;flex-direction:column;
justify-content:center;align-items:center;font-family:Inter,Helvetica,Arial,sans-serif;
background:linear-gradient(135deg,#0b297d 0%,#006fd6 70%,#00b4d8 100%);color:#fff">
<div style="font-size:64px;font-weight:800;letter-spacing:-1px">Mismarking Detection on Neo4j</div>
<div style="font-size:28px;max-width:1100px;text-align:center;margin-top:28px;opacity:.94;line-height:1.5">
The graph does not detect fraud. It detects the conjunction of weak signals that fraud
leaves behind — a human establishes intent.</div>
<div style="font-size:20px;margin-top:56px;opacity:.75;border:1px solid rgba(255,255,255,.5);
border-radius:20px;padding:8px 24px">Neo4j + GDS · RISK ORM demo</div>
</body></html>
"""


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
        raise SystemExit("no ```scene blocks found in demo-script.md")
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

    def frame_on(self, locator, block: str = "end", settle_ms: int = 1_200):
        """Cinematic framing: smooth-scroll what the narration talks about into
        view. Fails loudly (locator.evaluate raises) if the target is missing."""
        locator.first.evaluate(
            "(el, block) => el.scrollIntoView({behavior: 'smooth', block})", block)
        self.page.wait_for_timeout(settle_ms)

    def scene_schema_peek(self):
        self.tid("schema-peek-governance").click()
        self.page.locator(".schema-peek-pop .schema-peek-sample").wait_for(timeout=60_000)
        self.frame_on(self.page.locator(".schema-peek-pop"), "center")
        self.page.wait_for_timeout(1_500)

    def scene_explore_position(self):
        # click-away closes the schema-peek popover left open by the previous scene
        self.page.mouse.click(24, 620)
        self.page.wait_for_timeout(400)
        self.tid("select-position").select_option("POS-TP")
        for step in ("step-1", "step-2", "step-3"):
            self.tid(step).click()
            self.page.wait_for_timeout(1_000)
        # the narration talks about the node + price chart — bring them on screen
        self.frame_on(self.page.locator(".graph-canvas"), "end")
        self.page.wait_for_timeout(1_500)

    def scene_explore_signals(self):
        # frame the canvas first: buttons, chart and graph then share the viewport,
        # so the audience watches the shape form while the clicks happen
        self.frame_on(self.page.locator(".graph-canvas"), "end")
        for k in ("add-pnl", "add-overrides", "add-changes", "add-ipv", "add-gaps"):
            self.tid(k).click()
            self.page.wait_for_timeout(900)
        self.frame_on(self.page.locator(".graph-canvas"), "end")
        self.page.wait_for_timeout(2_500)

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

    def scene_s1_community(self):
        self.tid("s1-show-graph").click()
        self.page.locator(".s1-graph .graph-canvas").first.wait_for(timeout=60_000)
        self.tid("s1-louvain").click()
        self.page.get_by_text("Louvain found").wait_for(timeout=300_000)
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

    def scene_s4_predict(self):
        self.tid("s4-predict").click()
        self.page.get_by_text("held-out").first.wait_for(timeout=300_000)
        self.frame_on(self.page.get_by_text("held-out").first, "center")
        self.page.wait_for_timeout(1_500)

    def scene_s4_false_positive(self):
        self.frame_on(self.tid("s4-row-POS-FP"), "center")
        self.tid("s4-row-POS-FP").click()
        self.tid("s2-run").click()
        self.page.get_by_text("MISSED").first.wait_for(timeout=120_000)
        self.page.locator(".position-timeline canvas").first.wait_for(timeout=120_000)
        self.page.wait_for_timeout(1_000)

    def scene_policy_change(self):
        self.tid("subtab-policy").click()
        self.frame_on(self.tid("policy-R5-divergenceBps"), "center")
        field = self.tid("policy-R5-divergenceBps")
        field.fill("100")
        self.tid("policy-apply-R5").click()
        self.page.get_by_test_id("policy-apply-R5").get_by_text("Apply").wait_for(timeout=300_000)
        self.page.wait_for_timeout(1_200)
        self.tid("policy-reset").click()
        self.page.get_by_test_id("policy-reset").get_by_text("Reset to CSV defaults").wait_for(timeout=300_000)
        self.page.wait_for_timeout(1_200)

    def scene_explain_click(self):
        self.tid("subtab-s2").click()
        if self.page.get_by_text("Expected vs observed").count() == 0:
            self.tid("s2-run").click()
            self.page.get_by_text("MISSED").first.wait_for(timeout=120_000)
        self.tid("explain-s2-card").click()
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

    def run_scene(self, scene_id: str):
        method = getattr(self, "scene_" + scene_id.replace("-", "_"))
        method()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-audio", action="store_true", help="silent cut for pacing checks")
    ap.add_argument("--base", default=None, help="app base URL (default: probe 5173-5176)")
    args = ap.parse_args()

    scenes = parse_scenes(SCRIPT_MD)
    print(f"{len(scenes)} scenes parsed from demo-script.md")

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

        # title card (separate, non-recorded context)
        tctx = browser.new_context(viewport={"width": 1920, "height": 1080})
        tpage = tctx.new_page()
        tpage.set_content(TITLE_HTML)
        tpage.wait_for_timeout(400)
        tpage.screenshot(path=str(DIST / "title.png"))
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

    session = DIST / "raw" / "session.webm"
    if raw_path != session:
        session.unlink(missing_ok=True)
        raw_path.rename(session)

    (DIST / "scenes.json").write_text(json.dumps({
        "video": "raw/session.webm",
        "title_card": "title.png",
        "scenes": results,
    }, indent=1))
    total = results[-1]["end"]
    print(f"recorded {len(results)} scenes, {total:.0f}s -> dist/raw/session.webm + dist/scenes.json")


if __name__ == "__main__":
    main()
