#!/usr/bin/env python3
"""generate_data.py — build the three data layers of the mismarking demo.

Layer 1 (REAL):      OSBAP daily TRACE panel -> illiquid bond universe, monthly
                     prices, FRED proxy curve, ESMA FITRS liquidity tiers.
Layer 2 (SYNTHETIC): governance events generated FROM the ControlObligations in
                     inputs/control_obligations.csv with a per-desk compliance
                     rate. Gaps are NEVER written here — they are computed by
                     data/gap_query.cypher after ingest (DECISIONS.md #9).
Layer 3 (CASES):     POS-TP encoded from inputs/public_true_positive_2012.csv
                     (+ R7 anchor MAPReview, + TP_CLOCK_OFFSET_YEARS shift) and
                     the deliberate false positive POS-FP (breaks exactly
                     R2, R4, R6 at default parameters).

Outputs:
  data/layers/{market,governance,cases}.json   (UI Ingest payloads, also copied
                                                to app/public/data/layers/)
  data/load_data.cypher                        (cypher-shell / MCP parity)
  data/holdout_links.json                      (S4 link-prediction ground truth)
  templates/customer_case_template.xlsx        (second-true-positive slot)

Deterministic: random.seed(42). Replayable via `make data`.
"""

import csv
import json
import os
import random
import shutil
import zipfile
from bisect import bisect_left, bisect_right
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "data" / "cache"
DERIVED = CACHE / "derived"
LAYERS = ROOT / "data" / "layers"
APP_DATA = ROOT / "app" / "public" / "data"

SEED = 42
TP_CLOCK_OFFSET_YEARS = int(os.getenv("TP_CLOCK_OFFSET_YEARS", "10"))  # DECISIONS.md #3

WINDOW_START = date(2021, 1, 1)   # real-price window
WINDOW_END = date(2022, 12, 31)
GOV_START = date(2020, 1, 1)      # governance clock: 3 years monthly
GOV_END = date(2022, 12, 31)
AS_OF = "2023-01-01T00:00:00"     # dataset clock end — default $asOf everywhere
REGIME_BREAK_AT = date(2022, 9, 30)  # 2022 rate-shock marker (DECISIONS.md #2)

N_INSTRUMENTS = 3000
N_POSITIONS = 100                 # incl. POS-TP and POS-FP
TRADING_DAYS = 502                # 2021–2022
ILLIQ_PCT_DAYS = 0.05

FF30_SECTOR = {  # Fama-French 30 -> demo sector buckets
    1: "Consumer", 2: "Consumer", 3: "Consumer", 4: "Consumer", 5: "Consumer",
    6: "Consumer", 7: "Consumer", 8: "Healthcare", 9: "Materials", 10: "Materials",
    11: "Industrials", 12: "Materials", 13: "Industrials", 14: "Industrials",
    15: "Industrials", 16: "Industrials", 17: "Materials", 18: "Energy",
    19: "Energy", 20: "Utilities", 21: "Telecom", 22: "Services", 23: "Technology",
    24: "Materials", 25: "Transport", 26: "Services", 27: "Consumer",
    28: "Consumer", 29: "Financials", 30: "Other",
}

FRED_TENORS = [(1 / 12, "DGS1MO"), (0.25, "DGS3MO"), (0.5, "DGS6MO"), (1, "DGS1"),
               (2, "DGS2"), (3, "DGS3"), (5, "DGS5"), (7, "DGS7"), (10, "DGS10"),
               (20, "DGS20"), (30, "DGS30")]

rng = random.Random(SEED)


# ───────────────────────────────── helpers ──────────────────────────────────

def dt(d: date, hour: int = 12) -> str:
    return f"{d.isoformat()}T{hour:02d}:00:00"


def month_ends(start: date, end: date) -> list[date]:
    out, cur = [], date(start.year, start.month, 1)
    while cur <= end:
        nxt = date(cur.year + (cur.month == 12), cur.month % 12 + 1, 1)
        me = nxt - timedelta(days=1)
        if start <= me <= end:
            out.append(me)
        cur = nxt
    return out


def shift_years(d: date, years: int) -> date:
    try:
        return d.replace(year=d.year + years)
    except ValueError:  # Feb 29
        return d.replace(year=d.year + years, day=28)


class Graph:
    """Accumulates nodes/relationships and emits layer JSON + cypher."""

    def __init__(self):
        self.nodes: dict[str, dict] = {}          # id -> {labels, props, layer}
        self.rels: list[dict] = []                # {type, from, to, props, layer}

    def node(self, layer: str, labels: str | list[str], nid: str, **props):
        labels = [labels] if isinstance(labels, str) else labels
        if nid in self.nodes:
            self.nodes[nid]["props"].update({k: v for k, v in props.items() if v is not None})
            return nid
        self.nodes[nid] = {"labels": labels, "props": {"id": nid, **{k: v for k, v in props.items() if v is not None}}, "layer": layer}
        return nid

    def rel(self, layer: str, rtype: str, src: str, dst: str, **props):
        self.rels.append({"type": rtype, "from": src, "to": dst,
                          "props": {k: v for k, v in props.items() if v is not None}, "layer": layer})

    def event(self, layer: str, label: str, nid: str, position_id: str | None, at: str, **props):
        labels = [label, "Event"]
        return self.node(layer, labels, nid, at=at, positionId=position_id, **props)


G = Graph()


# ══════════════════════════ LAYER 1 — real data ═════════════════════════════

def derive_osbap() -> tuple[list[dict], dict[str, list[dict]], dict[str, list[dict]]]:
    """Return (universe stats per cusip, monthly month-end prices per selected cusip,
    daily prices with per-day OHLC per selected cusip).
    Heavy pass cached under data/cache/derived/."""
    uni_f = DERIVED / "universe.json"
    px_f = DERIVED / "monthly_prices.json"
    daily_f = DERIVED / "daily_prices.json"
    if uni_f.exists() and px_f.exists() and daily_f.exists() and not os.getenv("REBUILD_DERIVED"):
        return (json.loads(uni_f.read_text()), json.loads(px_f.read_text()),
                json.loads(daily_f.read_text()))

    import pyarrow.compute as pc
    import pyarrow.dataset as ds

    pq_path = CACHE / "osbap" / "stage1_osbap_0k_volume_2025.parquet"
    if not pq_path.exists():
        with zipfile.ZipFile(CACHE / "osbap" / "stage1_osbap_0k_volume_2025.zip") as z:
            inner = [n for n in z.namelist() if n.endswith(".parquet")][0]
            z.extract(inner, CACHE / "osbap" / "_x")
            (CACHE / "osbap" / "_x" / inner).rename(pq_path)

    cols = ["cusip_id", "trd_exctn_dt", "pr", "ytm", "mod_dur", "credit_spread",
            "trade_count", "dvolume", "prc_bid", "prc_ask", "db_type",
            "ff30num", "bond_maturity", "bond_age", "bond_amt_outstanding",
            "prc_first", "prc_hi", "prc_lo", "prc_last"]
    dataset = ds.dataset(pq_path)
    table = dataset.to_table(
        columns=cols,
        filter=(pc.field("trd_exctn_dt") >= pc.scalar(datetime(2021, 1, 1)))
        & (pc.field("trd_exctn_dt") <= pc.scalar(datetime(2022, 12, 31))))
    import pandas as pd
    df = table.to_pandas()
    df["trd_exctn_dt"] = pd.to_datetime(df["trd_exctn_dt"]).dt.date

    g = df.groupby("cusip_id")
    stats = pd.DataFrame({
        "days": g.size(),
        "first": g["trd_exctn_dt"].min(),
        "last": g["trd_exctn_dt"].max(),
        "is144a": g["db_type"].max().eq(3),
        "ff30": g["ff30num"].median(),
        "maturity_years": g["bond_maturity"].median(),
        "amt_out": g["bond_amt_outstanding"].median(),
        "min_pr": g["pr"].min(),
        "max_pr": g["pr"].max(),
        "med_pr": g["pr"].median(),
    })
    ba = df.dropna(subset=["prc_bid", "prc_ask"])
    ba = ba[ba["prc_ask"] > ba["prc_bid"]]
    stats["bidask_pct"] = (ba.assign(x=(ba["prc_ask"] - ba["prc_bid"]) / ba["pr"] * 100)
                           .groupby("cusip_id")["x"].median())
    stats["pct_days"] = stats["days"] / TRADING_DAYS

    alive = stats[(stats["first"] <= date(2021, 6, 30)) & (stats["last"] >= date(2022, 7, 1))]
    illiq = alive[(alive["is144a"]) | (alive["pct_days"] < ILLIQ_PCT_DAYS)].copy()
    illiq["defaulted"] = (illiq["min_pr"] < 30) & (illiq["max_pr"] > 70)
    # rank: prefer wide bid-ask and enough observations to chart
    illiq["rank"] = illiq["days"].rank(pct=True) + illiq["bidask_pct"].fillna(0).rank(pct=True)
    universe = illiq.sort_values("rank", ascending=False).head(N_INSTRUMENTS)

    # position instruments: chartable (>=14 distinct months) with wide bid-ask
    monthly_cover = (df[df["cusip_id"].isin(universe.index)]
                     .assign(m=lambda x: x["trd_exctn_dt"].map(lambda d: (d.year, d.month)))
                     .groupby("cusip_id")["m"].nunique())
    universe["months"] = monthly_cover
    chartable = universe[universe["months"] >= 14].sort_values("bidask_pct", ascending=False)
    selected = list(chartable.head(N_POSITIONS + 20).index)  # spares for FP choice

    # month-end price per selected cusip
    sel = df[df["cusip_id"].isin(selected)].copy()
    sel["ym"] = sel["trd_exctn_dt"].map(lambda d: f"{d.year}-{d.month:02d}")
    sel = sel.sort_values("trd_exctn_dt").groupby(["cusip_id", "ym"]).last().reset_index()
    prices: dict[str, list[dict]] = {}
    for _, r in sel.iterrows():
        prices.setdefault(r["cusip_id"], []).append({
            "date": r["trd_exctn_dt"].isoformat(),
            "pr": None if pd.isna(r["pr"]) else round(float(r["pr"]), 3),
            "ytm": None if pd.isna(r["ytm"]) else float(r["ytm"]),
            "mod_dur": None if pd.isna(r["mod_dur"]) else float(r["mod_dur"]),
            "bid": None if pd.isna(r["prc_bid"]) else round(float(r["prc_bid"]), 3),
            "ask": None if pd.isna(r["prc_ask"]) else round(float(r["prc_ask"]), 3),
        })

    # daily prices for selected cusips — one row per TRADED day (gaps are real);
    # OHLC from the parquet's intraday aggregates when trade_count > 1
    def num(v, nd=3):
        return None if pd.isna(v) else round(float(v), nd)

    seld = df[df["cusip_id"].isin(selected)].sort_values("trd_exctn_dt")
    daily: dict[str, list[dict]] = {}
    for _, r in seld.iterrows():
        if pd.isna(r["pr"]):
            continue
        daily.setdefault(r["cusip_id"], []).append({
            "date": r["trd_exctn_dt"].isoformat(),
            "pr": num(r["pr"]),
            "open": num(r["prc_first"]), "high": num(r["prc_hi"]),
            "low": num(r["prc_lo"]), "close": num(r["prc_last"]),
            "tradeCount": None if pd.isna(r["trade_count"]) else int(r["trade_count"]),
            "ytm": None if pd.isna(r["ytm"]) else float(r["ytm"]),
            "bid": num(r["prc_bid"]), "ask": num(r["prc_ask"]),
        })

    uni_records = []
    for cusip, r in universe.iterrows():
        uni_records.append({
            "cusip": cusip,
            "is144a": bool(r["is144a"]),
            "pctDaysTraded": round(float(r["pct_days"]), 4),
            "bidAskPct": None if pd.isna(r["bidask_pct"]) else round(float(r["bidask_pct"]), 3),
            "sector": FF30_SECTOR.get(int(r["ff30"]) if not pd.isna(r["ff30"]) else 30, "Other"),
            "maturityYears": None if pd.isna(r["maturity_years"]) else round(float(r["maturity_years"]), 1),
            "amtOutstanding": None if pd.isna(r["amt_out"]) else float(r["amt_out"]),
            "medPrice": round(float(r["med_pr"]), 2),
            "defaulted": bool(r["defaulted"]),
            "chartable": cusip in selected,
        })
    DERIVED.mkdir(parents=True, exist_ok=True)
    uni_f.write_text(json.dumps(uni_records))
    px_f.write_text(json.dumps(prices))
    daily_f.write_text(json.dumps(daily))
    return uni_records, prices, daily


def derive_fred() -> list[dict]:
    """Month-end Treasury CMT curve rows 2020-07..2023-01."""
    rows = []
    with open(CACHE / "fred" / "treasury_cmt.csv") as f:
        header = f.readline().strip().split(",")
        idx = {name: i for i, name in enumerate(header)}
        per_month: dict[str, list[str]] = {}
        for line in f:
            parts = line.strip().split(",")
            d = parts[0]
            if "2020-07-01" <= d <= "2023-01-31":
                per_month[d[:7]] = parts  # last row of each month wins
    for ym, parts in sorted(per_month.items()):
        row = {"date": parts[0]}
        for _, series in FRED_TENORS:
            v = parts[idx[series]]
            row[series.lower()] = float(v) if v else None
        rows.append(row)
    return rows


def treasury_yield(curve_row: dict, dur_years: float) -> float | None:
    pts = [(t, curve_row.get(s.lower())) for t, s in FRED_TENORS]
    pts = [(t, v) for t, v in pts if v is not None]
    if not pts:
        return None
    xs = [t for t, _ in pts]
    i = bisect_left(xs, dur_years)
    if i == 0:
        return pts[0][1]
    if i >= len(pts):
        return pts[-1][1]
    (x0, y0), (x1, y1) = pts[i - 1], pts[i]
    return y0 + (y1 - y0) * (dur_years - x0) / (x1 - x0)


def derive_fitrs(universe_cusips: set[str]) -> dict[str, bool]:
    """cusip -> Lqdty flag from the two FITRS snapshots (2022 wins)."""
    cache_f = DERIVED / "fitrs_us.json"
    if cache_f.exists() and not os.getenv("REBUILD_DERIVED"):
        return {k: v for k, v in json.loads(cache_f.read_text()).items() if k in universe_cusips}
    from lxml import etree
    result: dict[str, bool] = {}
    files = sorted((CACHE / "fitrs").glob("FULNCR_*_D_*.zip"))  # 2021 first, 2022 overwrites
    for zf in files:
        with zipfile.ZipFile(zf) as z:
            for name in z.namelist():
                with z.open(name) as fh:
                    for _, el in etree.iterparse(fh, tag="{*}NonEqtyTrnsprncyData"):
                        isin = clssfctn = lqdty = None
                        for child in el.iter():
                            tag = etree.QName(child).localname
                            if tag == "Id":
                                isin = child.text
                            elif tag == "FinInstrmClssfctn":
                                clssfctn = child.text
                            elif tag == "Lqdty":
                                lqdty = child.text
                        if (isin and clssfctn == "BOND" and lqdty is not None
                                and isin.startswith("US")):
                            result[isin[2:11]] = lqdty == "true"
                        el.clear(keep_tail=True)
    DERIVED.mkdir(parents=True, exist_ok=True)
    cache_f.write_text(json.dumps(result))
    return {k: v for k, v in result.items() if k in universe_cusips}


RA_CACHE: dict[tuple[str, str], str] = {}


def risk_attribute(atype: str, value: str, provenance: str | None = None) -> str:
    key = (atype, value)
    if key not in RA_CACHE:
        nid = f"RA-{atype}-{value}".replace(" ", "_")
        G.node("market", "RiskAttribute", nid, type=atype, value=value, provenance=provenance)
        RA_CACHE[key] = nid
    return RA_CACHE[key]


def maturity_bucket(years: float | None) -> str:
    if years is None:
        return "5-10Y"
    if years < 2:
        return "<2Y"
    if years < 5:
        return "2-5Y"
    if years < 10:
        return "5-10Y"
    return "10Y+"


def build_market_layer():
    universe, prices, daily = derive_osbap()
    fitrs = derive_fitrs({u["cusip"] for u in universe})
    curve_rows = derive_fred()

    curve_by_ym = {}
    for row in curve_rows:
        G.node("market", "Curve", f"CURVE-{row['date']}", at=f"{row['date']}T17:00:00",
               **{k: v for k, v in row.items() if k != "date"})
        curve_by_ym[row["date"][:7]] = row

    G.event("market", "RegimeBreak", "REGIME-2022-RATE-SHOCK", None, dt(REGIME_BREAK_AT),
            name="2022 rate shock", description="Sharp global rate repricing through 2022; regime break for illiquid credit valuation.")

    chartable = []
    for u in universe:
        cusip = u["cusip"]
        iid = f"INSTR-{cusip}"
        in_fitrs = cusip in fitrs
        tier = "illiquid" if (not in_fitrs or not fitrs[cusip]) else "liquid"
        provenance = ("ESMA FITRS (not assessed liquid)" if in_fitrs and not fitrs[cusip]
                      else "ESMA FITRS" if in_fitrs
                      else "computed (TRACE % days traded)")
        G.node("market", "Instrument", iid,
               cusip=cusip, name=f"{u['sector']} bond {cusip}",
               is144a=u["is144a"], pctDaysTraded=u["pctDaysTraded"],
               bidAskPct=u["bidAskPct"], maturityYears=u["maturityYears"],
               amtOutstandingUsd=u["amtOutstanding"], medPrice=u["medPrice"],
               defaulted=u["defaulted"], sector=u["sector"],
               liquiditySource=provenance, synthetic=False)
        G.rel("market", "HAS_RISK_ATTRIBUTE", iid, risk_attribute("issuerSector", u["sector"]))
        G.rel("market", "HAS_RISK_ATTRIBUTE", iid, risk_attribute("maturityBucket", maturity_bucket(u["maturityYears"])))
        G.rel("market", "HAS_RISK_ATTRIBUTE", iid, risk_attribute("liquidityTier", tier, provenance))
        if u["chartable"]:
            chartable.append(u)

    # proxy-model anchor per chartable instrument (price emission is deferred to
    # emit_price_series once the held positions are known)
    proxy_ctx = {}
    for u in chartable:
        cusip = u["cusip"]
        series = prices.get(cusip, [])
        base = next((s for s in series if s["pr"] and s["ytm"] and s["mod_dur"]), None)
        if base is None:
            continue
        y0 = base["ytm"] * 100 if base["ytm"] < 1.5 else base["ytm"]
        dur = base["mod_dur"]
        t0 = treasury_yield(curve_by_ym.get(base["date"][:7], {}), dur)
        spread0 = (y0 - t0) if t0 is not None else 2.0
        proxy_ctx[cusip] = {"p0": base["pr"], "y0": y0, "dur": dur, "spread0": spread0}

    def emit_price_series(held_cusips: set[str]):
        """Observed + proxy prices for chartable instruments. Held positions get
        the full DAILY TRACE series (with per-day OHLC where several trades
        printed — gaps stay gaps); the rest of the universe keeps month-end
        prices. Proxy-model points stay month-end (the continuous line), each
        COMPARED_WITH the month-end observation as before."""
        for u in chartable:
            cusip = u["cusip"]
            series = prices.get(cusip, [])
            if cusip not in proxy_ctx:
                continue
            ctx = proxy_ctx[cusip]
            base_pr, y0, dur, spread0 = ctx["p0"], ctx["y0"], ctx["dur"], ctx["spread0"]

            def proxy_at(ym: str, ytm_obs: float | None, prev: float) -> tuple[float, float] | None:
                crow = curve_by_ym.get(ym)
                t = treasury_yield(crow, dur) if crow else None
                if t is None:
                    return None
                proxy_y = t + spread0
                proxy_p = round(base_pr * (1 - dur * (proxy_y - y0) / 100), 3)
                if ytm_obs is not None:
                    y_obs = ytm_obs * 100 if ytm_obs < 1.5 else ytm_obs
                    div = round((y_obs - proxy_y) * 100)
                else:
                    div = round(prev)
                return proxy_p, div

            def emit_proxy(obs_id: str, date_s: str, ym: str, ytm_obs, prev: float) -> float:
                got = proxy_at(ym, ytm_obs, prev)
                if got is None:
                    return prev
                proxy_p, div_bps = got
                px_id = f"MPX-{cusip}-{date_s}"
                G.event("market", "MarketPrice", px_id, None, f"{date_s}T17:00:00",
                        clean=max(proxy_p, 1.0), source="proxy-model")
                G.rel("market", "PRICE_OF", px_id, f"INSTR-{cusip}")
                G.rel("market", "COMPARED_WITH", obs_id, px_id, divergenceBps=div_bps)
                return div_bps

            prev_div = 0.0
            if cusip in held_cusips and daily.get(cusip):
                drows = daily[cusip]
                last_of_month = {r["date"][:7]: r["date"] for r in drows}  # last wins (sorted)
                for r in drows:
                    obs_id = f"MP-{cusip}-{r['date']}"
                    ohlc = ({"open": r["open"], "high": r["high"], "low": r["low"],
                             "close": r["close"], "tradeCount": r["tradeCount"]}
                            if (r["tradeCount"] or 0) > 1 else {"tradeCount": r["tradeCount"]})
                    G.event("market", "MarketPrice", obs_id, None, f"{r['date']}T17:00:00",
                            clean=r["pr"], ytm=r["ytm"], bid=r["bid"], ask=r["ask"],
                            source="TRACE", **ohlc)
                    G.rel("market", "PRICE_OF", obs_id, f"INSTR-{cusip}")
                    if last_of_month[r["date"][:7]] == r["date"]:
                        prev_div = emit_proxy(obs_id, r["date"], r["date"][:7], r["ytm"], prev_div)
            else:
                for s in series:
                    if s["pr"] is None:
                        continue
                    obs_id = f"MP-{cusip}-{s['date']}"
                    G.event("market", "MarketPrice", obs_id, None, f"{s['date']}T17:00:00",
                            clean=s["pr"], ytm=s["ytm"], bid=s["bid"], ask=s["ask"], source="TRACE")
                    G.rel("market", "PRICE_OF", obs_id, f"INSTR-{cusip}")
                    prev_div = emit_proxy(obs_id, s["date"], s["date"][:7], s["ytm"], prev_div)

    return chartable, proxy_ctx, emit_price_series


# ═════════════════════ LAYER 2 — synthetic governance ═══════════════════════

TRADING_DESKS = [
    ("DESK-01", "US IG Credit"), ("DESK-02", "US HY Credit"), ("DESK-03", "EM Credit"),
    ("DESK-04", "Structured Credit"), ("DESK-05", "EM Rates"), ("DESK-06", "Munis"),
    ("DESK-07", "Distressed"), ("DESK-08", "Financials Credit"), ("DESK-09", "Energy Credit"),
    ("DESK-10", "Crossover"), ("DESK-11", "Private Placements"), ("DESK-12", "Convertibles"),
    ("DESK-13", "Illiquid Situations"), ("DESK-14", "Real Estate Credit"),
    ("DESK-15", "Utilities Credit"),
]
FUNCTION_DESKS = [("DESK-IPV", "IPV / Valuation Control"), ("DESK-RISK", "Market Risk"),
                  ("DESK-PC", "Product Control"), ("DESK-MAP", "MAP / Model Validation")]
CASE_DESK = ("DESK-CIO", "CIO Structured Book")  # TP desk

POLICY_MAP = {
    "POL-VAL": ("Valuation Policy", ["R1", "R2", "R3"]),
    "POL-MAP": ("Market Conformity (MAP) Policy", ["R4", "R7"]),
    "POL-IPV": ("Independent Price Verification Policy", ["R5"]),
    "POL-PNL": ("P&L Control Policy", ["R6"]),
    "POL-GOV": ("Governance & Evidence Policy", ["R8", "R9"]),
}

obligations: dict[str, dict] = {}
persons_by_desk: dict[str, list[str]] = {}
function_people: dict[str, list[str]] = {}
_eid = 0


def eid(prefix: str) -> str:
    global _eid
    _eid += 1
    return f"{prefix}-{_eid:05d}"


def load_obligations():
    with open(ROOT / "inputs" / "control_obligations.csv") as f:
        for row in csv.DictReader(f):
            params = json.loads(row["params_json"]) if row["params_json"].strip() else {}
            obligations[row["id"]] = {**row, "params": params}


def build_governance_static():
    for pid, (name, rules) in POLICY_MAP.items():
        G.node("governance", "Policy", pid, name=name)
    for rid, o in obligations.items():
        props = {
            "name": o["name"], "triggerEvent": o["trigger_event"],
            "triggerCondition": o["trigger_condition"], "requiredControl": o["required_control"],
            "requiredByRole": o["required_by_role"], "timing": o["timing"],
            "slaDays": int(o["sla_days"]), "severity": o["severity"],
            "appliesToAttribute": o["applies_to_attribute"] or None,
            "gapDefinition": o["gap_definition"],
            "paramsJson": json.dumps(o["params"]), "defaultParamsJson": json.dumps(o["params"]),
        }
        for k, v in o["params"].items():
            props[k] = v
        if rid == "R8":
            props["sameDeskAllowed"] = bool(o["params"].get("sameDeskAllowed", False))
        G.node("governance", "ControlObligation", rid, **props)
        policy = next(p for p, (_, rules) in POLICY_MAP.items() if rid in rules)
        G.rel("governance", "GOVERNED_BY", rid, policy)

    G.node("governance", "Committee", "COM-VAL", name="Valuation Committee")
    G.node("governance", "Committee", "COM-MAP", name="MAP Committee")

    for did, name in TRADING_DESKS + FUNCTION_DESKS + [CASE_DESK]:
        G.node("governance", "Desk", did, name=name)

    pn = 0
    for did, _ in TRADING_DESKS:
        ids = []
        for role in ["Trader", "Trader", "Desk head"]:
            pn += 1
            pid = f"PER-{pn:03d}"
            G.node("governance", ["Person"], pid, name=f"{role} {pn:03d}", role=role)
            G.rel("governance", "ON_DESK", pid, did)
            ids.append(pid)
        persons_by_desk[did] = ids
    for did, roles in [("DESK-IPV", ["IPV analyst"] * 4), ("DESK-RISK", ["Risk officer"] * 3 + ["Deputy CRO"]),
                       ("DESK-PC", ["Product controller"] * 3), ("DESK-MAP", ["MAP member"] * 3)]:
        ids = []
        for role in roles:
            pn += 1
            pid = f"PER-{pn:03d}"
            G.node("governance", ["Person"], pid, name=f"{role} {pn:03d}", role=role)
            G.rel("governance", "ON_DESK", pid, did)
            ids.append(pid)
        function_people[did] = ids
        persons_by_desk[did] = ids


def independent_approver(desk_id: str) -> str:
    pool = function_people["DESK-RISK"] + function_people["DESK-MAP"]
    return rng.choice(pool)


def add_evidence(layer: str, pos_id: str | None, target: str, at: date, etype: str = "document"):
    ev = eid("EV")
    G.event(layer, "Evidence", ev, pos_id, dt(at), type=etype)
    G.rel(layer, "EVIDENCED_BY", target, ev)
    return ev


def add_approval(layer: str, pos_id: str, trigger: str, at: date, approver: str,
                 committee: str | None = None, evidenced: bool = True):
    a = eid("APR")
    G.event(layer, "Approval", a, pos_id, dt(at))
    G.rel(layer, "APPROVED_BY", trigger, a)
    G.rel(layer, "APPROVED_BY", a, approver)
    if committee:
        G.rel(layer, "APPROVED_BY", a, committee)
    if evidenced:
        add_evidence(layer, pos_id, a, at)
    return a


def add_escalation(layer: str, pos_id: str, source: str, at: date, to: str = "COM-MAP",
                   evidenced: bool = True, origin: str | None = None):
    e = eid("ESC")
    G.event(layer, "Escalation", e, pos_id, dt(at), origin=origin)
    G.rel(layer, "ESCALATED_TO", source, e)
    G.rel(layer, "ESCALATED_TO", e, to)
    if evidenced:
        add_evidence(layer, pos_id, e, at)
    return e


def build_positions(chartable: list[dict], proxy_ctx: dict) -> list[dict]:
    """Assign the 98 synthetic positions to instruments/desks and simulate."""
    desk_compliance = {}
    for did, _ in TRADING_DESKS:
        desk_compliance[did] = round(rng.uniform(0.88, 0.98), 2)
    desk_compliance["DESK-07"] = 0.60   # sloppy — near-miss factory
    desk_compliance["DESK-13"] = 0.68
    for did, _ in TRADING_DESKS + [CASE_DESK]:
        G.nodes[did]["props"]["complianceRate"] = desk_compliance.get(did, 1.0)

    fp_instr = next(u for u in chartable
                    if u["cusip"] in proxy_ctx and u["sector"] in ("Financials", "Energy", "Other")
                    and u["maturityYears"] and u["maturityYears"] > 5)
    pool = [u for u in chartable if u["cusip"] in proxy_ctx and u is not fp_instr]
    rng.shuffle(pool)
    pool = pool[:N_POSITIONS - 2]

    positions = []
    families = ["dealer-quote", "proxy-curve", "matrix"]
    for i, u in enumerate(pool):
        pid = f"POS-{i + 1:03d}"
        did = TRADING_DESKS[i % len(TRADING_DESKS)][0]
        opened = date(2019, 1, 1) + timedelta(days=rng.randint(0, 700))
        fam = rng.choices(families, weights=[5, 3, 2])[0]
        positions.append({"id": pid, "cusip": u["cusip"], "desk": did, "opened": opened,
                          "family": fam, "compliance": desk_compliance[did], "u": u})
    positions.append({"id": "POS-FP", "cusip": fp_instr["cusip"], "desk": "DESK-05",
                      "opened": date(2020, 6, 15), "family": "proxy-curve",
                      "compliance": 1.0, "u": fp_instr, "scripted": True})
    return positions


def emit_position(layer: str, p: dict):
    pid = p["id"]
    iid = f"INSTR-{p['cusip']}"
    owner = persons_by_desk[p["desk"]][0]
    vm = f"VM-{pid}"
    G.node(layer, "ValuationMethodology", vm, name=f"{p['family']} valuation",
           family=p["family"], validFrom=dt(p["opened"]))
    G.node(layer, "Position", pid, name=f"{pid} · {p['u']['sector']} {p['cusip']}",
           openedAt=dt(p["opened"]), validFrom=dt(p["opened"]),
           notionalUsdM=round(rng.uniform(5, 120), 1), synthetic=False)
    G.rel(layer, "OF_INSTRUMENT", pid, iid)
    G.rel(layer, "ON_DESK", pid, p["desk"])
    G.rel(layer, "OWNED_BY", pid, owner)
    G.rel(layer, "VALUED_BY", pid, vm)
    for atype, val in [("methodologyFamily", p["family"]), ("deskId", p["desk"])]:
        G.rel(layer, "HAS_RISK_ATTRIBUTE", pid, risk_attribute(atype, val))
        if atype == "methodologyFamily":
            G.rel(layer, "HAS_RISK_ATTRIBUTE", vm, risk_attribute(atype, val))
    # position inherits the instrument-level attributes for read-across
    for r in list(G.rels):
        if r["type"] == "HAS_RISK_ATTRIBUTE" and r["from"] == iid:
            G.rel(layer, "HAS_RISK_ATTRIBUTE", pid, r["to"])
    return owner


def simulate_position(p: dict, monthly_divergence: dict[str, list[tuple[date, int]]]):
    """Generate trigger events + compliant responses for one synthetic position."""
    pid, comp, desk = p["id"], p["compliance"], p["desk"]
    owner = emit_position("governance", p)
    desk_head = persons_by_desk[desk][2]
    ipv_team = function_people["DESK-IPV"]
    pc_team = function_people["DESK-PC"]
    map_team = function_people["DESK-MAP"]

    divs = dict((d.isoformat()[:7], b) for d, b in monthly_divergence.get(p["cusip"], []))
    override_dates: list[date] = []
    r5_threshold = obligations["R5"]["params"]["divergenceBps"]
    r3_threshold = obligations["R3"]["params"]["thresholdBps"]
    r4_n, r4_window = obligations["R4"]["params"]["n"], obligations["R4"]["params"]["windowDays"]
    prev_div = 0

    for me in month_ends(max(GOV_START, p["opened"]), GOV_END):
        ym = me.isoformat()[:7]
        div = divs.get(ym, prev_div)

        # monthly IPV review (the IPV cycle itself is an obligation-driven control)
        ipv = eid("IPV")
        G.event("governance", "IPVReview", ipv, pid, dt(me, 16),
                divergenceBps=abs(div), outcome="within tolerance" if abs(div) <= r5_threshold else "exception")
        G.rel("governance", "REVIEWED_BY", pid, ipv)
        G.rel("governance", "PERFORMED_BY", ipv, rng.choice(ipv_team))
        if abs(div) > r5_threshold and rng.random() < comp:
            add_escalation("governance", pid, ipv, me + timedelta(days=rng.randint(2, 8)))
            add_evidence("governance", pid, ipv, me + timedelta(days=rng.randint(2, 8)), "adjustment")

        # unexplained P&L signal from real divergence moves
        move = abs(div - prev_div)
        if move > 120 and rng.random() < 0.6:
            s = eid("PNL")
            unexplained = round(min(move / 100 / 40, 0.08), 3)
            G.event("governance", "PnLSignal", s, pid, dt(me, 18),
                    unexplainedPct=unexplained, consecutiveDays=rng.randint(3, 9))
            G.rel("governance", "GENERATED_SIGNAL", pid, s)
            if rng.random() < comp:
                c = eid("CTL")
                G.event("governance", "Control", c, pid, dt(me + timedelta(days=rng.randint(1, 4)), 10),
                        kind="attribution", outcome="explained")
                G.rel("governance", "SUBJECT_TO_CONTROL", pid, c)
                if rng.random() < comp:
                    add_escalation("governance", pid, s, me + timedelta(days=rng.randint(1, 4)))
        prev_div = div

        # price overrides — clustered in the 2022 vol regime for dealer-quoted books
        p_override = 0.04
        if date(2022, 3, 1) <= me <= date(2022, 11, 30) and p["family"] == "dealer-quote":
            p_override = 0.14
        if rng.random() < p_override:
            od = me - timedelta(days=rng.randint(0, 20))
            po = eid("OVR")
            dev = round(rng.lognormvariate(3.1, 0.6))
            G.event("governance", "PriceOverride", po, pid, dt(od, 15),
                    deviationBps=dev, side="favourable" if rng.random() < 0.7 else "conservative",
                    pctOfBidAsk=round(min(dev / 2, 95)))
            G.rel("governance", "OVERRIDDEN_BY", pid, po)
            G.rel("governance", "PERFORMED_BY", po, owner)
            override_dates.append(od)
            if dev > r3_threshold and rng.random() < comp:
                add_approval("governance", pid, po, od + timedelta(days=rng.randint(1, 4)),
                             independent_approver(desk), evidenced=rng.random() < comp)
                ch = eid("IPV")
                G.event("governance", "IPVReview", ch, pid, dt(od + timedelta(days=rng.randint(1, 4)), 11),
                        divergenceBps=min(dev, r5_threshold - 5), outcome="challenge")
                G.rel("governance", "REVIEWED_BY", pid, ch)
                G.rel("governance", "CHALLENGED_BY", po, ch)
            elif dev > r3_threshold and rng.random() < 0.5:
                # sloppy path that also trips R8: desk head approves his own desk
                add_approval("governance", pid, po, od + timedelta(days=rng.randint(1, 6)),
                             desk_head, evidenced=rng.random() < comp)
            recent = [d for d in override_dates if (od - d).days <= r4_window]
            if len(recent) >= r4_n and rng.random() < comp:
                esc = add_escalation("governance", pid, po, od + timedelta(days=rng.randint(2, 8)))
                m = eid("MAP")
                G.event("governance", "MAPReview", m, pid, dt(od + timedelta(days=rng.randint(10, 25)), 10),
                        outcome="reviewed")
                G.rel("governance", "REVIEWED_BY", pid, m)
                G.rel("governance", "PERFORMED_BY", m, rng.choice(map_team))
                add_evidence("governance", pid, m, od + timedelta(days=rng.randint(10, 25)))

        # occasional methodology change
        if rng.random() < 0.008:
            mc = eid("MCH")
            eff = me + timedelta(days=5)
            G.event("governance", "MethodologyChange", mc, pid, dt(me),
                    kind="parameter recalibration", formal=True, effectiveAt=dt(eff))
            G.rel("governance", "CHANGED_TO", pid, mc)
            if rng.random() < comp:
                add_approval("governance", pid, mc, me - timedelta(days=rng.randint(1, 5)),
                             independent_approver(desk), committee="COM-VAL",
                             evidenced=rng.random() < comp)
            if rng.random() < comp:
                ipv2 = eid("IPV")
                G.event("governance", "IPVReview", ipv2, pid, dt(eff + timedelta(days=rng.randint(5, 20)), 11),
                        divergenceBps=rng.randint(3, 30), outcome="post-change validation")
                G.rel("governance", "REVIEWED_BY", pid, ipv2)

    # annual MAP review of illiquids (+ post-regime-break review)
    yr = p["opened"]
    while yr < GOV_END:
        yr = yr + timedelta(days=350 + rng.randint(0, 20))
        if yr > GOV_END:
            break
        if rng.random() < comp:
            m = eid("MAP")
            G.event("governance", "MAPReview", m, pid, dt(yr, 10), outcome="periodic review")
            G.rel("governance", "REVIEWED_BY", pid, m)
            G.rel("governance", "PERFORMED_BY", m, rng.choice(map_team))
            add_evidence("governance", pid, m, yr)
    if rng.random() < comp:
        rd = REGIME_BREAK_AT + timedelta(days=rng.randint(15, 55))
        m = eid("MAP")
        G.event("governance", "MAPReview", m, pid, dt(rd, 10), outcome="regime-break review")
        G.rel("governance", "REVIEWED_BY", pid, m)
        add_evidence("governance", pid, m, rd)


# ═══════════════════════ LAYER 3 — the two cases ════════════════════════════

def tp_date(authentic: date) -> str:
    return dt(shift_years(authentic, TP_CLOCK_OFFSET_YEARS))


# deterministic day for month-precision rows, order-preserving (DATA_PLAN §3.1)
TP_MONTH_DAYS = {
    "MP-2011Q4": date(2011, 12, 15), "MC-MARK-2012": date(2012, 1, 30),
    "PNL-FEB": date(2012, 2, 21), "IPV-COLLATERAL": date(2012, 4, 25),
    "CA-METHOD": date(2012, 5, 24),
}


def tp_event(layer: str, label: str, nid: str, authentic: date, row: dict | None = None, **props):
    """Case event: shifted `at`, authentic `sourceAt` (DECISIONS.md #3)."""
    src = dict(sourceRef=row["source"], confidence=row["confidence"],
               description=row["description"], datePrecision=row["date_precision"],
               seq=int(row["seq"]), actorRole=row["actor_role"],
               amountUsdM=float(row["amount_usd_m"]) if row["amount_usd_m"] else None) if row else {}
    return G.event(layer, label, nid, "POS-TP", tp_date(authentic),
                   sourceAt=dt(authentic), **src, **props)


def build_tp_case():
    rows = {}
    with open(ROOT / "inputs" / "public_true_positive_2012.csv") as f:
        for row in csv.DictReader(f):
            rows[row["event_id"]] = row

    def d(event_id: str) -> date:
        if rows[event_id]["date_precision"] == "day":
            return date.fromisoformat(rows[event_id]["date"])
        return TP_MONTH_DAYS[event_id]

    # cast — roles only, never names (inputs/README.md)
    cast = {
        "TP-TRADER-A": ("Senior trader", "DESK-CIO"), "TP-TRADER-B": ("Junior trader", "DESK-CIO"),
        "TP-DESKHEAD": ("Desk head", "DESK-CIO"), "TP-CIO-HEAD": ("CIO head", "DESK-CIO"),
        "TP-MODEL-OWNER": ("Risk / model owner", "DESK-RISK"), "TP-VCG": ("VCG (IPV) analyst", "DESK-IPV"),
        "TP-DEP-CRO": ("Deputy CRO", "DESK-RISK"), "TP-CONTROLLER": ("Controller", "DESK-PC"),
    }
    for pid, (role, desk) in cast.items():
        G.node("cases", "Person", pid, name=role, role=role)
        G.rel("cases", "ON_DESK", pid, desk)

    iid = "INSTR-TP"
    G.node("cases", "Instrument", iid, cusip="SYNTH-TP",
           name="Structured credit book A (synthetic twin)", is144a=False,
           pctDaysTraded=0.02, bidAskPct=2.4, maturityYears=12.0, sector="Financials",
           liquiditySource="synthetic (shape of the public case)", synthetic=True)
    for atype, val, prov in [("issuerSector", "Financials", None), ("maturityBucket", "10Y+", None),
                             ("liquidityTier", "illiquid", "synthetic (dealer-quoted, wide bid-ask)")]:
        G.rel("cases", "HAS_RISK_ATTRIBUTE", iid, risk_attribute(atype, val, prov))

    pos = "POS-TP"
    opened = date(2007, 1, 15)
    transfer = d("CA-TRANSFER")
    G.node("cases", "Position", pos, name="POS-TP · Structured Credit Book A",
           openedAt=tp_date(opened), validFrom=tp_date(opened), validTo=tp_date(transfer),
           notionalUsdM=51000.0, synthetic=True)
    G.rel("cases", "OF_INSTRUMENT", pos, iid)
    G.rel("cases", "ON_DESK", pos, "DESK-CIO")
    G.rel("cases", "OWNED_BY", pos, "TP-TRADER-A")
    for atype, val in [("issuerSector", "Financials"), ("maturityBucket", "10Y+"),
                       ("liquidityTier", "illiquid"), ("methodologyFamily", "dealer-quote"),
                       ("deskId", "DESK-CIO")]:
        G.rel("cases", "HAS_RISK_ATTRIBUTE", pos, risk_attribute(atype, val))

    vm = "VM-TP"
    G.node("cases", "ValuationMethodology", vm, name="Dealer midpoint", family="dealer-quote",
           validFrom=tp_date(opened))
    G.rel("cases", "VALUED_BY", pos, vm)
    G.rel("cases", "HAS_RISK_ATTRIBUTE", vm, risk_attribute("methodologyFamily", "dealer-quote"))

    # R7 anchor — encoder-added, NOT a CSV row (user amendment (a))
    anchor_at = date(2011, 8, 20)
    m = tp_event("cases", "MAPReview", "MAP-TP-2011Q3", anchor_at, None, outcome="no finding")
    G.rel("cases", "REVIEWED_BY", pos, m)
    add_evidence("cases", pos, m, shift_years(anchor_at, TP_CLOCK_OFFSET_YEARS))

    # seq 1 — baseline marks at dealer midpoints
    r = rows["MP-2011Q4"]
    mp = tp_event("cases", "MarketPrice", "MP-2011Q4", d("MP-2011Q4"), r, clean=100.0,
                  source="dealer midpoint")
    G.rel("cases", "COMPARED_WITH", mp, pos)
    G.rel("cases", "PRICE_OF", mp, iid)

    # synthetic monthly mark-vs-midpoint series for the Explore chart (drift Jan→May)
    for i, me in enumerate(month_ends(date(2011, 12, 1), date(2012, 7, 31))):
        drift = [0, 0, 40, 130, 300, 480, 600, 80, 20][min(i, 8)]
        mark_id, mid_id = f"MP-TP-MARK-{me}", f"MP-TP-MID-{me}"
        G.event("cases", "MarketPrice", mark_id, pos, tp_date(me), sourceAt=dt(me),
                clean=round(100 - i * 0.6, 2), source="trader mark")
        G.event("cases", "MarketPrice", mid_id, pos, tp_date(me), sourceAt=dt(me),
                clean=round(100 - i * 0.6 - drift / 100, 2), source="dealer midpoint")
        G.rel("cases", "PRICE_OF", mark_id, iid)
        G.rel("cases", "PRICE_OF", mid_id, iid)
        G.rel("cases", "COMPARED_WITH", mark_id, mid_id, divergenceBps=drift)

    # seq 2 — VaR model change: approved late by risk model owner, NOT evidenced -> R1 (LATE), R9
    r = rows["MC-VAR-2012"]
    mc1 = tp_event("cases", "MethodologyChange", "MC-VAR-2012", d("MC-VAR-2012"), r,
                   kind="risk model", formal=True, effectiveAt=tp_date(d("MC-VAR-2012")))
    G.rel("cases", "CHANGED_TO", pos, mc1)
    a1 = eid("APR")
    a1_at = d("MC-VAR-2012") + timedelta(days=3)
    G.event("cases", "Approval", a1, pos, tp_date(a1_at), sourceAt=dt(a1_at))
    G.rel("cases", "APPROVED_BY", mc1, a1)
    G.rel("cases", "APPROVED_BY", a1, "TP-MODEL-OWNER")  # different function — R8 clean here

    # seq 3 — informal marking-practice change: no approval at all -> R1 (MISSED), R2
    r = rows["MC-MARK-2012"]
    mc2 = tp_event("cases", "MethodologyChange", "MC-MARK-2012", d("MC-MARK-2012"), r,
                   kind="marking practice", formal=False, effectiveAt=tp_date(d("MC-MARK-2012")))
    G.rel("cases", "CHANGED_TO", pos, mc2)

    # seq 4 — Q1 losses, limits breached and raised -> R6 (with seq 6 feeding R4)
    r = rows["PNL-FEB"]
    s1 = tp_event("cases", "PnLSignal", "PNL-FEB", d("PNL-FEB"), r,
                  unexplainedPct=0.06, consecutiveDays=12, reportedUsdM=-169.0)
    G.rel("cases", "GENERATED_SIGNAL", pos, s1)
    c1 = eid("CTL")
    G.event("cases", "Control", c1, pos, tp_date(d("PNL-FEB")), sourceAt=dt(d("PNL-FEB")),
            kind="risk limit", breached=True, outcome="limit raised instead of escalation")
    G.rel("cases", "SUBJECT_TO_CONTROL", pos, c1)

    # seq 6 — weekly override series, approved by the SAME-DESK desk head -> R3, R4, R8, R9
    r = rows["PO-DAILY-SERIES"]
    series_start = date(2012, 1, 6)
    overrides = []
    for w in range(12):
        od = series_start + timedelta(days=7 * w)
        if od > date(2012, 3, 23):
            break
        po = f"PO-TP-{w + 1:02d}"
        dev = 30 + w * 10
        tp_event("cases", "PriceOverride", po, od, r, deviationBps=dev, side="favourable",
                 pctOfBidAsk=min(30 + w * 6, 95))
        G.rel("cases", "OVERRIDDEN_BY", pos, po)
        G.rel("cases", "PERFORMED_BY", po, "TP-TRADER-A")
        a = eid("APR")
        G.event("cases", "Approval", a, pos, tp_date(od), sourceAt=dt(od))
        G.rel("cases", "APPROVED_BY", po, a)
        G.rel("cases", "APPROVED_BY", a, "TP-DESKHEAD")  # same desk as POS-TP -> R8
        overrides.append(po)

    # seq 5 — the spreadsheet: evidence exists, is not escalated -> feeds R5/R9 story
    r = rows["EV-SPREADSHEET"]
    ev5 = tp_event("cases", "Evidence", "EV-SPREADSHEET", d("EV-SPREADSHEET"), r,
                   type="spreadsheet")
    G.rel("cases", "EVIDENCED_BY", overrides[9], ev5)  # the mid-March override

    # seq 7 — 600m-vs-12m estimate + trading halt -> R6
    r = rows["PNL-0323"]
    s2 = tp_event("cases", "PnLSignal", "PNL-0323", d("PNL-0323"), r,
                  unexplainedPct=0.10, consecutiveDays=15, reportedUsdM=-12.0, estimatedMidUsdM=-600.0)
    G.rel("cases", "GENERATED_SIGNAL", pos, s2)
    c2 = eid("CTL")
    G.event("cases", "Control", c2, pos, tp_date(d("PNL-0323")), sourceAt=dt(d("PNL-0323")),
            kind="trading halt", outcome="orders to stop trading")
    G.rel("cases", "SUBJECT_TO_CONTROL", pos, c2)

    # seq 8 — quarter-end VCG review upholds the marks -> R5 (and R2 is LATE by now)
    r = rows["IPV-Q1"]
    ipv1 = tp_event("cases", "IPVReview", "IPV-Q1", d("IPV-Q1"), r,
                    divergenceBps=600, divergenceUsdM=512.0, outcome="within tolerance")
    G.rel("cases", "REVIEWED_BY", pos, ipv1)
    G.rel("cases", "PERFORMED_BY", ipv1, "TP-VCG")

    # seq 9 — external/media escalation (reactive), evidenced by press coverage
    r = rows["ESC-MEDIA"]
    esc = tp_event("cases", "Escalation", "ESC-MEDIA", d("ESC-MEDIA"), r, origin="external/media")
    G.rel("cases", "ESCALATED_TO", pos, esc)
    evp = eid("EV")
    G.event("cases", "Evidence", evp, pos, tp_date(d("ESC-MEDIA")), sourceAt=dt(d("ESC-MEDIA")), type="press")
    G.rel("cases", "EVIDENCED_BY", esc, evp)

    # seq 10 — -6m then -400m the same day -> R6, R3 colour
    r = rows["PNL-0410"]
    sa = tp_event("cases", "PnLSignal", "PNL-0410", d("PNL-0410"), r,
                  unexplainedPct=0.02, consecutiveDays=1, reportedUsdM=-6.0)
    sb = f"PNL-0410-REISSUE"
    G.event("cases", "PnLSignal", sb, pos, tp_date(d("PNL-0410")), sourceAt=dt(d("PNL-0410")),
            unexplainedPct=0.12, consecutiveDays=6, reportedUsdM=-400.0)
    G.rel("cases", "GENERATED_SIGNAL", pos, sa)
    G.rel("cases", "GENERATED_SIGNAL", pos, sb)
    G.rel("cases", "CHALLENGED_BY", sa, sb)

    # seq 11 — public minimising statement (chronology marker)
    r = rows["EV-PUBLIC-0413"]
    tp_event("cases", "Evidence", "EV-PUBLIC-0413", d("EV-PUBLIC-0413"), r, type="public statement")

    # seq 12 — counterparty collateral disputes -> R5
    r = rows["IPV-COLLATERAL"]
    ipv2 = tp_event("cases", "IPVReview", "IPV-COLLATERAL", d("IPV-COLLATERAL"), r,
                    divergenceBps=800, divergenceUsdM=690.0,
                    outcome="counterparty collateral dispute")
    G.rel("cases", "REVIEWED_BY", pos, ipv2)

    # seq 13 — the incident + controller special review
    r = rows["INC-SCP"]
    inc = tp_event("cases", "Incident", "INC-TP", d("INC-SCP"), r, lossUsdM=2000.0,
                   confirmed=True)
    G.rel("cases", "CAUSED_BY", inc, pos)
    c3 = eid("CTL")
    G.event("cases", "Control", c3, pos, tp_date(d("INC-SCP")), sourceAt=dt(d("INC-SCP")),
            kind="controller special review", outcome="consistent with industry practice")
    G.rel("cases", "REVIEWED_BY", inc, c3)
    G.rel("cases", "PERFORMED_BY", c3, "TP-CONTROLLER")

    # seq 14 — corrective methodology change (properly approved + evidenced)
    r = rows["CA-METHOD"]
    ca1 = tp_event("cases", "CorrectiveAction", "CA-METHOD", d("CA-METHOD"), r,
                   type="marking methodology alignment")
    G.rel("cases", "MITIGATED_BY", inc, ca1)
    mc3 = f"MC-IPS-2012"
    G.event("cases", "MethodologyChange", mc3, pos, tp_date(d("CA-METHOD")), sourceAt=dt(d("CA-METHOD")),
            kind="independent pricing service midpoint", formal=True,
            effectiveAt=tp_date(d("CA-METHOD")))
    G.rel("cases", "CHANGED_TO", pos, mc3)
    add_approval("cases", pos, mc3, shift_years(d("CA-METHOD") - timedelta(days=2), TP_CLOCK_OFFSET_YEARS),
                 "TP-DEP-CRO", committee="COM-VAL")
    ipv3 = eid("IPV")
    ipv3_at = d("CA-METHOD") + timedelta(days=12)
    G.event("cases", "IPVReview", ipv3, pos, tp_date(ipv3_at), sourceAt=dt(ipv3_at),
            divergenceBps=20, outcome="post-change validation")
    G.rel("cases", "REVIEWED_BY", pos, ipv3)

    # seq 15 — transfer to the investment bank; position closes (validTo set above)
    r = rows["CA-TRANSFER"]
    ca2 = tp_event("cases", "CorrectiveAction", "CA-TRANSFER", d("CA-TRANSFER"), r,
                   type="portfolio transfer")
    G.rel("cases", "MITIGATED_BY", inc, ca2)
    G.node("cases", "Desk", "DESK-IB", name="Investment Bank Credit")
    G.rel("cases", "OWNED_BY", pos, "DESK-IB", **{"from": tp_date(d("CA-TRANSFER"))})

    # seq 16 — root causes ×3 + restatement
    r = rows["RC-REVIEW"]
    for k, kind in enumerate(["ineffective governance", "insufficiently granular limits",
                              "inadequate model approval"]):
        rc = f"RC-TP-{k + 1}"
        tp_event("cases", "RootCause", rc, d("RC-REVIEW"), r, kind=kind)
        G.rel("cases", "CAUSED_BY", inc, rc)

    # seq 17 — task force report + regulator order
    r = rows["CA-TASKFORCE"]
    ca3 = tp_event("cases", "CorrectiveAction", "CA-TASKFORCE", d("CA-TASKFORCE"), r,
                   type="task force report")
    G.rel("cases", "MITIGATED_BY", inc, ca3)
    add_evidence("cases", pos, ca3, shift_years(d("CA-TASKFORCE"), TP_CLOCK_OFFSET_YEARS), "public report")

    # seq 18 / 19 — public report + enforcement action evidence the incident
    for eidx, key, etype in [(18, "EV-PSI", "public report"), (19, "EV-SEC", "enforcement action")]:
        r = rows[key]
        ev = tp_event("cases", "Evidence", key, d(key), r, type=etype)
        G.rel("cases", "EVIDENCED_BY", inc, ev)


def build_fp_case(proxy_ctx: dict, fp: dict):
    """Deliberate false positive — breaks exactly R2, R4, R6 (DATA_PLAN §3.3)."""
    pid = "POS-FP"
    owner = emit_position("cases", fp)
    G.nodes[pid]["props"]["name"] = "POS-FP · EM Rates illiquid bond"
    ipv_team = function_people["DESK-IPV"]

    # monthly IPV cycle — suppressed between the Oct 20 change and the LATE Dec 5 review
    for me in month_ends(fp["opened"], GOV_END):
        if date(2022, 9, 20) <= me <= date(2022, 12, 4):
            continue
        ipv = eid("IPV")
        G.event("cases", "IPVReview", ipv, pid, dt(me, 16), divergenceBps=rng.randint(4, 38),
                outcome="within tolerance")
        G.rel("cases", "REVIEWED_BY", pid, ipv)
        G.rel("cases", "PERFORMED_BY", ipv, rng.choice(ipv_team))

    # pre-change IPV exceptions during the shock — RESOLVED in time (R5 MET), they
    # motivate the methodology change
    for i, (day, divv) in enumerate([(date(2022, 9, 26), 72), (date(2022, 10, 10), 85)]):
        ipv = f"IPV-FP-EXC-{i + 1}"
        G.event("cases", "IPVReview", ipv, pid, dt(day, 16), divergenceBps=divv, outcome="exception")
        G.rel("cases", "REVIEWED_BY", pid, ipv)
        add_escalation("cases", pid, ipv, day + timedelta(days=4))
        add_evidence("cases", pid, ipv, day + timedelta(days=5), "adjustment")

    # the methodology change — governance WORKED: pre-approved, evidenced, independent
    eff = date(2022, 10, 20)
    mc = "MC-FP-2022"
    G.event("cases", "MethodologyChange", mc, pid, dt(date(2022, 10, 15)),
            kind="proxy-curve recalibration after the 2022 rate shock", formal=True,
            effectiveAt=dt(eff))
    G.rel("cases", "CHANGED_TO", pid, mc)
    add_approval("cases", pid, mc, date(2022, 10, 12), independent_approver(fp["desk"]),
                 committee="COM-VAL")  # R1 MET, R8 clean, R9 evidenced

    # R2 broken: post-change IPV done, but 46 days after effectiveAt (SLA 30)
    ipv_late = "IPV-FP-LATE"
    G.event("cases", "IPVReview", ipv_late, pid, dt(date(2022, 12, 5), 11),
            divergenceBps=40, outcome="post-change validation (late — Q4 backlog)")
    G.rel("cases", "REVIEWED_BY", pid, ipv_late)

    # R4 broken: 3 small overrides in 90 days, each approved + challenged (R3 clean),
    # but never escalated
    # all three predate the change's effectiveAt (Oct 20) so their IPV challenges
    # cannot accidentally satisfy R2's post-change window
    for i, day in enumerate([date(2022, 9, 20), date(2022, 10, 5), date(2022, 10, 12)]):
        po = f"PO-FP-{i + 1}"
        G.event("cases", "PriceOverride", po, pid, dt(day, 15),
                deviationBps=15 + i * 3, side="conservative", pctOfBidAsk=20 + i * 5)
        G.rel("cases", "OVERRIDDEN_BY", pid, po)
        G.rel("cases", "PERFORMED_BY", po, owner)
        add_approval("cases", pid, po, day + timedelta(days=1), independent_approver(fp["desk"]))
        ch = eid("IPV")
        G.event("cases", "IPVReview", ch, pid, dt(day + timedelta(days=2), 11),
                divergenceBps=18, outcome="challenge")
        G.rel("cases", "REVIEWED_BY", pid, ch)
        G.rel("cases", "CHALLENGED_BY", po, ch)

    # R6 broken: persistent unexplained P&L at the shock, attribution done on day 8 (SLA 5)
    s = "PNL-FP-SHOCK"
    G.event("cases", "PnLSignal", s, pid, dt(date(2022, 9, 30), 18),
            unexplainedPct=0.024, consecutiveDays=6)
    G.rel("cases", "GENERATED_SIGNAL", pid, s)
    c = "CTL-FP-ATTR"
    G.event("cases", "Control", c, pid, dt(date(2022, 10, 8), 10), kind="attribution",
            outcome="explained — curve recalibration effect")
    G.rel("cases", "SUBJECT_TO_CONTROL", pid, c)

    # R7 MET: MAP review within 60 days of the regime break (and within the period)
    m = "MAP-FP-REGIME"
    G.event("cases", "MAPReview", m, pid, dt(date(2022, 11, 15), 10), outcome="regime-break review")
    G.rel("cases", "REVIEWED_BY", pid, m)
    add_evidence("cases", pid, m, date(2022, 11, 15))


# ═════════════════════════ chains, holdout, emit ════════════════════════════

# events that carry the three prices at event time (batch-2 SME review): the
# marker popover of the PositionTimeline is filled FROM THE GRAPH, never
# recomputed client-side
PRICE_EVENT_LABELS = {"MethodologyChange", "PriceOverride", "IPVReview",
                      "Approval", "Escalation", "MAPReview"}


def annotate_event_prices():
    """Write traderMark / modelPrice / ipvPrice (nullable) at event time on the
    six marker event types, for synthetic positions AND the encoded cases, from
    the price series already emitted: observed TRACE prints / trader marks are
    the mark; proxy-model / dealer-midpoint points are the model price."""
    price_of = {r["from"]: r["to"] for r in G.rels if r["type"] == "PRICE_OF"}
    obs: dict[str, list[tuple[str, float]]] = {}
    model: dict[str, list[tuple[str, float]]] = {}
    for nid, n in G.nodes.items():
        if "MarketPrice" not in n["labels"]:
            continue
        clean, src, iid = n["props"].get("clean"), n["props"].get("source"), price_of.get(nid)
        if clean is None or iid is None:
            continue
        d0 = n["props"]["at"][:10]
        if src in ("TRACE", "trader mark"):
            obs.setdefault(iid, []).append((d0, clean))
        elif src in ("proxy-model", "dealer midpoint"):
            model.setdefault(iid, []).append((d0, clean))
    for s in list(obs.values()) + list(model.values()):
        s.sort()
    pos_instr = {r["from"]: r["to"] for r in G.rels
                 if r["type"] == "OF_INSTRUMENT" and r["from"].startswith("POS-")}

    def at_or_before(series: list[tuple[str, float]] | None, d0: str) -> float | None:
        if not series:
            return None
        i = bisect_right(series, (d0, float("inf"))) - 1
        return series[max(i, 0)][1]

    annotated = 0
    for n in G.nodes.values():
        label, p = n["labels"][0], n["props"]
        pid = p.get("positionId")
        if label not in PRICE_EVENT_LABELS or not pid:
            continue
        iid = pos_instr.get(pid)
        if not iid:
            continue
        d0 = str(p["at"])[:10]
        mark = at_or_before(obs.get(iid), d0)
        mdl = at_or_before(model.get(iid), d0)
        if mark is None:
            mark = mdl
        if label == "PriceOverride" and isinstance(p.get("deviationBps"), (int, float)) and mark is not None:
            sign = 1 if p.get("side") == "favourable" else -1
            mark = mark * (1 + sign * p["deviationBps"] / 10000)
        if mark is not None:
            p["traderMark"] = round(mark, 3)
        if mdl is not None:
            p["modelPrice"] = round(mdl, 3)
        if (label == "IPVReview" and mark is not None
                and isinstance(p.get("divergenceBps"), (int, float))):
            p["ipvPrice"] = round(mark * (1 - p["divergenceBps"] / 10000), 3)
        annotated += 1
    print(f"  event prices annotated on {annotated:,} events")


def build_next_chains():
    """Per-position chronological :NEXT chain over all its events
    (fraud-event-sequence model, timeDelta in days)."""
    by_pos: dict[str, list[tuple[str, str]]] = {}
    for nid, n in G.nodes.items():
        if "Event" in n["labels"] and n["props"].get("positionId"):
            by_pos.setdefault(n["props"]["positionId"], []).append((n["props"]["at"], nid))
    for pos, events in by_pos.items():
        events.sort()
        layer = G.nodes[events[0][1]]["layer"]
        for (at1, a), (at2, b) in zip(events, events[1:]):
            delta = (datetime.fromisoformat(at2) - datetime.fromisoformat(at1)).days
            G.rel(layer, "NEXT", a, b, timeDelta=delta)


def remove_holdout() -> list[dict]:
    """Remove a few known Position->RiskAttribute links (never on POS-TP/POS-FP,
    never liquidityTier) and record them as S4 link-prediction ground truth."""
    candidates = [r for r in G.rels
                  if r["type"] == "HAS_RISK_ATTRIBUTE"
                  and r["from"].startswith("POS-") and r["from"] not in ("POS-TP", "POS-FP")
                  and "liquidityTier" not in r["to"]]
    rng.shuffle(candidates)
    held = candidates[:6]
    for r in held:
        G.rels.remove(r)
    holdout = [{"from": r["from"], "to": r["to"], "type": r["type"]} for r in held]
    (ROOT / "data" / "holdout_links.json").write_text(json.dumps(holdout, indent=2))
    return holdout


def cypher_value(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    s = str(v).replace("\\", "\\\\").replace("'", "\\'")
    if isinstance(v, str) and len(v) == 19 and v[10] == "T":
        return f"datetime('{v}')"
    return f"'{s}'"


def emit_outputs(holdout: list[dict]):
    LAYERS.mkdir(parents=True, exist_ok=True)
    layers = {"market": {"nodes": {}, "rels": {}}, "governance": {"nodes": {}, "rels": {}},
              "cases": {"nodes": {}, "rels": {}}}
    for nid, n in G.nodes.items():
        key = ":".join(n["labels"])
        layers[n["layer"]]["nodes"].setdefault(key, []).append(n["props"])
    for r in G.rels:
        fl = G.nodes[r["from"]]["labels"][0]
        tl = G.nodes[r["to"]]["labels"][0]
        key = f"{r['type']}|{fl}|{tl}"
        layers[r["layer"]]["rels"].setdefault(key, []).append(
            {"from": r["from"], "to": r["to"], **r["props"]})

    for name, payload in layers.items():
        (LAYERS / f"{name}.json").write_text(json.dumps(payload))
    if APP_DATA.exists():
        shutil.rmtree(APP_DATA)
    shutil.copytree(LAYERS, APP_DATA / "layers")
    shutil.copy(ROOT / "data" / "gap_query.cypher", APP_DATA / "gap_query.cypher")
    shutil.copy(ROOT / "data" / "holdout_links.json", APP_DATA / "holdout_links.json")

    # ── load_data.cypher (cypher-shell / MCP parity) ──
    out = ["// GENERATED by generate_data.py — do not edit. Replay with `make data`.",
           "MATCH (n) DETACH DELETE n;"]
    for label in ["Instrument", "Position", "Person", "Desk", "Committee", "Policy",
                  "ControlObligation", "RiskAttribute", "ValuationMethodology",
                  "GovernanceGap", "Pattern", "Curve", "Evidence", "Incident",
                  "RootCause", "CorrectiveAction"]:
        out.append(f"CREATE CONSTRAINT {label.lower()}_id IF NOT EXISTS FOR (n:{label}) REQUIRE n.id IS UNIQUE;")
    out.append("CREATE INDEX event_id IF NOT EXISTS FOR (n:Event) ON (n.id);")
    out.append("CREATE INDEX event_at IF NOT EXISTS FOR (n:Event) ON (n.at);")

    for name in ["market", "governance", "cases"]:
        out.append(f"// ══ layer: {name} ══")
        for key, nodes in layers[name]["nodes"].items():
            labels = key.replace(":", ":")
            for i in range(0, len(nodes), 500):
                batch = nodes[i:i + 500]
                rows = ",".join("{" + ",".join(f"`{k}`: {cypher_value(v)}" for k, v in p.items()) + "}"
                                for p in batch)
                out.append(f"UNWIND [{rows}] AS r CREATE (n:{labels}) SET n = r;")
        for key, rels in layers[name]["rels"].items():
            rtype, fl, tl = key.split("|")
            for i in range(0, len(rels), 500):
                batch = rels[i:i + 500]
                rows = ",".join(
                    "{from: " + cypher_value(p["from"]) + ", to: " + cypher_value(p["to"])
                    + ", props: {" + ",".join(f"`{k}`: {cypher_value(v)}" for k, v in p.items()
                                              if k not in ("from", "to")) + "}}"
                    for p in batch)
                out.append(
                    f"UNWIND [{rows}] AS r MATCH (a:{fl} {{id: r.from}}) MATCH (b:{tl} {{id: r.to}}) "
                    f"CREATE (a)-[rel:{rtype}]->(b) SET rel = r.props;")
    # node props stored as strings for datetimes -> convert
    out.append("MATCH (n) WHERE n.at IS NOT NULL AND valueType(n.at) STARTS WITH 'STRING' SET n.at = datetime(n.at);")
    for prop in ["sourceAt", "effectiveAt", "openedAt", "validFrom", "validTo"]:
        out.append(f"MATCH (n) WHERE n.{prop} IS NOT NULL AND valueType(n.{prop}) STARTS WITH 'STRING' SET n.{prop} = datetime(n.{prop});")

    # abstract gap classes for :Pattern REQUIRES targets (DATA_PLAN §S3)
    out.append("MATCH (o:ControlObligation) MERGE (g:GovernanceGap {id: 'GAPCLASS-' + o.id}) "
               "SET g.ruleId = o.id, g.abstract = true, g.name = 'Gap: ' + o.name "
               "MERGE (g)-[:OF_RULE]->(o);")

    # materialise concrete gaps with THE SAME gap query (DECISIONS.md #9)
    gap_query = (ROOT / "data" / "gap_query.cypher").read_text()
    wrapper = (
        ":param positionId => null;\n:param ruleId => null;\n"
        f":param asOf => datetime('{AS_OF}');\n"
        "MATCH (g:GovernanceGap {abstract: false}) DETACH DELETE g;\n"
        "CALL () {\n" + gap_query + "\n}\n"
        "WITH * WHERE status IN ['MISSED', 'LATE']\n"
        "MATCH (o:ControlObligation {id: ruleId})\n"
        "MATCH (p:Position {id: positionId})\n"
        "MERGE (g:GovernanceGap {id: 'GAP-' + ruleId + '-' + positionId + '-' + coalesce(triggerEventId, 'x')})\n"
        "SET g.abstract = false, g.ruleId = ruleId, g.positionId = positionId,\n"
        "    g.triggerEventId = triggerEventId, g.status = status, g.severity = severity,\n"
        "    g.dueBy = dueBy, g.computedAt = $asOf\n"
        "MERGE (g)-[:OF_RULE]->(o)\n"
        "MERGE (g)-[:ON_POSITION]->(p)\n"
        "WITH g, triggerEventId\n"
        "MATCH (gc:GovernanceGap {abstract: true, ruleId: g.ruleId}) MERGE (g)-[:INSTANCE_OF]->(gc)\n"
        "WITH g, triggerEventId\n"
        "OPTIONAL MATCH (t:Event {id: triggerEventId})\n"
        "FOREACH (tt IN CASE WHEN t IS NULL THEN [] ELSE [t] END | MERGE (g)-[:ON_TRIGGER]->(tt));")
    out.append(wrapper)

    (ROOT / "data" / "load_data.cypher").write_text("\n".join(out) + "\n")


def emit_template():
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.title = "Instructions"
    ws.append(["Second true-positive intake template — one tab per entity."])
    ws.append(["Rules:"])
    for line in [
        "1. Use ROLES in actor fields, never real names (they become Person nodes).",
        "2. date_precision: 'day' = exact; 'month' = we place it inside that month.",
        "3. rules_broken: semicolon-separated ControlObligation ids (R1..R9); the gap query must reproduce them — this is the acceptance test.",
        "4. The instrument tab describes the SHAPE (sector, maturity bucket, liquidity, methodology family); identity is never shown in the UI.",
        "5. Sources go to the audit drawer and bibliography only.",
    ]:
        ws.append([line])
    entities = {
        "Position": [("id", "string", "POS-CUST-1"), ("name", "string", "EM structured note book"),
                     ("openedAt", "date", "2018-03-01"), ("closedAt", "date (optional)", "")],
        "Instrument": [("sector", "string", "Financials"), ("maturityBucket", "<2Y|2-5Y|5-10Y|10Y+", "10Y+"),
                       ("liquidityTier", "liquid|illiquid", "illiquid"),
                       ("methodologyFamily", "dealer-quote|proxy-curve|matrix|model", "dealer-quote")],
        "Event": [("seq", "int", "1"), ("date", "date", "2019-05-14"), ("date_precision", "day|month", "day"),
                  ("event_label", "one of MethodologyChange, PriceOverride, IPVReview, PnLSignal, MAPReview, Approval, Escalation, Control, Evidence, Incident, CorrectiveAction, RootCause", "PriceOverride"),
                  ("event_id", "string", "PO-CUST-1"), ("description", "string", "…"),
                  ("actor_role", "role, not a name", "Desk head"), ("amount", "number (optional)", "12.5"),
                  ("graph_pattern", "Cypher-like hint (optional)", "(pos)-[:OVERRIDDEN_BY]->(po)"),
                  ("rules_broken", "R-ids ; separated", "R3;R4"), ("source", "string", "internal memo 2019-05-20")],
    }
    for name, fields in entities.items():
        s = wb.create_sheet(name)
        s.append(["field", "type / allowed values", "example"])
        for f in fields:
            s.append(list(f))
    tdir = ROOT / "templates"
    tdir.mkdir(exist_ok=True)
    wb.save(tdir / "customer_case_template.xlsx")


def main():
    print(f"TP_CLOCK_OFFSET_YEARS = {TP_CLOCK_OFFSET_YEARS}")
    load_obligations()
    print("Layer 1: market (OSBAP + FITRS + FRED) ...")
    chartable, proxy_ctx, emit_price_series = build_market_layer()
    print(f"  instruments: {sum(1 for n in G.nodes.values() if 'Instrument' in n['labels'])}, "
          f"chartable: {len(chartable)}")

    print("Layer 2: governance ...")
    build_governance_static()
    positions = build_positions(chartable, proxy_ctx)
    # held positions get the full daily TRACE series; the rest stay month-end
    emit_price_series({p["cusip"] for p in positions if p.get("cusip")})
    print(f"  market prices: {sum(1 for n in G.nodes.values() if 'MarketPrice' in n['labels']):,}")
    monthly_div: dict[str, list[tuple[date, int]]] = {}
    for r in G.rels:
        if r["type"] == "COMPARED_WITH" and "divergenceBps" in r["props"]:
            n = G.nodes[r["from"]]
            if "MarketPrice" in n["labels"] and n["props"].get("source") == "TRACE":
                cusip = r["from"].split("-", 1)[1].rsplit("-", 3)[0]
                d0 = date.fromisoformat(n["props"]["at"][:10])
                monthly_div.setdefault(cusip, []).append((d0, r["props"]["divergenceBps"]))
    for p in positions:
        if p.get("scripted"):
            continue
        simulate_position(p, monthly_div)

    print("Layer 3: cases ...")
    build_tp_case()
    fp = next(p for p in positions if p["id"] == "POS-FP")
    build_fp_case(proxy_ctx, fp)

    annotate_event_prices()
    build_next_chains()
    holdout = remove_holdout()
    emit_outputs(holdout)
    emit_template()
    n_nodes, n_rels = len(G.nodes), len(G.rels)
    print(f"Done: {n_nodes:,} nodes, {n_rels:,} relationships -> data/layers/, data/load_data.cypher")


if __name__ == "__main__":
    main()
