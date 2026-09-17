#!/usr/bin/env python3
"""Download and cache the real public datasets for the mismarking demo.

Layer 1 sources (see DATA_PLAN.md §1):
  - OSBAP stage-1 daily TRACE panel (zipped parquet, includes 144A via db_type==3)
  - ESMA FITRS non-equity transparency full files (bond liquidity assessments)
  - FRED Treasury constant-maturity curve (multi-series CSV, no API key)

Everything lands under data/cache/ and is never re-downloaded if present and
complete. Stdlib-only (urllib + curl subprocess) so it runs before `uv sync`.
Big files go through `curl -C -` so an interrupted download resumes.
"""

import json
import subprocess
import sys
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "data" / "cache"

OSBAP_URL = "https://openbondassetpricing.com/wp-content/uploads/2025/12/stage1_osbap_0k_volume_2025.zip"
OSBAP_SIZE = 1_830_781_280  # content-length verified 2026-09-17

# Two snapshots are enough: the liquidity flag is nearly static (DECISIONS.md #6)
FITRS_SNAPSHOT_PREFIXES = ["FULNCR_20211106_D", "FULNCR_20221105_D"]
FITRS_SOLR = "https://registers.esma.europa.eu/solr/esma_registers_fitrs_files/select"
FITRS_DOWNLOAD_BASE = "https://fitrs.esma.europa.eu/fitrs/"

FRED_SERIES = "DGS1MO,DGS3MO,DGS6MO,DGS1,DGS2,DGS3,DGS5,DGS7,DGS10,DGS20,DGS30"
FRED_URL = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={FRED_SERIES}"


def curl_download(url: str, dest: Path, expected_size: int | None = None) -> None:
    if dest.exists():
        if expected_size is None or dest.stat().st_size == expected_size:
            print(f"  cached   {dest.name} ({dest.stat().st_size:,} bytes)")
            return
        print(f"  size mismatch on {dest.name}, resuming")
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    cmd = ["curl", "-L", "--fail", "--retry", "5", "--retry-delay", "5",
           "-C", "-", "-o", str(part), url]
    print(f"  fetching {dest.name} ...")
    subprocess.run(cmd, check=True)
    if expected_size is not None and part.stat().st_size != expected_size:
        raise RuntimeError(
            f"{dest.name}: got {part.stat().st_size:,} bytes, expected {expected_size:,}")
    part.rename(dest)
    print(f"  done     {dest.name} ({dest.stat().st_size:,} bytes)")


def verify_zip(path: Path) -> None:
    if not zipfile.is_zipfile(path):
        raise RuntimeError(f"{path.name} is not a valid zip — delete it and re-run")


def fitrs_part_urls(prefix: str) -> list[str]:
    """List all parts of a FITRS full-file snapshot via the ESMA Solr register."""
    params = urllib.parse.urlencode({
        "q": f"file_name:{prefix}_*",
        "wt": "json",
        "rows": "50",
        "fl": "file_name,download_link",
    })
    req = urllib.request.Request(f"{FITRS_SOLR}?{params}",
                                 headers={"User-Agent": "mismarking-demo/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        docs = json.load(resp)["response"]["docs"]
    urls = sorted(d["download_link"] for d in docs if d["file_name"].startswith(prefix))
    if not urls:
        raise RuntimeError(f"No FITRS files found in the register for {prefix}_*")
    return urls


def main() -> None:
    print("== OSBAP stage-1 daily TRACE panel (~1.83 GB, one-time) ==")
    osbap_dest = CACHE / "osbap" / "stage1_osbap_0k_volume_2025.zip"
    curl_download(OSBAP_URL, osbap_dest, expected_size=OSBAP_SIZE)
    verify_zip(osbap_dest)

    print("== ESMA FITRS bond liquidity snapshots ==")
    for prefix in FITRS_SNAPSHOT_PREFIXES:
        for url in fitrs_part_urls(prefix):
            name = url.rsplit("/", 1)[-1]
            dest = CACHE / "fitrs" / name
            curl_download(url, dest)
            verify_zip(dest)

    print("== FRED Treasury CMT curve ==")
    fred_dest = CACHE / "fred" / "treasury_cmt.csv"
    if fred_dest.exists() and fred_dest.stat().st_size > 100_000:
        print(f"  cached   {fred_dest.name}")
    else:
        fred_dest.parent.mkdir(parents=True, exist_ok=True)
        req = urllib.request.Request(FRED_URL, headers={"User-Agent": "mismarking-demo/1.0"})
        with urllib.request.urlopen(req, timeout=120) as resp:
            fred_dest.write_bytes(resp.read())
        header = fred_dest.read_text().splitlines()[0]
        if not header.startswith("observation_date,DGS1MO"):
            raise RuntimeError(f"Unexpected FRED CSV header: {header}")
        print(f"  done     {fred_dest.name} ({fred_dest.stat().st_size:,} bytes)")

    print("All caches ready under data/cache/.")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # visible failure for the Makefile / background log
        print(f"DOWNLOAD FAILED: {exc}", file=sys.stderr)
        sys.exit(1)
