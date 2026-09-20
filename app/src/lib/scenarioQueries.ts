// One exported function per scenario (cosmo-rd convention). Every function is
// headed by the business question + the graph pattern it runs, and wrapped in
// withGroup() so the audit drawer shows the scenario as one block.
// All statements here have been executed against the live `mismarking` DB.

import { runQuery, withGroup } from "./neo4j";

// ═══════════════════════════════════════════════════════════════
// Scenario 1: Conjunction of weak signals
// "Each signal is below threshold; connected, they have a shape."
// Pattern: (Position)-[:GENERATED_SIGNAL|OVERRIDDEN_BY|CHANGED_TO]->(events)
//          + (GovernanceGap)-[:ON_POSITION]->(Position)
// One aggregation across the whole book; no single filter fires alone.
// ═══════════════════════════════════════════════════════════════

export interface ConjunctionRow {
  positionId: string;
  name: string;
  desk: string;
  signals: number;
  overrides: number;
  methodChanges: number;
  brokenRules: string[];
  ruleCount: number;
  conjunctionScore: number;
}

export async function runConjunction(): Promise<ConjunctionRow[]> {
  return withGroup("S1 · Conjunction of weak signals", () =>
    runQuery<ConjunctionRow>(
      `MATCH (p:Position)
       OPTIONAL MATCH (p)-[:GENERATED_SIGNAL]->(s:PnLSignal)
       WITH p, count(DISTINCT s) AS signals
       OPTIONAL MATCH (p)-[:OVERRIDDEN_BY]->(po:PriceOverride)
       WITH p, signals, count(DISTINCT po) AS overrides
       OPTIONAL MATCH (p)-[:CHANGED_TO]->(mc:MethodologyChange)
       WITH p, signals, overrides, count(DISTINCT mc) AS methodChanges
       OPTIONAL MATCH (g:GovernanceGap {abstract: false})-[:ON_POSITION]->(p)
       WITH p, signals, overrides, methodChanges, collect(DISTINCT g.ruleId) AS brokenRules
       MATCH (p)-[:ON_DESK]->(d:Desk)
       RETURN p.id AS positionId, p.name AS name, d.name AS desk,
              signals, overrides, methodChanges, brokenRules,
              size(brokenRules) AS ruleCount,
              (signals + overrides + methodChanges) * size(brokenRules) AS conjunctionScore
       ORDER BY conjunctionScore DESC`,
    ),
  );
}

export interface NeighborhoodNode {
  id: string;
  labels: string[];
  caption: string;
}

export interface NeighborhoodRel {
  f: string;
  t: string;
  ty: string;
}

export interface Neighborhood {
  nodes: NeighborhoodNode[];
  rels: NeighborhoodRel[];
}

/** Everything one hop (two for approval chains) around a position. */
export async function positionNeighborhood(positionId: string): Promise<Neighborhood> {
  const rows = await withGroup(`S1 · Neighborhood of ${positionId}`, () =>
    runQuery<Neighborhood>(
      `MATCH (p:Position {id: $id})
       CALL (p) {
         MATCH (p)-[r:OVERRIDDEN_BY|GENERATED_SIGNAL|CHANGED_TO|REVIEWED_BY|SUBJECT_TO_CONTROL|ESCALATED_TO|OWNED_BY|ON_DESK|VALUED_BY|OF_INSTRUMENT]->(x)
         RETURN p AS a, r, x AS b
         UNION
         MATCH (p)-[:OVERRIDDEN_BY|CHANGED_TO]->(t)-[r:APPROVED_BY]->(x:Approval)
         RETURN t AS a, r, x AS b
         UNION
         MATCH (p)-[:OVERRIDDEN_BY|CHANGED_TO]->(t)-[:APPROVED_BY]->(ap:Approval)-[r:APPROVED_BY]->(x)
         RETURN ap AS a, r, x AS b
         UNION
         MATCH (g:GovernanceGap {abstract: false})-[r:ON_POSITION]->(p)
         RETURN g AS a, r, p AS b
       }
       WITH collect(DISTINCT a) + collect(DISTINCT b) AS ns,
            collect(DISTINCT {f: a.id, t: b.id, ty: type(r)}) AS rels
       UNWIND ns AS n
       WITH collect(DISTINCT {id: n.id, labels: labels(n),
                              caption: coalesce(n.name, n.role, n.id)}) AS nodes, rels
       RETURN nodes, rels`,
      { id: positionId },
    ),
  );
  return rows[0] ?? { nodes: [], rels: [] };
}

/** The CONJUNCTION as a set of node ids — derived from the same evidence the
 *  conjunction query counts, pure Cypher, no algorithm: the position, its
 *  counted signal events, the trigger events of its computed gaps, the gaps,
 *  and the approvals/people attached to any of them. S1 colours these and
 *  greys the rest of the neighbourhood. */
export async function conjunctionMembers(positionId: string): Promise<Set<string>> {
  const rows = await withGroup(`S1 · Conjunction members of ${positionId}`, () =>
    runQuery<{ ids: string[] }>(
      `MATCH (p:Position {id: $id})
       CALL (p) {
         MATCH (p)-[:OVERRIDDEN_BY|GENERATED_SIGNAL|CHANGED_TO]->(e) RETURN e
         UNION
         MATCH (g:GovernanceGap {abstract: false, positionId: p.id})-[:ON_TRIGGER]->(e:Event) RETURN e
         UNION
         MATCH (e:GovernanceGap {abstract: false, positionId: p.id}) RETURN e
       }
       WITH p, collect(DISTINCT e) AS es
       OPTIONAL MATCH (e1)-[:PERFORMED_BY]->(x) WHERE e1 IN es
       WITH p, es, collect(DISTINCT x) AS performers
       OPTIONAL MATCH (e2)-[:APPROVED_BY]->(a:Approval) WHERE e2 IN es
       WITH p, es, performers, collect(DISTINCT a) AS approvals
       OPTIONAL MATCH (a2)-[:APPROVED_BY]->(y) WHERE a2 IN approvals
       WITH p, es, performers, approvals, collect(DISTINCT y) AS approvers
       RETURN [p.id] + [e IN es | e.id] + [x IN performers | x.id]
              + [a IN approvals | a.id] + [y IN approvers | y.id] AS ids`,
      { id: positionId },
    ),
  );
  return new Set(rows[0]?.ids ?? []);
}

// ═══════════════════════════════════════════════════════════════
// Scenario 2: Chronology — event-time reconstruction + expected-vs-observed
// "Reconstruct what happened, in order; which control should have fired?"
// Pattern: (:Event {positionId})-[:NEXT]->(:Event) chains (QPP), plus the
// parameterised gap query from data/gap_query.cypher (single source of truth).
// The chronology itself comes from queries.timeline(); the QPP below shows the
// governance chain the graph can walk (override → … → IPV review).
// ═══════════════════════════════════════════════════════════════

export interface ChainRow {
  fromId: string;
  fromLabel: string;
  toId: string;
  toLabel: string;
  hops: number;
  daysBetween: number | null;
}

export async function chronologyChain(positionId: string): Promise<ChainRow[]> {
  return withGroup(`S2 · QPP governance chain of ${positionId}`, () =>
    runQuery<ChainRow>(
      `MATCH path = (po:PriceOverride {positionId: $id})(()-[:NEXT]->()){1,10}(ipv:IPVReview)
       RETURN po.id AS fromId, 'PriceOverride' AS fromLabel,
              ipv.id AS toId, 'IPVReview' AS toLabel,
              length(path) AS hops,
              duration.between(po.at, ipv.at).days AS daysBetween
       ORDER BY po.at LIMIT 20`,
      { id: positionId },
    ),
  );
}

// ═══════════════════════════════════════════════════════════════
// Scenario 3: Abstraction — from the confirmed incident to a :Pattern template
// "Strip instrument identity; keep risk attributes + governance gaps."
// Pattern: (Incident)-[:CAUSED_BY]->(Position)-[:HAS_RISK_ATTRIBUTE]->(RA)
//          (GovernanceGap concrete)-[:INSTANCE_OF]->(GovernanceGap abstract)
//          => (Pattern)-[:REQUIRES]->(RA | abstract gap)
// ═══════════════════════════════════════════════════════════════

export interface PatternInfo {
  id: string;
  name: string;
  fromIncident: string;
  requires: { id: string; name: string; isGap: boolean }[];
}

export async function createPatternFromIncident(incidentId = "INC-TP"): Promise<PatternInfo> {
  return withGroup("S3 · Abstract the confirmed case into a Pattern", async () => {
    await runQuery(
      `MATCH (inc:Incident {id: $incidentId})-[:CAUSED_BY]->(p:Position)
       MERGE (pat:Pattern {id: 'PATTERN-TP'})
       SET pat.name = 'Mismarked illiquid book', pat.fromIncident = inc.id
       WITH pat, p
       CALL (pat, p) {
         MATCH (p)-[:HAS_RISK_ATTRIBUTE]->(ra:RiskAttribute)
         WHERE ra.type IN ['methodologyFamily', 'liquidityTier', 'maturityBucket']
         MERGE (pat)-[:REQUIRES]->(ra)
       }
       CALL (pat, p) {
         MATCH (g:GovernanceGap {abstract: false})-[:ON_POSITION]->(p)
         MATCH (g)-[:INSTANCE_OF]->(gc:GovernanceGap {abstract: true})
         MERGE (pat)-[:REQUIRES]->(gc)
       }
       RETURN pat.id AS id`,
      { incidentId },
    );
    return getPattern();
  });
}

export async function getPattern(): Promise<PatternInfo> {
  const rows = await runQuery<PatternInfo>(
    `MATCH (pat:Pattern {id: 'PATTERN-TP'})
     OPTIONAL MATCH (pat)-[:REQUIRES]->(t)
     WITH pat, collect({id: t.id, name: coalesce(t.name, t.type + '=' + t.value),
                        isGap: (t:GovernanceGap)}) AS requires
     RETURN pat.id AS id, pat.name AS name, pat.fromIncident AS fromIncident, requires`,
  );
  return rows[0] ?? { id: "PATTERN-TP", name: "", fromIncident: "", requires: [] };
}

export interface RequireCandidate {
  id: string;
  name: string;
  isGap: boolean;
}

export async function listRequireCandidates(): Promise<RequireCandidate[]> {
  return runQuery<RequireCandidate>(
    `CALL () {
       MATCH (ra:RiskAttribute) RETURN ra.id AS id, ra.type + '=' + ra.value AS name, false AS isGap
       UNION
       MATCH (gc:GovernanceGap {abstract: true}) RETURN gc.id AS id, gc.name AS name, true AS isGap
     }
     RETURN id, name, isGap ORDER BY isGap, name`,
  );
}

/** Widen/narrow the pattern live — pattern size is not self-censored. */
export async function addRequires(targetId: string): Promise<void> {
  await withGroup(`S3/S4 · Widen pattern: + ${targetId}`, () =>
    runQuery(
      `MATCH (pat:Pattern {id: 'PATTERN-TP'})
       MATCH (t) WHERE t.id = $targetId AND (t:RiskAttribute OR t:GovernanceGap)
       MERGE (pat)-[:REQUIRES]->(t)`,
      { targetId },
    ),
  );
}

export async function removeRequires(targetId: string): Promise<void> {
  await withGroup(`S3/S4 · Narrow pattern: - ${targetId}`, () =>
    runQuery(
      `MATCH (pat:Pattern {id: 'PATTERN-TP'})-[r:REQUIRES]->(t {id: $targetId}) DELETE r`,
      { targetId },
    ),
  );
}

// ═══════════════════════════════════════════════════════════════
// Scenario 4: Read-across — run the Pattern against the whole population
// "Exact matches ranked, partial matches scored = early detection."
// Pattern: (Pattern)-[:REQUIRES]->(t) where t is satisfied by
//   RiskAttribute: (Position)-[:HAS_RISK_ATTRIBUTE]->(t)
//   abstract Gap:  (g {abstract:false})-[:ON_POSITION]->(Position), (g)-[:INSTANCE_OF]->(t)
// Score = satisfied REQUIRES / total REQUIRES.
// ═══════════════════════════════════════════════════════════════

export interface ReadAcrossRow {
  positionId: string;
  name: string;
  desk: string;
  satisfied: string[];
  missing: string[];
  score: number;
  confirmedIncident: boolean;
}

export async function scoreReadAcross(): Promise<ReadAcrossRow[]> {
  return withGroup("S4 · Read-across: pattern vs whole population", () =>
    runQuery<ReadAcrossRow>(
      `MATCH (pat:Pattern {id: 'PATTERN-TP'})-[:REQUIRES]->(t)
       WITH collect({id: t.id, name: coalesce(t.name, t.type + '=' + t.value),
                     isGap: (t:GovernanceGap)}) AS targets
       MATCH (p:Position)-[:ON_DESK]->(d:Desk)
       UNWIND targets AS t
       WITH p, d, t,
            CASE WHEN t.isGap
              THEN EXISTS { MATCH (g:GovernanceGap {abstract: false})-[:ON_POSITION]->(p)
                            MATCH (g)-[:INSTANCE_OF]->(:GovernanceGap {id: t.id}) }
              ELSE EXISTS { MATCH (p)-[:HAS_RISK_ATTRIBUTE]->(:RiskAttribute {id: t.id}) }
            END AS ok
       WITH p, d, collect(CASE WHEN ok THEN t.name END) AS satisfied,
            collect(CASE WHEN NOT ok THEN t.name END) AS missing
       RETURN p.id AS positionId, p.name AS name, d.name AS desk, satisfied, missing,
              toFloat(size(satisfied)) / (size(satisfied) + size(missing)) AS score,
              EXISTS { MATCH (:Incident)-[:CAUSED_BY]->(p) } AS confirmedIncident
       ORDER BY score DESC, positionId`,
    ),
  );
}

// ── S4b: predicted links against held-out ground truth ──
// Six Position→RiskAttribute links were REMOVED at generation time
// (data/holdout_links.json). GDS node similarity over the Position–RiskAttribute
