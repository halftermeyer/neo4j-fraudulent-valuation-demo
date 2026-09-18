#!/usr/bin/env python3
"""Assemble dist/demo.mp4 from the recording, the per-scene narration and the
storyboard timestamps: 3 s title card + screen track with narration aligned to
each scene's start, burned-in subtitles from the narration. H.264, 1080p, no
music. Requires ffmpeg and a prior run of scripts/record_demo.py."""

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


def build_cues(scenes: list[dict], offset: float) -> list[tuple[float, float, str]]:
    cues = []
    for sc in scenes:
        sentences = [x.strip() for x in re.split(r"(?<=[.!?])\s+", sc["narration"]) if x.strip()]
        if not sentences:
            continue
        start = sc["start"] + offset
        end = sc["end"] + offset
        span = max(end - start, 1.0)
        weights = [len(x.split()) for x in sentences]
        total_w = sum(weights)
        t = start
        for sent, w in zip(sentences, weights):
            dur = span * w / total_w
            cues.append((t, min(t + dur, end), sent))
            t += dur
    return cues


def write_srt(cues: list[tuple[float, float, str]], out: Path) -> None:
    lines = []
    for i, (a, b, text) in enumerate(cues, 1):
        lines += [str(i), f"{srt_time(a)} --> {srt_time(b)}", text, ""]
    out.write_text("\n".join(lines))
    print(f"wrote {len(cues)} subtitle cues -> {out}")


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
        for i, (_, _, text) in enumerate(cues):
            page.set_content(
                f"""<body style="margin:0;display:flex;justify-content:center;align-items:flex-start;background:transparent">
                <div id="cue" style="display:inline-block;background:rgba(10,16,30,.62);color:#fff;
                font:600 30px/1.35 Inter,Helvetica,Arial,sans-serif;padding:10px 26px;border-radius:8px;
                max-width:1500px;text-align:center">{text}</div></body>"""
            )
            p = out_dir / f"cue-{i:03d}.png"
            page.locator("#cue").screenshot(path=str(p), omit_background=True)
            paths.append(p)
        browser.close()
    return paths


def main() -> None:
    if not shutil.which("ffmpeg"):
        raise SystemExit("ffmpeg not found on PATH — brew install ffmpeg")
    meta_path = DIST / "scenes.json"
    if not meta_path.exists():
        raise SystemExit("dist/scenes.json missing — run scripts/record_demo.py first")
    meta = json.loads(meta_path.read_text())
    scenes = meta["scenes"]
    webm = DIST / meta["video"]
    title_png = DIST / meta["title_card"]
    for p in (webm, title_png):
        if not p.exists():
            raise SystemExit(f"missing artifact: {p}")

    # sidecar SRT aligned to the FINAL video (title offset); the burn happens on
    # the main transcode, so those cues use recording time (offset 0) — the
    # concat-copied _cat.mp4 has stitched timestamps that break enable=between()
    srt = DIST / "subtitles.srt"
    write_srt(build_cues(scenes, TITLE_SECONDS), srt)
    cues = build_cues(scenes, 0.0)

    title_mp4 = DIST / "_title.mp4"
    main_mp4 = DIST / "_main.mp4"

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
    pngs = render_cue_pngs(cues, DIST / "subs")

    cmd = ["ffmpeg", "-y", "-i", str(webm)]
    for p in pngs:
        cmd += ["-i", str(p)]
    wavs = [(sc["start"], DIST / sc["audio"]) for sc in scenes if sc.get("audio")]
    audio_base = 1 + len(pngs)
    if wavs:
        for _, wav in wavs:
            cmd += ["-i", str(wav)]
    else:
        cmd += ["-f", "lavfi", "-t", "9999", "-i", "anullsrc=r=48000:cl=stereo"]

    parts = [f"[0:v]scale=1920:1080,fps=30[vbase]"]
    prev = "vbase"
    for i, (a, b, _) in enumerate(cues):
        label = f"v{i}" if i < len(cues) - 1 else "vout"
        parts.append(
            f"[{prev}][{i + 1}:v]overlay=(W-w)/2:H-h-42:enable='between(t,{a:.2f},{b:.2f})'[{label}]"
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
    out = DIST / "demo.mp4"
    concat_list = DIST / "_concat.txt"
    concat_list.write_text(f"file '{title_mp4.name}'\nfile '{main_mp4.name}'\n")
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_list),
         "-c", "copy", str(out)])

    for p in (title_mp4, main_mp4, concat_list):
        p.unlink(missing_ok=True)
    size_mb = out.stat().st_size / 1e6
    print(f"dist/demo.mp4 ready ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
