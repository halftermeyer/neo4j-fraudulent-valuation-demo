// Typed Cypher query functions shared by the tabs, the Assistant tools and the
// Policy panel. One function per business question; scenario-specific functions
// live in scenarioQueries.ts.
//
// The GAP QUERY is never duplicated: it is fetched from /data/gap_query.cypher
// (the same file mcp_server.py and tests/ read) and the GovernanceGap
// materialisation wraps that same text (DECISIONS.md #9).

import { DateTime } from "neo4j-driver";
import { runQuery, withGroup } from "./neo4j";

export const AS_OF_DEFAULT = "2023-01-01T00:00:00Z"; // dataset clock end

/** JS Dates are not auto-converted by the driver — always send a neo4j DateTime. */
export function neoDateTime(iso: string): DateTime<number> {
  return DateTime.fromStandardDate(new Date(iso));
}

// ── gap query (single source of truth) ──────────────────────────────────────

let _gapQuery: string | null = null;

export async function loadGapQueryText(): Promise<string> {
  if (!_gapQuery) {
    const resp = await fetch("/data/gap_query.cypher");
    if (!resp.ok) throw new Error("data/gap_query.cypher not found — run `make data`");
    _gapQuery = await resp.text();
  }
  return _gapQuery;
}

export interface GapRow {
  ruleId: string;
  ruleName: string;
  severity: string;
  expectedControl: string;
  requiredByRole: string;
  positionId: string;
  triggerEventId: string | null;
  triggerAt: string | null;
  triggerLabel: string | null;
  dueBy: string | null;
  observedEventId: string | null;
  observedAt: string | null;
  status: "MET" | "LATE" | "MISSED" | "PENDING";
}

/** Expected-vs-observed for every obligation (all statuses, incl. MET). */
export async function expectedControls(
  positionId: string | null,
  opts: { ruleId?: string | null; asOf?: string } = {},
): Promise<GapRow[]> {
  const gapQuery = await loadGapQueryText();
  const rows = await runQuery<GapRow>(gapQuery, {
    positionId,
    ruleId: opts.ruleId ?? null,
    asOf: neoDateTime(opts.asOf ?? AS_OF_DEFAULT),
  });
  return rows.sort((a, b) => String(a.triggerAt).localeCompare(String(b.triggerAt)));
}

/** Only the gaps (MISSED | LATE) — "which control should have fired and did not". */
export async function governanceGaps(
  positionId: string | null,
  opts: { ruleId?: string | null; asOf?: string } = {},
): Promise<GapRow[]> {
  const rows = await expectedControls(positionId, opts);
  return rows.filter((r) => r.status === "MISSED" || r.status === "LATE");
}

/** Re-materialise :GovernanceGap nodes with THE SAME query text.
 *  Called after ingest and after every Policy-panel change. */
export async function materialiseGaps(asOf: string = AS_OF_DEFAULT): Promise<number> {
  const gapQuery = await loadGapQueryText();
  await runQuery("MATCH (g:GovernanceGap {abstract: false}) DETACH DELETE g");
  await runQuery(
    `CALL () {\n${gapQuery}\n}
WITH * WHERE status IN ['MISSED', 'LATE']
MATCH (o:ControlObligation {id: ruleId})
MATCH (p:Position {id: positionId})
MERGE (g:GovernanceGap {id: 'GAP-' + ruleId + '-' + positionId + '-' + coalesce(triggerEventId, 'x')})
SET g.abstract = false, g.ruleId = ruleId, g.positionId = positionId,
    g.triggerEventId = triggerEventId, g.status = status, g.severity = severity,
    g.dueBy = dueBy, g.computedAt = $asOf
MERGE (g)-[:OF_RULE]->(o)
MERGE (g)-[:ON_POSITION]->(p)
WITH g, triggerEventId
MATCH (gc:GovernanceGap {abstract: true, ruleId: g.ruleId}) MERGE (g)-[:INSTANCE_OF]->(gc)
WITH g, triggerEventId
OPTIONAL MATCH (t:Event {id: triggerEventId})
FOREACH (tt IN CASE WHEN t IS NULL THEN [] ELSE [t] END | MERGE (g)-[:ON_TRIGGER]->(tt))`,
    { positionId: null, ruleId: null, asOf: neoDateTime(asOf) },
  );
  const n = await runQuery<{ c: number }>(
    "MATCH (g:GovernanceGap {abstract: false}) RETURN count(g) AS c",
  );
  return n[0]?.c ?? 0;
}

export interface GapRuleSummary {
  ruleId: string;
  ruleName: string;
  MET: number;
  LATE: number;
  MISSED: number;
  PENDING: number;
}

/** The visible "Compute governance gaps" step of the Policy panel: run the gap
 *  query live over every position, materialise the gaps with the same text, and
 *  return per-rule counts by status. */
export async function computeGaps(
  asOf: string = AS_OF_DEFAULT,
): Promise<{ summary: GapRuleSummary[]; gapCount: number }> {
  return withGroup("Compute governance gaps", async () => {
    const obligations = await listObligations();
    const rows = await expectedControls(null, { asOf });
    const gapCount = await materialiseGaps(asOf);
    const byRule = new Map<string, GapRuleSummary>(
      obligations.map((o) => [
        o.id,
        { ruleId: o.id, ruleName: o.name, MET: 0, LATE: 0, MISSED: 0, PENDING: 0 },
      ]),
    );
    for (const r of rows) {
      const s = byRule.get(r.ruleId);
      if (s) s[r.status] += 1;
    }
    return { summary: [...byRule.values()], gapCount };
  });
}

// ── ingest flow (UI-triggered, layer by layer — DECISIONS.md #8) ────────────

const DATETIME_PROPS = ["at", "sourceAt", "effectiveAt", "openedAt", "validFrom", "validTo"];

export type LayerName = "market" | "governance" | "cases";

interface LayerPayload {
  nodes: Record<string, Record<string, unknown>[]>;
  rels: Record<string, { from: string; to: string; [k: string]: unknown }[]>;
}

const CONSTRAINT_LABELS = [
  "Instrument", "Position", "Person", "Desk", "Committee", "Policy",
  "ControlObligation", "RiskAttribute", "ValuationMethodology", "GovernanceGap",
  "Pattern", "Curve", "Evidence", "Incident", "RootCause", "CorrectiveAction",
];

export async function ensureSchema(): Promise<void> {
  for (const label of CONSTRAINT_LABELS) {
    await runQuery(
      `CREATE CONSTRAINT ${label.toLowerCase()}_id IF NOT EXISTS FOR (n:${label}) REQUIRE n.id IS UNIQUE`,
    );
  }
  await runQuery("CREATE INDEX event_id IF NOT EXISTS FOR (n:Event) ON (n.id)");
  await runQuery("CREATE INDEX event_at IF NOT EXISTS FOR (n:Event) ON (n.at)");
}

export async function layerCounts(): Promise<Record<string, number>> {
  const rows = await runQuery<{ label: string; c: number }>(
    `MATCH (n) UNWIND labels(n) AS label
     WITH label, count(*) AS c WHERE NOT label = 'Event'
     RETURN label, c ORDER BY c DESC`,
  );
  return Object.fromEntries(rows.map((r) => [r.label, r.c]));
}

export async function ingestLayer(
  name: LayerName,
  onProgress?: (msg: string) => void,
): Promise<void> {
  const resp = await fetch(`/data/layers/${name}.json`);
  if (!resp.ok) throw new Error(`data/layers/${name}.json not found — run \`make data\``);
  const payload: LayerPayload = await resp.json();

  await withGroup(`Ingest layer: ${name}`, async () => {
    await ensureSchema();
    for (const [labelKey, nodes] of Object.entries(payload.nodes)) {
      onProgress?.(`${name}: ${labelKey} (${nodes.length} nodes)`);
      const labels = labelKey.split(":").join(":");
      for (let i = 0; i < nodes.length; i += 1000) {
        await runQuery(
          `UNWIND $rows AS r CREATE (n:${labels}) SET n = r
           FOREACH (p IN [k IN $dtProps WHERE r[k] IS NOT NULL] |
             SET n[p] = datetime(r[p]))`,
          { rows: nodes.slice(i, i + 1000), dtProps: DATETIME_PROPS },
        );
      }
    }
    for (const [relKey, rels] of Object.entries(payload.rels)) {
      const [rtype, fromLabel, toLabel] = relKey.split("|");
      onProgress?.(`${name}: ${rtype} (${rels.length} rels)`);
      for (let i = 0; i < rels.length; i += 2000) {
        await runQuery(
          `UNWIND $rows AS r
           MATCH (a:${fromLabel} {id: r.from}) MATCH (b:${toLabel} {id: r.to})
           CREATE (a)-[rel:${rtype}]->(b)
           SET rel = r, rel.from = null, rel.to = null`,
          { rows: rels.slice(i, i + 2000) },
        );
      }
    }
    if (name === "governance") {
      onProgress?.("creating abstract gap classes");
      await runQuery(
        `MATCH (o:ControlObligation)
         MERGE (g:GovernanceGap {id: 'GAPCLASS-' + o.id})
         SET g.ruleId = o.id, g.abstract = true, g.name = 'Gap: ' + o.name
         MERGE (g)-[:OF_RULE]->(o)`,
      );
    }
    if (name === "governance" || name === "cases") {
      onProgress?.("computing governance gaps (expected vs observed)");
      const n = await materialiseGaps();
      onProgress?.(`${n} governance gaps computed`);
    }
  });
}

export async function resetDatabase(): Promise<void> {
  await withGroup("Reset database", async () => {
    // batched delete keeps the browser transaction light
    let deleted = 1;
    while (deleted > 0) {
      const rows = await runQuery<{ c: number }>(
        "MATCH (n) WITH n LIMIT 5000 DETACH DELETE n RETURN count(*) AS c",
      );
      deleted = rows[0]?.c ?? 0;
    }
  });
}

// ── policy panel ────────────────────────────────────────────────────────────

export interface Obligation {
  id: string;
  name: string;
  severity: string;
  status: string | null; // 'candidate — …' for Discovery proposals, null for the CSV nine
  timing: string;
  slaDays: number;
  triggerEvent: string;
  requiredControl: string;
  requiredByRole: string;
  gapDefinition: string;
  paramsJson: string;
  defaultParamsJson: string;
  params: Record<string, number | boolean>;
}

export async function listObligations(): Promise<Obligation[]> {
  const rows = await runQuery<Obligation & Record<string, unknown>>(
    `MATCH (o:ControlObligation)
     RETURN o.id AS id, o.name AS name, o.severity AS severity, o.status AS status,
            o.timing AS timing,
            o.slaDays AS slaDays, o.triggerEvent AS triggerEvent,
            o.requiredControl AS requiredControl, o.requiredByRole AS requiredByRole,
            o.gapDefinition AS gapDefinition, o.paramsJson AS paramsJson,
            o.defaultParamsJson AS defaultParamsJson, o.slaDays AS _sla
     ORDER BY o.id`,
  );
  return rows.map((r) => ({ ...r, params: JSON.parse(r.paramsJson || "{}") }));
}

/** Edit one parameter of one obligation. The next gap run picks it up —
 *  no data regeneration (prompt requirement). */
export async function updateObligationParams(
  id: string,
  params: Record<string, number | boolean>,
  slaDays?: number,
): Promise<void> {
  await withGroup(`Policy edit: ${id}`, async () => {
    await runQuery(
      `MATCH (o:ControlObligation {id: $id})
       SET o += $params, o.paramsJson = $json
       ${slaDays !== undefined ? ", o.slaDays = $slaDays" : ""}`,
      { id, params, json: JSON.stringify(params), slaDays },
    );
    await materialiseGaps();
  });
}

export async function resetObligations(): Promise<void> {
  await withGroup("Policy reset to CSV defaults", async () => {
    const obs = await listObligations();
    for (const o of obs) {
      const defaults = JSON.parse(o.defaultParamsJson || "{}");
      await runQuery(
        `MATCH (o:ControlObligation {id: $id}) SET o += $params, o.paramsJson = $json`,
        { id: o.id, params: defaults, json: o.defaultParamsJson },
      );
    }
    await materialiseGaps();
  });
}

// ── shared lookups (also the Assistant's typed tools) ───────────────────────

export interface PositionSummary {
  id: string;
  name: string;
  desk: string;
  deskName: string;
  sector: string | null;
  gapCount: number;
  synthetic: boolean;
}

export async function listPositions(): Promise<PositionSummary[]> {
  return runQuery<PositionSummary>(
    `MATCH (p:Position)-[:ON_DESK]->(d:Desk)
     OPTIONAL MATCH (p)-[:OF_INSTRUMENT]->(i:Instrument)
     OPTIONAL MATCH (g:GovernanceGap {abstract: false})-[:ON_POSITION]->(p)
     RETURN p.id AS id, p.name AS name, d.id AS desk, d.name AS deskName,
            i.sector AS sector, count(g) AS gapCount,
            coalesce(p.synthetic, false) AS synthetic
     ORDER BY gapCount DESC, id`,
  );
}

export interface TimelineEvent {
  id: string;
  label: string;
  at: string;
  sourceAt: string | null;
  description: string | null;
  props: Record<string, unknown>;
  timeDeltaDays: number | null;
}

/** Chronological reconstruction of everything that happened to a position,
 *  via the :NEXT event chain (fraud-event-sequence model). Weekly :Mark events
 *  are market data, not chronology — the timeline chart shows them; this list
 *  does not (they would flood it, ~50 rows per year per position). */
export async function timeline(positionId: string): Promise<TimelineEvent[]> {
  return runQuery<TimelineEvent>(
    `MATCH (e:Event {positionId: $positionId})
     WHERE NOT e:Mark
     OPTIONAL MATCH (prev:Event)-[nx:NEXT]->(e)
     RETURN e.id AS id, [l IN labels(e) WHERE l <> 'Event'][0] AS label,
            toString(e.at) AS at, toString(e.sourceAt) AS sourceAt,
            e.description AS description, properties(e) AS props,
            nx.timeDelta AS timeDeltaDays
     ORDER BY e.at`,
    { positionId },
  );
}

/** Who approved a change/override, and were they independent? */
export async function whoApproved(eventId: string) {
  return runQuery(
    `MATCH (t:Event {id: $eventId})-[:APPROVED_BY]->(a:Approval)
     OPTIONAL MATCH (a)-[:APPROVED_BY]->(by)
     OPTIONAL MATCH (by)-[:ON_DESK]->(d:Desk)
     OPTIONAL MATCH (p:Position {id: t.positionId})-[:ON_DESK]->(pd:Desk)
     OPTIONAL MATCH (a)-[:EVIDENCED_BY]->(ev:Evidence)
     RETURN a.id AS approvalId, toString(a.at) AS approvedAt,
            by.name AS approver, by.role AS approverRole, d.id AS approverDesk,
            pd.id AS positionDesk,
            (d IS NOT NULL AND d = pd) AS sameDesk,
            count(ev) > 0 AS evidenced`,
    { eventId },
  );
}

/** Observed price vs proxy-model divergence history for a position. */
export async function divergence(positionId: string) {
  return runQuery(
    `MATCH (p:Position {id: $positionId})-[:OF_INSTRUMENT]->(i:Instrument)
     MATCH (obs:MarketPrice)-[:PRICE_OF]->(i)
     OPTIONAL MATCH (obs)-[c:COMPARED_WITH]->(proxy:MarketPrice)-[:PRICE_OF]->(i)
     WITH obs, proxy, c WHERE obs.source IN ['TRACE', 'trader mark']
     RETURN toString(obs.at) AS at, obs.clean AS observed, obs.source AS source,
            proxy.clean AS proxy, c.divergenceBps AS divergenceBps
     ORDER BY obs.at`,
    { positionId },
  );
}

/** Positions that partially match confirmed-case gaps today (early detection). */
export async function nearMisses(minRules = 2) {
  return runQuery(
    `MATCH (g:GovernanceGap {abstract: false})-[:ON_POSITION]->(p:Position)
     WHERE NOT EXISTS { MATCH (:Incident)-[:CAUSED_BY]->(p) }
     WITH p, collect(DISTINCT g.ruleId) AS rules
     WHERE size(rules) >= $minRules
     MATCH (p)-[:ON_DESK]->(d:Desk)
     RETURN p.id AS positionId, p.name AS name, d.name AS desk,
            rules, size(rules) AS ruleCount
     ORDER BY ruleCount DESC LIMIT 25`,
    { minRules },
  );
}

export async function policyParams() {
  const obs = await listObligations();
  return obs.map((o) => ({
    id: o.id, name: o.name, timing: o.timing, slaDays: o.slaDays,
    params: o.params, gapDefinition: o.gapDefinition,
  }));
}
