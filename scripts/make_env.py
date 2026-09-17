#!/usr/bin/env python3
"""Derive root .env (python side) and app/.env (Vite side) from inputs/.env.

inputs/.env is the single user-provided source of truth (DECISIONS.md #10).
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "inputs" / ".env"

VITE_MAP = {
    "NEO4J_URI": "VITE_NEO4J_URI",
    "NEO4J_USER": "VITE_NEO4J_USER",
    "NEO4J_PASSWORD": "VITE_NEO4J_PASSWORD",
    "NEO4J_DATABASE": "VITE_NEO4J_DATABASE",
    "GEMINI_API_KEY": "VITE_GEMINI_API_KEY",
}


def parse_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip()
    return values


def main() -> None:
    if not SOURCE.exists():
        raise SystemExit("inputs/.env not found — create it with NEO4J_* and GEMINI_API_KEY")
    values = parse_env(SOURCE)

    missing = [k for k in VITE_MAP if k not in values]
    if missing:
        raise SystemExit(f"inputs/.env is missing: {', '.join(missing)}")

    root_env = ROOT / ".env"
    root_env.write_text("".join(f"{k}={v}\n" for k, v in values.items()))
    print(f"wrote {root_env}")

    app_env = ROOT / "app" / ".env"
    app_env.parent.mkdir(parents=True, exist_ok=True)
    app_env.write_text("".join(f"{vk}={values[k]}\n" for k, vk in VITE_MAP.items()))
    print(f"wrote {app_env}")


if __name__ == "__main__":
    main()
