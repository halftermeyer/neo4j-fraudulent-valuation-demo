// The ONE Cypher query behind the PositionTimeline (batch-2 SME review): price
// series + marker events (with the graph-written traderMark/modelPrice/ipvPrice)
// + the expected-vs-observed rows for every rule — the gap query is inlined
// VERBATIM as a CALL subquery (data/gap_query.cypher stays the single source of
// truth), so one audit-drawer entry per position feeds the whole chart.

import { runQuery, withGroup } from "./neo4j";
import { AS_OF_DEFAULT, loadGapQueryText, neoDateTime } from "./queries";

export interface TlPrice {
  at: string;
  clean: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  tradeCount: number | null;
  source: string;
}

export interface TlEvent {
  id: string;
  label: string;
  at: string;
  role: string | null;
  traderMark: number | null;
  modelPrice: number | null;
  ipvPrice: number | null;
  divergenceBps: number | null;
}

export interface TlControl {
  ruleId: string;
  ruleName: string;
  status: "MET" | "LATE" | "MISSED" | "PENDING";
  dueBy: string | null;
  trigger: string | null;
  observed: string | null;
}

export interface PositionTimelineData {
  prices: TlPrice[];
  events: TlEvent[];
  controls: TlControl[];
}

export const TIMELINE_EVENT_LABELS = [
  "MethodologyChange", "PriceOverride", "IPVReview", "Approval", "Escalation", "MAPReview",
  "DecorrelationSignal", // written by the Discovery peer-decorrelation panel
] as const;

export async function fetchPositionTimeline(
  positionId: string,
  asOf: string = AS_OF_DEFAULT,
): Promise<PositionTimelineData | null> {
  const gapText = await loadGapQueryText();
  const cypher = `MATCH (p:Position {id: $positionId})-[:OF_INSTRUMENT]->(i:Instrument)
CALL (i) {
  MATCH (mp:MarketPrice)-[:PRICE_OF]->(i)
  WITH mp ORDER BY mp.at
  RETURN collect({at: toString(mp.at), clean: mp.clean, open: mp.open, high: mp.high,
                  low: mp.low, close: mp.close, tradeCount: mp.tradeCount,
                  source: mp.source}) AS prices
}
CALL (p) {
  MATCH (e:Event {positionId: p.id})
  WHERE [l IN labels(e) WHERE l <> 'Event'][0] IN [${TIMELINE_EVENT_LABELS.map((l) => `'${l}'`).join(",")}]
  WITH e ORDER BY e.at
  RETURN collect({
    id: e.id, label: [l IN labels(e) WHERE l <> 'Event'][0], at: toString(e.at),
    role: coalesce([(e)-[:PERFORMED_BY|APPROVED_BY]->(w:Person) | w.role][0], e.actorRole),
    traderMark: e.traderMark, modelPrice: e.modelPrice, ipvPrice: e.ipvPrice,
    divergenceBps: coalesce(e.divergenceBps,
      CASE WHEN e.traderMark IS NOT NULL AND e.modelPrice IS NOT NULL AND e.modelPrice > 0
           THEN toInteger(round((e.traderMark - e.modelPrice) / e.modelPrice * 10000)) END)
  }) AS events
}
CALL () {
  CALL () {
${gapText}
  }
  RETURN collect({ruleId: ruleId, ruleName: ruleName, status: status,
                  dueBy: toString(dueBy), trigger: triggerEventId,
                  observed: observedEventId}) AS controls
}
RETURN prices, events, controls`;
  const rows = await withGroup(`Position timeline: ${positionId}`, () =>
    runQuery<PositionTimelineData>(cypher, {
      positionId,
      ruleId: null,
      asOf: neoDateTime(asOf),
    }),
  );
  return rows[0] ?? null;
}
