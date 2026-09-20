#!/usr/bin/env python3
"""Peer-decorrelation signals — the canonical computation.

Discovery panel 3: rolling correlation of a position's weekly trader marks with
the mean return of its attribute peers (positions sharing methodologyFamily +
liquidityTier). When it stays below `threshold` for `periods` consecutive
evaluated weeks, a :DecorrelationSignal event is created on the position, dated
at the FIRST breach — so it appears as a marker on the PositionTimeline and can
trigger the (Discovery-proposed) R10 obligation.

This module is the SOURCE OF TRUTH for the signal semantics:
tests/test_discovery.py runs it, and app/src/lib/discoveryQueries.ts mirrors
`compute_signals` 1:1 (keep them in sync, like the companion cache key).

Window default: 8 weekly returns (~40 trading days). The spec's 60-trading-day
default dilutes the FP's 5-week freeze below any sane threshold by construction;
40 days detects it. It is a placeholder parameter like every other threshold
(DECISIONS.md).
"""

from __future__ import annotations

import math
from datetime import date

WINDOW_WEEKS = 8
DECORR_THRESHOLD = 0.45
DECORR_PERIODS = 2
MIN_PEERS = 3


def pearson(xs: list[float], ys: list[float]) -> float | None:
    n = len(xs)
    if n < 2:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    if sxx <= 0 or syy <= 0:
        return 0.0  # a frozen (zero-variance) mark does not correlate with anything
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    return sxy / math.sqrt(sxx * syy)


def compute_signals(
    marks: dict[str, list[tuple[str, float]]],  # pid -> [(iso date, clean)] sorted
    groups: dict[str, str],  # pid -> peer-group key (methodologyFamily|liquidityTier)
    window: int = WINDOW_WEEKS,
    threshold: float = DECORR_THRESHOLD,
    periods: int = DECORR_PERIODS,
) -> list[dict]:
    """[{positionId, at (iso), correlation, peerGroup}] — one per position, dated
    at the first breach of the first qualifying run. Pure function, mirrored in TS."""
    # weekly log returns keyed by date
    returns: dict[str, dict[str, float]] = {}
    for pid, series in marks.items():
        r: dict[str, float] = {}
        for (d0, v0), (d1, v1) in zip(series, series[1:]):
            if v0 > 0 and v1 > 0:
                r[d1] = math.log(v1 / v0)
        returns[pid] = r

    # peer-mean return per (group, date), excluding self at use time via counts
    by_group: dict[str, list[str]] = {}
    for pid, g in groups.items():
        if pid in returns:
            by_group.setdefault(g, []).append(pid)
    group_sum: dict[str, dict[str, tuple[float, int]]] = {}
    for g, pids in by_group.items():
        acc: dict[str, tuple[float, int]] = {}
        for pid in pids:
            for d0, v in returns[pid].items():
                s, c = acc.get(d0, (0.0, 0))
                acc[d0] = (s + v, c + 1)
        group_sum[g] = acc

    signals: list[dict] = []
    for pid in sorted(returns):
        g = groups.get(pid)
        if g is None:
            continue
        acc = group_sum.get(g, {})
        own = returns[pid]
        dates = sorted(own)
        streak = 0
        first_breach: tuple[str, float] | None = None
        for i in range(window - 1, len(dates)):
            win = dates[i - window + 1 : i + 1]
            xs, ys = [], []
            for d0 in win:
                s, c = acc.get(d0, (0.0, 0))
                if c - 1 >= MIN_PEERS:  # peers excluding self
                    xs.append(own[d0])
                    ys.append((s - own[d0]) / (c - 1))
            if len(xs) < window:
                streak = 0
                first_breach = None
                continue
            corr = pearson(xs, ys)
            if corr is not None and corr < threshold:
                if streak == 0:
                    first_breach = (dates[i], corr)
                streak += 1
                if streak >= periods and first_breach:
                    signals.append({
                        "positionId": pid,
                        "at": first_breach[0],
                        "correlation": round(first_breach[1], 4),
                        "peerGroup": g,
                    })
                    break
            else:
                streak = 0
                first_breach = None
    return signals


# ── graph I/O (used by tests; the app mirrors these queries in TS) ────────────

FETCH_MARKS = """
MATCH (m:Mark) WHERE m.at <= $asOf
RETURN m.positionId AS pid, left(toString(m.at), 10) AS d, m.clean AS clean
ORDER BY pid, m.at
"""

FETCH_GROUPS = """
MATCH (p:Position)-[:HAS_RISK_ATTRIBUTE]->(ra:RiskAttribute)
WHERE ra.type IN ['methodologyFamily', 'liquidityTier']
WITH p, ra ORDER BY ra.type
RETURN p.id AS pid, reduce(s = '', v IN collect(ra.value) | s + '|' + v) AS grp
"""

WRITE_SIGNALS = """
UNWIND $signals AS s
MATCH (p:Position {id: s.positionId})
CREATE (ds:DecorrelationSignal:Event {id: 'DS-' + s.positionId})
SET ds.at = datetime(s.at + 'T17:00:00Z'), ds.positionId = s.positionId,
    ds.correlation = s.correlation, ds.peerGroup = s.peerGroup,
    ds.windowWeeks = $window, ds.threshold = $threshold
CREATE (p)-[:GENERATED_SIGNAL]->(ds)
"""

DELETE_SIGNALS = "MATCH (ds:DecorrelationSignal) DETACH DELETE ds"


def signals_from_db(session, as_of) -> list[dict]:
    marks: dict[str, list[tuple[str, float]]] = {}
    for r in session.run(FETCH_MARKS, asOf=as_of):
        marks.setdefault(r["pid"], []).append((r["d"], r["clean"]))
    groups = {r["pid"]: r["grp"] for r in session.run(FETCH_GROUPS)}
    return compute_signals(marks, groups)
