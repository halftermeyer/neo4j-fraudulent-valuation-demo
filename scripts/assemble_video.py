#!/usr/bin/env python3
"""Assemble dist/demo.mp4 from the recording, the per-scene narration and the
storyboard timestamps: 3 s title card + screen track with narration aligned to
each scene's start, burned-in subtitles from the narration. H.264, 1080p, no
music. Requires ffmpeg and a prior run of scripts/record_demo.py."""

import argparse
import json
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
TITLE_SECONDS = 3.0


def run(cmd: list[str], cwd: Path | None = None) -> None:
    print("+", " ".join(str(c) for c in cmd))
    subprocess.run(cmd, check=True, cwd=cwd)


def srt_time(t: float) -> str:
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


FAST_BADGE_DEFAULT = "fast-forwarded"


def fast_windows(scenes: list[dict]) -> list[dict]:
    """All fast-forward windows, absolute recording time, sorted."""
    out = [w for sc in scenes for w in sc.get("fast") or []]
    return sorted(out, key=lambda w: w["from"])


def make_remap(windows: list[dict]):
    """Recording time -> compressed-output time (fast windows sped up)."""
    def remap(t: float) -> float:
        out = t
        for w in windows:
            a, b, k = w["from"], w["to"], w["speed"]
            if t <= a:
                break
            span = min(t, b) - a
            out -= span * (1 - 1 / k)
        return out
    return remap


def audio_seconds(path: Path) -> float | None:
    import contextlib
    import wave
    try:
        with contextlib.closing(wave.open(str(path))) as w:
            return w.getnframes() / w.getframerate()
    except Exception:
        return None


def build_cues(scenes: list[dict], offset: float, remap) -> list[tuple[float, float, str, str]]:
    """(start, end, text, kind) — kind 'sub' (bottom) or 'badge' (top right).
    Subtitle cues follow the NARRATION (the wav's duration), not the scene span:
    a scene whose action outlasts its narration must not stretch the cues."""
    cues: list[tuple[float, float, str, str]] = []
    for sc in scenes:
        sentences = [x.strip() for x in re.split(r"(?<=[.!?])\s+", sc["narration"]) if x.strip()]
        if not sentences:
            continue
        start = remap(sc["start"]) + offset
        end = remap(sc["end"]) + offset
        wav_dur = audio_seconds(DIST / sc["audio"]) if sc.get("audio") else None
        if wav_dur is not None:
            end = min(end, start + wav_dur + 0.5)
        span = max(end - start, 1.0)
        weights = [len(x.split()) for x in sentences]
        total_w = sum(weights)
        t = start
        for sent, w in zip(sentences, weights):
            dur = span * w / total_w
            cues.append((t, min(t + dur, end), sent, "sub"))
            t += dur
        for w in sc.get("fast") or []:
            badge = f"⏩ {w.get('label', FAST_BADGE_DEFAULT)} — fast-forwarded"
            cues.append((remap(w["from"]) + offset, remap(w["to"]) + offset, badge, "badge"))
    return cues


def write_srt(cues: list[tuple[float, float, str, str]], out: Path) -> None:
    lines = []
    subs = [c for c in cues if c[3] == "sub"]
    for i, (a, b, text, _) in enumerate(subs, 1):
        lines += [str(i), f"{srt_time(a)} --> {srt_time(b)}", text, ""]
    out.write_text("\n".join(lines))
    print(f"wrote {len(subs)} subtitle cues -> {out}")


def ffmpeg_has_subtitles_filter() -> bool:
    out = subprocess.run(["ffmpeg", "-hide_banner", "-filters"],
                         capture_output=True, text=True).stdout
    return " subtitles " in out


def render_cue_pngs(cues: list[tuple[float, float, str]], out_dir: Path) -> list[Path]:
    """Homebrew's ffmpeg ships without libass/drawtext — render each cue as a
    transparent PNG with Playwright and let ffmpeg overlay them."""
    from playwright.sync_api import sync_playwright

    shutil.rmtree(out_dir, ignore_errors=True)
    out_dir.mkdir(parents=True)
    paths = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1920, "height": 200})
        for i, (_, _, text, kind) in enumerate(cues):
            if kind == "badge":
                style = ("display:inline-block;background:rgba(95,61,196,.88);color:#fff;"
                         "font:700 24px/1.3 Inter,Helvetica,Arial,sans-serif;"
                         "padding:8px 20px;border-radius:18px")
            else:
                style = ("display:inline-block;background:rgba(10,16,30,.62);color:#fff;"
                         "font:600 30px/1.35 Inter,Helvetica,Arial,sans-serif;"
                         "padding:10px 26px;border-radius:8px;max-width:1500px;text-align:center")
            page.set_content(
                f"""<body style="margin:0;display:flex;justify-content:center;align-items:flex-start;background:transparent">
                <div id="cue" style="{style}">{text}</div></body>"""
            )
            p = out_dir / f"cue-{i:03d}.png"
            page.locator("#cue").screenshot(path=str(p), omit_background=True)
            paths.append(p)
        browser.close()
    return paths


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="demo",
                    help="cut name: reads dist/scenes-<name>.json, writes dist/<name>.mp4")
    args = ap.parse_args()
    name = args.name

    if not shutil.which("ffmpeg"):
        raise SystemExit("ffmpeg not found on PATH — brew install ffmpeg")
    meta_path = DIST / f"scenes-{name}.json"
    if not meta_path.exists():
        raise SystemExit(f"{meta_path} missing — run scripts/record_demo.py first")
    meta = json.loads(meta_path.read_text())
    scenes = meta["scenes"]
    webm = DIST / meta["video"]
    title_png = DIST / meta["title_card"]
    for p in (webm, title_png):
        if not p.exists():
            raise SystemExit(f"missing artifact: {p}")

    # fast-forward windows ("time travel" through dead LLM waits): the video is
    # sped up inside each window, and every downstream timestamp (audio delays,
    # cue windows, SRT) is remapped through the same function
    windows = fast_windows(scenes)
    remap = make_remap(windows)
    if windows:
        for w in windows:
            print(f"fast-forward {w['from']:.1f}s → {w['to']:.1f}s at {w['speed']:.0f}×")

    # sidecar SRT aligned to the FINAL video (title offset); the burn happens on
    # the main transcode, so those cues use remapped recording time (offset 0) —
    # the concat-copied _cat.mp4 has stitched timestamps that break enable=between()
    srt = DIST / f"subtitles-{name}.srt"
    write_srt(build_cues(scenes, TITLE_SECONDS, remap), srt)
    cues = build_cues(scenes, 0.0, remap)

    title_mp4 = DIST / f"_title-{name}.mp4"
    main_mp4 = DIST / f"_main-{name}.mp4"

    # 1. title card (3 s, silent stereo aac so concat streams match)
    run(["ffmpeg", "-y", "-loop", "1", "-framerate", "30", "-t", str(TITLE_SECONDS),
         "-i", str(title_png), "-f", "lavfi", "-t", str(TITLE_SECONDS),
         "-i", "anullsrc=r=48000:cl=stereo",
         "-vf", "scale=1920:1080", "-c:v", "libx264", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-shortest", str(title_mp4)])

    # 2. main track: one transcode = scale + burned subtitles (overlay-PNG; this
    # ffmpeg bottle has no libass) + narration aligned per scene (or silence).
    if ffmpeg_has_subtitles_filter():
        print("note: ffmpeg has libass — the overlay-PNG burn is still used for uniformity")
    pngs = render_cue_pngs(cues, DIST / f"subs-{name}")

    cmd = ["ffmpeg", "-y", "-i", str(webm)]
    for p in pngs:
        cmd += ["-i", str(p)]
    wavs = [(remap(sc["start"]), DIST / sc["audio"]) for sc in scenes if sc.get("audio")]
    audio_base = 1 + len(pngs)
    if wavs:
        for _, wav in wavs:
            cmd += ["-i", str(wav)]
    else:
        cmd += ["-f", "lavfi", "-t", "9999", "-i", "anullsrc=r=48000:cl=stereo"]

    parts = [f"[0:v]scale=1920:1080,fps=30[vscaled]"]
    if windows:
        # alternate normal/fast segments: trim each, speed up the fast ones, concat
        bounds: list[tuple[float, float | None, float]] = []  # (from, to|None, speed)
        cursor = 0.0
        for w in windows:
            if w["from"] > cursor:
                bounds.append((cursor, w["from"], 1.0))
            bounds.append((w["from"], w["to"], w["speed"]))
            cursor = w["to"]
        bounds.append((cursor, None, 1.0))
        parts.append(f"[vscaled]split={len(bounds)}" + "".join(f"[s{i}]" for i in range(len(bounds))))
        for i, (a, b, k) in enumerate(bounds):
            trim = f"trim={a:.3f}:{b:.3f}" if b is not None else f"trim=start={a:.3f}"
            pts = "PTS-STARTPTS" if k == 1.0 else f"(PTS-STARTPTS)/{k:.0f}"
            parts.append(f"[s{i}]{trim},setpts={pts}[p{i}]")
        parts.append("".join(f"[p{i}]" for i in range(len(bounds)))
                     + f"concat=n={len(bounds)}:v=1:a=0[vbase]")
    else:
        parts.append("[vscaled]null[vbase]")
    prev = "vbase"
    for i, (a, b, _, kind) in enumerate(cues):
        label = f"v{i}" if i < len(cues) - 1 else "vout"
        pos = "W-w-36:36" if kind == "badge" else "(W-w)/2:H-h-42"
        parts.append(
            f"[{prev}][{i + 1}:v]overlay={pos}:enable='between(t,{a:.2f},{b:.2f})'[{label}]"
        )
        prev = label
    if wavs:
        labels = []
        for j, (start, _) in enumerate(wavs):
            ms = int(start * 1000)
            parts.append(f"[{audio_base + j}:a]adelay={ms}|{ms}[a{j}]")
            labels.append(f"[a{j}]")
        parts.append(f"{''.join(labels)}amix=inputs={len(wavs)}:normalize=0[aout]")
        audio_map = "[aout]"
    else:
        audio_map = f"{audio_base}:a"
    cmd += ["-filter_complex", ";".join(parts), "-map", f"[{prev}]", "-map", audio_map,
            "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-ar", "48000", "-ac", "2", str(main_mp4)]
    run(cmd)

    # 3. concat title + main -> final (codecs match; -c copy)
    out = DIST / f"{name}.mp4"
    concat_list = DIST / f"_concat-{name}.txt"
    concat_list.write_text(f"file '{title_mp4.name}'\nfile '{main_mp4.name}'\n")
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_list),
         "-c", "copy", str(out)])

    for p in (title_mp4, main_mp4, concat_list):
        p.unlink(missing_ok=True)
    size_mb = out.stat().st_size / 1e6
    print(f"dist/{name}.mp4 ready ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
