// PositionTimeline — the financial view of one position (batch-2 SME review):
// tradingview/lightweight-charts (pinned) with
//   · observed prices as candles (real OHLC when several trades printed that
//     day) or single ticks (o=h=l=c) — calendar gaps stay gaps (whitespace
//     series keeps the axis calendar-true, nothing is interpolated),
//   · the model (proxy-curve / dealer-midpoint) price as a continuous line —
//     the distance between line and candles IS the divergence,
//   · one marker per governance event (distinct shape/colour per type),
//   · dashed vertical lines at the computed due date of each MISSED/LATE control,
//   · a bottom pane with the cumulative broken-control score,
//   · a click popover per marker: date, role, the three graph-written prices,
//     divergence, rules concerned — never recomputed client-side.
// Everything comes from ONE audit-logged Cypher (lib/timelineQuery.ts).

import {
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openInExplore } from "../lib/exploreLink";
import { flashNodeRow, focusNodeInGraph } from "../lib/focus";
import {
  fetchPositionTimeline,
  type PositionTimelineData,
  type TlControl,
  type TlEvent,
} from "../lib/timelineQuery";
import "./timeline.css";

// distinct shape + colour per event type (colours track GraphView's TYPE_COLORS)
const MARKER_STYLE: Record<string, { shape: "circle" | "square" | "arrowUp" | "arrowDown"; color: string; position: "aboveBar" | "belowBar" }> = {
  MethodologyChange: { shape: "square", color: "#7a3fbf", position: "belowBar" },
  PriceOverride: { shape: "arrowUp", color: "#d9480f", position: "aboveBar" },
  IPVReview: { shape: "circle", color: "#0f766e", position: "belowBar" },
  Approval: { shape: "circle", color: "#2f9e44", position: "aboveBar" },
  Escalation: { shape: "arrowDown", color: "#e8590c", position: "aboveBar" },
  MAPReview: { shape: "square", color: "#0f9960", position: "belowBar" },
  DecorrelationSignal: { shape: "arrowDown", color: "#5f3dc4", position: "belowBar" },
};

const day = (iso: string) => iso.slice(0, 10);
const fmt = (v: number | null | undefined) => (v == null ? "—" : v.toFixed(3));

function* calendarDays(from: string, to: string): Generator<string> {
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    yield d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

interface Popover {
  events: TlEvent[];
  x: number;
  y: number;
  above: boolean;
}

export function eventRules(controls: TlControl[], eventId: string): TlControl[] {
  return controls.filter((c) => c.trigger === eventId || c.observed === eventId);
}

/** Per-rule LATE/MISSED bar chart — the "rule scores" companion of the timeline. */
export function RuleScoreBars({ controls }: { controls: TlControl[] }) {
  const byRule = useMemo(() => {
    const m = new Map<string, { ruleId: string; ruleName: string; late: number; missed: number }>();
    for (const c of controls) {
      const e = m.get(c.ruleId) ?? { ruleId: c.ruleId, ruleName: c.ruleName, late: 0, missed: 0 };
      if (c.status === "LATE") e.late += 1;
      if (c.status === "MISSED") e.missed += 1;
      m.set(c.ruleId, e);
    }
    return [...m.values()].sort((a, b) => a.ruleId.localeCompare(b.ruleId));
  }, [controls]);
  const max = Math.max(...byRule.map((r) => r.late + r.missed), 1);
  return (
    <div className="rule-score-bars">
      {byRule.map((r) => (
        <div className="rsb-row" key={r.ruleId} title={`${r.ruleId} ${r.ruleName}: ${r.missed} missed, ${r.late} late`}>
          <span className="rsb-label">{r.ruleId}</span>
          <span className="rsb-track">
            <span className="rsb-missed" style={{ width: `${(r.missed / max) * 100}%` }} />
            <span className="rsb-late" style={{ width: `${(r.late / max) * 100}%` }} />
          </span>
          <span className="rsb-count">{r.missed + r.late > 0 ? r.missed + r.late : ""}</span>
        </div>
      ))}
      <div className="rsb-legend">
        <span><span className="rsb-dot rsb-missed" /> missed</span>
        <span><span className="rsb-dot rsb-late" /> late</span>
        <span className="hint-inline">broken-control count per rule (live gap query)</span>
      </div>
    </div>
  );
}

export default function PositionTimeline({
  positionId,
  height = 380,
  onData,
  onOpenNode,
}: {
  positionId: string;
  height?: number;
  /** hands the fetched rows to the parent (rule bars, explain payloads) */
  onData?: (d: PositionTimelineData) => void;
  /** extra hook for "Open in graph" (focus bus is always invoked) */
  onOpenNode?: (id: string) => void;
}) {
  const holderRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const gapLayerRef = useRef<HTMLDivElement | null>(null);
  const [data, setData] = useState<PositionTimelineData | null>(null);
  const [error, setError] = useState("");
  const [popover, setPopover] = useState<Popover | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setPopover(null);
    setError("");
    fetchPositionTimeline(positionId)
      .then((d) => {
        if (cancelled) return;
        if (!d) setError(`no data for ${positionId}`);
        else {
          setData(d);
          onData?.(d);
        }
      })
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionId]);

  // popover click-away
  useEffect(() => {
    if (!popover) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setPopover(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [popover]);

  const openPopover = useCallback((events: TlEvent[], point: { x: number; y: number }) => {
    const w = holderRef.current?.clientWidth ?? 800;
    // vertical offset keeps the popover OFF the marker row, so neighbouring
    // markers (days apart is the norm in a fraud chronology) stay visible
    const above = point.y > 190;
    setPopover({
      events,
      x: Math.min(Math.max(point.x, 130), w - 150),
      y: point.y,
      above,
    });
  }, []);

  useEffect(() => {
    const el = holderRef.current;
    if (!el || !data) return;

    const { prices, events, controls } = data;
    const obs = prices.filter((p) => (p.source === "TRACE" || p.source === "trader mark") && p.clean != null);
    const model = prices.filter((p) => (p.source === "proxy-model" || p.source === "dealer midpoint") && p.clean != null);
    const gaps = controls.filter((c) => (c.status === "MISSED" || c.status === "LATE") && c.dueBy);

    const chart = createChart(el, {
      height,
      layout: { attributionLogo: true, fontSize: 11, textColor: "#44546e" },
      grid: { horzLines: { color: "#eef1f6" }, vertLines: { color: "#f4f6fa" } },
      timeScale: { borderColor: "#c6d4e8" },
      rightPriceScale: { borderColor: "#c6d4e8" },
      crosshair: { mode: 0 },
    });
    chartRef.current = chart;

    // calendar-true axis: whitespace over every day the view must span
    const allDays = [
      ...obs.map((p) => day(p.at)),
      ...model.map((p) => day(p.at)),
      ...events.map((e) => day(e.at)),
      ...gaps.map((g) => day(g.dueBy!)),
    ].sort();
    if (allDays.length === 0) {
      chart.remove();
      chartRef.current = null;
      return;
    }
    const whitespace = chart.addSeries(LineSeries, { color: "transparent", priceLineVisible: false, lastValueVisible: false });
    whitespace.setData([...calendarDays(allDays[0], allDays[allDays.length - 1])].map((t) => ({ time: t as Time })));

    // observed prices: candle when several trades printed, single tick otherwise
    const dedup = new Map<string, (typeof obs)[number]>();
    for (const p of obs) dedup.set(day(p.at), p);
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: "#0b297d", downColor: "#9db4d0", borderVisible: false,
      wickUpColor: "#0b297d", wickDownColor: "#9db4d0",
      priceLineVisible: false, lastValueVisible: false,
    });
    candles.setData(
      [...dedup.values()].map((p) => {
        const multi = (p.tradeCount ?? 0) > 1 && p.open != null && p.high != null && p.low != null && p.close != null;
        const c = p.clean!;
        return multi
          ? { time: day(p.at) as Time, open: p.open!, high: p.high!, low: p.low!, close: p.close! }
          : { time: day(p.at) as Time, open: c, high: c, low: c, close: c };
      }),
    );

    // the model price line — continuous by construction
    const dedupM = new Map<string, number>();
    for (const p of model) dedupM.set(day(p.at), p.clean!);
    const modelLine = chart.addSeries(LineSeries, {
      color: "#00b4d8", lineWidth: 2, priceLineVisible: false, lastValueVisible: false,
    });
    modelLine.setData([...dedupM.entries()].sort().map(([t, v]) => ({ time: t as Time, value: v })));

    // marker series: one point per event day at the best-known price level
    const priceAt = (d0: string): number | null => {
      let best: number | null = null;
      for (const [t, p] of dedup) if (t <= d0 && p.clean != null) best = p.clean;
      if (best == null) for (const [t, v] of [...dedupM.entries()].sort()) if (t <= d0) best = v;
      return best;
    };
    const evByDay = new Map<string, TlEvent[]>();
    for (const e of events) evByDay.set(day(e.at), [...(evByDay.get(day(e.at)) ?? []), e]);
    const evSeries = chart.addSeries(LineSeries, {
      color: "transparent", priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    evSeries.setData(
      [...evByDay.keys()].sort()
        .map((t) => ({ time: t as Time, value: priceAt(t) ?? 100 })),
    );
    const markers: SeriesMarker<Time>[] = events
      .filter((e) => MARKER_STYLE[e.label])
      .map((e) => ({
        time: day(e.at) as Time,
        id: e.id,
        ...MARKER_STYLE[e.label],
        size: 1,
      }));
    createSeriesMarkers(evSeries, markers);

    // bottom pane: cumulative broken-control score (1 per LATE/MISSED gap, by due date)
    const cum = chart.addSeries(HistogramSeries, {
      color: "#5f3dc4", priceLineVisible: false, lastValueVisible: false,
      priceFormat: { type: "volume" },
    }, 1);
    const dueDays = gaps.map((g) => day(g.dueBy!)).sort();
    const months = new Map<string, number>();
    for (const t of calendarDays(allDays[0], allDays[allDays.length - 1])) {
      if (t.slice(8) === "01") months.set(t, dueDays.filter((d0) => d0 < t).length);
    }
    cum.setData([...months.entries()].map(([t, v]) => ({ time: t as Time, value: v })));
    const panes = chart.panes();
    if (panes[1]) panes[1].setHeight(72);

    chart.timeScale().fitContent();

    // dashed vertical lines at gap due dates — DOM overlay kept in sync with the scale
    const layer = gapLayerRef.current;
    const lineEls: { el: HTMLDivElement; time: string }[] = [];
    if (layer) {
      layer.innerHTML = "";
      for (const g of gaps) {
        const l = document.createElement("div");
        l.className = "tlx-gapline";
        l.title = `${g.ruleId} ${g.status} — control due ${day(g.dueBy!)}`;
        const lab = document.createElement("span");
        lab.textContent = g.ruleId;
        l.appendChild(lab);
        layer.appendChild(l);
        lineEls.push({ el: l, time: day(g.dueBy!) });
      }
    }
    const positionLines = () => {
      const visible: { l: HTMLDivElement; x: number }[] = [];
      for (const { el: l, time } of lineEls) {
        const x = chart.timeScale().timeToCoordinate(time as Time);
        if (x == null) l.style.display = "none";
        else {
          l.style.display = "block";
          l.style.left = `${x}px`;
          visible.push({ l, x });
        }
      }
      // clustered due dates: label only the first line of each ≥26px cluster
      visible.sort((a, b) => a.x - b.x);
      let lastLabelX = -Infinity;
      for (const { l, x } of visible) {
        const lab = l.firstElementChild as HTMLElement | null;
        if (!lab) continue;
        if (x - lastLabelX >= 26) {
          lab.style.display = "";
          lastLabelX = x;
        } else {
          lab.style.display = "none";
        }
      }
    };
    positionLines();
    chart.timeScale().subscribeVisibleLogicalRangeChange(positionLines);

    // marker click → popover (graph-written prices only)
    const onClick = (param: MouseEventParams<Time>) => {
      if (!param.point) return;
      const byId = typeof param.hoveredObjectId === "string"
        ? events.filter((e) => e.id === param.hoveredObjectId)
        : [];
      const hits = byId.length > 0
        ? byId
        : param.time
          ? evByDay.get(String(param.time)) ?? []
          : [];
      if (hits.length > 0) openPopover(hits, param.point);
    };
    chart.subscribeClick(onClick);

    const ro = new ResizeObserver(() => {
      chart.applyOptions({ width: el.clientWidth });
      positionLines();
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.unsubscribeClick(onClick);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(positionLines);
      chart.remove();
      chartRef.current = null;
      if (layer) layer.innerHTML = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, height]);

  const controls = data?.controls ?? [];

  return (
    <div className="position-timeline" data-testid={`position-timeline-${positionId}`}>
      {error && <div className="companion-error">⚠ {error}</div>}
      {!data && !error && <div className="hint">loading price + control history…</div>}
      <div className="tlx-holder" ref={holderRef} style={{ minHeight: data ? height : 0 }}>
        <div className="tlx-gaplayer" ref={gapLayerRef} />
        {popover && (
          <div
            className="tlx-popover"
            ref={popRef}
            style={{
              left: popover.x,
              top: popover.above ? popover.y - 14 : popover.y + 22,
              transform: popover.above ? "translate(-50%, -100%)" : "translate(-50%, 0)",
            }}
          >
            {popover.events.map((e) => {
              const rules = eventRules(controls, e.id);
              return (
                <div className="tlx-pop-event" key={e.id}>
                  <div className="tlx-pop-head">
                    <span className="pill pill-info" style={{ background: MARKER_STYLE[e.label]?.color, color: "#fff" }}>
                      {e.label}
                    </span>
                    <code>{e.id}</code>
                    <span className="tlx-pop-date">{day(e.at)}</span>
                  </div>
                  {e.role && <div className="tlx-pop-row">role: {e.role}</div>}
                  <div className="tlx-pop-row">
                    trader mark <strong>{fmt(e.traderMark)}</strong> · model{" "}
                    <strong>{fmt(e.modelPrice)}</strong> · IPV <strong>{fmt(e.ipvPrice)}</strong>
                  </div>
                  {e.divergenceBps != null && (
                    <div className="tlx-pop-row">
                      divergence <strong>{e.divergenceBps} bps</strong>
                    </div>
                  )}
                  {rules.length > 0 && (
                    <div className="tlx-pop-rules">
                      {rules.map((r, i) => (
                        <span className={`pill pill-${r.status.toLowerCase()}`} key={`${r.ruleId}-${i}`}>
                          {r.ruleId} {r.status}
                        </span>
                      ))}
                    </div>
                  )}
                  <button
                    className="demo-btn secondary tlx-pop-open"
                    onClick={() => {
                      setPopover(null);
                      // an on-screen NVL canvas holding the node wins (S1 with the
                      // graph shown); otherwise deep-link to the Explore graph —
                      // the row flash is a secondary cue, never the destination
                      flashNodeRow(e.id);
                      if (!focusNodeInGraph(e.id)) openInExplore(e.id);
                      onOpenNode?.(e.id);
                    }}
                  >
                    Open in graph →
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="tlx-legend">
        <span><span className="tlx-swatch" style={{ background: "#0b297d" }} /> observed (candle = several trades that day)</span>
        <span><span className="tlx-swatch tlx-line" style={{ background: "#00b4d8" }} /> model price</span>
        {Object.entries(MARKER_STYLE).map(([label, s]) => (
          <span key={label}><span className={`tlx-mark tlx-${s.shape}`} style={{ background: s.color }} /> {label}</span>
        ))}
        <span><span className="tlx-swatch tlx-dashed" /> control due date (gap)</span>
      </div>
    </div>
  );
}
