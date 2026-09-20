#!/usr/bin/env python3
"""Contact sheet for a cut: one frame per scene (60% through, remap-aware),
tiled 3-across → dist/contact-<name>.png. Review it before committing a video.

Usage: uv run python scripts/frames.py [--name demo|demo-technical]
"""

import argparse
import json
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
TITLE_SECONDS = 3.0


def make_remap(windows: list[dict]):
    windows = sorted(windows, key=lambda w: w["from"])

    def remap(t: float) -> float:
        out = t
        for w in windows:
            if t <= w["from"]:
                break
            out -= (min(t, w["to"]) - w["from"]) * (1 - 1 / w["speed"])
        return out

    return remap


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="demo")
    ap.add_argument("--at", type=float, default=0.6, help="fraction through each scene")
    args = ap.parse_args()
    name = args.name

    meta = json.loads((DIST / f"scenes-{name}.json").read_text())
    video = DIST / f"{name}.mp4"
    if not video.exists():
        raise SystemExit(f"{video} missing — run scripts/assemble_video.py --name {name}")
    scenes = meta["scenes"]
    remap = make_remap([w for s in scenes for w in (s.get("fast") or [])])

    with tempfile.TemporaryDirectory() as td:
        files = []
        for i, s in enumerate(scenes):
            a, b = remap(s["start"]) + TITLE_SECONDS, remap(s["end"]) + TITLE_SECONDS
            t = a + (b - a) * args.at
            f = Path(td) / f"{i:02d}.png"
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{t:.2f}", "-i", str(video),
                 "-frames:v", "1", "-vf", "scale=480:270", str(f)], check=True)
            files.append(f)
        cols = 3
        layout = "|".join(f"{(i % cols) * 480}_{(i // cols) * 270}" for i in range(len(files)))
        inputs: list[str] = []
        for f in files:
            inputs += ["-i", str(f)]
        out = DIST / f"contact-{name}.png"
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error"] + inputs
            + ["-filter_complex", f"xstack=inputs={len(files)}:layout={layout}", str(out)],
            check=True)
    print(f"{out} — {len(files)} frames ({name})")


if __name__ == "__main__":
    main()
