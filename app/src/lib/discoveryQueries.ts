// Discovery tab — structure-driven analysis that FEEDS the main flow.
// Naming rule: customer-facing copy never says GDS / algorithms / machine
// learning / prediction. Every function here runs through the audited runQuery;
// projections are dropped after use; nothing persists into S1–S4 unless a
// panel's output button wrote it — and discoveryReset() removes every such write.

import { baseEmbedding, euclidean, type FastPathParams, type FpEvent } from "./fastpath";
import { runQuery, withGroup } from "./neo4j";
import { AS_OF_DEFAULT, neoDateTime } from "./queries";

// ── tab-wide reset ───────────────────────────────────────────────────────────

/** Remove EVERYTHING Discovery ever wrote (candidate rules, watchlist entries,
 *  signals, similarity/correlation relationships, behaviour-cluster attributes,
 *  trajectory properties) and drop any lingering in-memory graphs. */
export async function discoveryReset(): Promise<void> {
  await withGroup("Discovery · reset (remove all Discovery writes)", async () => {
    for (const g of ["disc_approval", "disc_traj", "disc_corr", "disc_corr_cluster"]) {
      await runQuery(`CALL gds.graph.drop($g, false) YIELD graphName RETURN graphName`, { g });
    }
    await runQuery(`MATCH (o:ControlObligation) WHERE o.id IN ['R-C1', 'R10'] DETACH DELETE o`);
    await runQuery(`MATCH ()-[r:SIMILAR_TRAJECTORY]->() DELETE r`);
    await runQuery(`MATCH ()-[r:CORRELATES_WITH]->() DELETE r`);
    await runQuery(`MATCH (ds:DecorrelationSignal) DETACH DELETE ds`);
    await runQuery(`MATCH (w:WatchlistEntry) DETACH DELETE w`);
    await runQuery(`MATCH (ra:RiskAttribute {type: 'behaviourCluster'}) DETACH DELETE ra`);
    await runQuery(`MATCH (p:Position) REMOVE p.trajectory, p.markReturns`);
    await runQuery(
      `MATCH (g:GovernanceGap {abstract: false}) WHERE g.ruleId IN ['R-C1', 'R10'] DETACH DELETE g`,
    );
  });
}

// ── Panel 1 · Approval circles ───────────────────────────────────────────────

export interface CirclePerson {
  personId: string;
  role: string | null;
  desk: string | null;
  deskName: string | null;
  community: number;
  independent: boolean; // carries an independent control function
}

const INDEPENDENT_DESKS = ["DESK-IPV", "DESK-PC", "DESK-RISK", "DESK-MAP"];
const INDEPENDENT_ROLE = "(?i).*(ipv|product control|risk|controller|vcg|map|model).*";

/** Who approves whose overrides — communities of the weighted approval graph.
 *  (Community detection on Person→Person "a approved an override entered by t".) */
export async function approvalCircles(): Promise<CirclePerson[]> {
  return withGroup("Discovery · approval circles", async () => {
    await runQuery(`CALL gds.graph.drop('disc_approval', false) YIELD graphName RETURN graphName`);
    await runQuery(
      `MATCH (t:Person)<-[:PERFORMED_BY]-(po:PriceOverride)-[:APPROVED_BY]->(:Approval)-[:APPROVED_BY]->(a:Person)
       WHERE a <> t
       WITH a, t, count(*) AS w
       WITH gds.graph.project('disc_approval', a, t,
              {relationshipProperties: {w: w}},
              {undirectedRelationshipTypes: ['*']}) AS g
       RETURN g.nodeCount AS nodes, g.relationshipCount AS rels`,
    );
    const rows = await runQuery<CirclePerson>(
      `CALL gds.louvain.stream('disc_approval', {relationshipWeightProperty: 'w'})
       YIELD nodeId, communityId
       WITH gds.util.asNode(nodeId) AS person, communityId
       OPTIONAL MATCH (person)-[:ON_DESK]->(d:Desk)
       RETURN person.id AS personId, person.role AS role,
              d.id AS desk, d.name AS deskName, communityId AS community,
              (d.id IN $indepDesks OR person.role =~ $indepRole) AS independent
       ORDER BY community, personId`,
      { indepDesks: INDEPENDENT_DESKS, indepRole: INDEPENDENT_ROLE },
    );
    await runQuery(`CALL gds.graph.drop('disc_approval', false) YIELD graphName RETURN graphName`);
    return rows;
  });
}

// ── Panel 2 · Trajectories (FastPath reimplementation — see lib/fastpath.ts) ──

/** Fixed trajectory parameters, shown in the panel copy. Θ = 365 d, 5 grid
 *  points (≈ quarterly bands), λ/γ in per-day units. */
export const TRAJECTORY_PARAMS: FastPathParams = {
  gridPoints: 5,
  theta: 365,
  smoothingWindow: 1,
  smoothingRate: 0.02,
  decayRate: 0.005,
};

// atoms: rule id (for gaps), event label, approver/performer role, desk.
// Signal-bearing labels only: the routine compliance heartbeat (monthly
// IPVReview / periodic MAPReview / Control) is shared by every position and
// would swamp the discriminative dimensions (DECISIONS.md).
const TRAJECTORY_EVENT_LABELS = [
  "MethodologyChange", "PriceOverride", "Escalation", "PnLSignal", "Approval",
];

interface RawTrajectory {
  positionId: string;
  desk: string | null;
  events: { days: number; label: string; role: string | null }[];
  gaps: { days: number; ruleId: string }[];
}

export interface TrajectoryNeighbor {
  positionId: string;
  cosine: number;
  euclid: number;
  topDims: { atom: string; gridIndex: number; weight: number }[];
}

// the readable retrieval check: does the shortlist over-select books with a
// recent history of the case's core gap families?
export const RETRIEVAL_RULES = ["R3", "R5", "R8"] as const;
export const RETRIEVAL_MIN_GAPS = 2;

export interface TrajectoryResult {
  atoms: string[];
  gridDays: number[];
  vectors: Map<string, number[]>;
  neighbors: TrajectoryNeighbor[]; // of the reference, cosine-shortlist ranked by euclid
  topK: number; // shortlist size — chance baseline = topK / positionCount
  positionCount: number;
  gapRich: Set<string>; // positions with ≥ RETRIEVAL_MIN_GAPS recent gaps in RETRIEVAL_RULES
}

/** Compute every position's trajectory as of $h from its own event history +
 *  computed gaps, write it back, shortlist by vector similarity (topK 10) and
 *  store SIMILAR_TRAJECTORY — replaced on each run. One group in the drawer. */
export async function computeTrajectories(
  referenceId: string,
  asOf: string = AS_OF_DEFAULT,
): Promise<TrajectoryResult> {
  return withGroup(`Discovery · trajectories as of ${asOf.slice(0, 10)}`, async () => {
    const raw = await runQuery<RawTrajectory>(
      `MATCH (p:Position)
       OPTIONAL MATCH (p)-[:ON_DESK]->(d:Desk)
       CALL (p) {
         MATCH (e:Event {positionId: p.id})
         WHERE e.at < $asOf AND e.at >= $asOf - duration({days: $theta})
           AND [l IN labels(e) WHERE l <> 'Event'][0] IN $labels
         RETURN collect({
           days: duration.inDays(e.at, $asOf).days,
           label: [l IN labels(e) WHERE l <> 'Event'][0],
           role: [(e)-[:PERFORMED_BY|APPROVED_BY]->(w:Person) | w.role][0]
         }) AS events
       }
       CALL (p) {
         MATCH (g:GovernanceGap {abstract: false, positionId: p.id})
         WHERE g.dueBy < $asOf AND g.dueBy >= $asOf - duration({days: $theta})
         RETURN collect({days: duration.inDays(g.dueBy, $asOf).days, ruleId: g.ruleId}) AS gaps
       }
       RETURN p.id AS positionId, d.id AS desk, events, gaps`,
      { asOf: neoDateTime(asOf), theta: TRAJECTORY_PARAMS.theta, labels: TRAJECTORY_EVENT_LABELS },
    );

    // global atom set → identity basis (every dimension nameable)
    const atomSet = new Set<string>();
    for (const r of raw) {
      if (r.desk) atomSet.add(r.desk);
      for (const e of r.events) {
        atomSet.add(e.label);
        if (e.role) atomSet.add(e.role);
      }
      for (const g of r.gaps) atomSet.add(g.ruleId);
    }
    const atoms = [...atomSet].sort();

    const vectors = new Map<string, number[]>();
    for (const r of raw) {
      const events: FpEvent[] = [
        ...r.events.map((e) => ({
          elapsed: e.days,
          atoms: [e.label, ...(e.role ? [e.role] : []), ...(r.desk ? [r.desk] : [])],
        })),
        ...r.gaps.map((g) => ({ elapsed: g.days, atoms: [g.ruleId] })),
      ];
      const v = baseEmbedding(events, atoms, TRAJECTORY_PARAMS);
      if (v.some((x) => x !== 0)) vectors.set(r.positionId, v);
    }

    // write back + project + similarity shortlist (cosine, topK 10)
    await runQuery(
      `UNWIND $rows AS r MATCH (p:Position {id: r.id}) SET p.trajectory = r.v`,
      { rows: [...vectors.entries()].map(([id, v]) => ({ id, v })) },
    );
    await runQuery(`CALL gds.graph.drop('disc_traj', false) YIELD graphName RETURN graphName`);
    await runQuery(
      `MATCH (p:Position) WHERE p.trajectory IS NOT NULL
       WITH gds.graph.project('disc_traj', p, null,
              {sourceNodeProperties: {trajectory: p.trajectory}, targetNodeProperties: {}}) AS g
       RETURN g.nodeCount AS nodes`,
    );
    const knn = await runQuery<{ a: string; b: string; cosine: number }>(
      `CALL gds.knn.stream('disc_traj', {topK: 10,
         nodeProperties: [{trajectory: 'COSINE'}]})
       YIELD node1, node2, similarity
       RETURN gds.util.asNode(node1).id AS a, gds.util.asNode(node2).id AS b,
              similarity AS cosine`,
    );
    await runQuery(`CALL gds.graph.drop('disc_traj', false) YIELD graphName RETURN graphName`);

    const pairs = knn.map((r) => ({
      ...r,
      euclid: euclidean(vectors.get(r.a) ?? [], vectors.get(r.b) ?? []),
    }));
    await runQuery(`MATCH ()-[r:SIMILAR_TRAJECTORY]->() DELETE r`);
    await runQuery(
      `UNWIND $rows AS r
       MATCH (a:Position {id: r.a}) MATCH (b:Position {id: r.b})
       CREATE (a)-[s:SIMILAR_TRAJECTORY]->(b)
       SET s.cosine = r.cosine, s.euclid = r.euclid, s.asOf = $asOf`,
      { rows: pairs, asOf: neoDateTime(asOf) },
    );

    // the reference's shortlist: cosine top-10, RANKED by euclidean distance
    // (magnitude — how fast the gaps accumulate — on top of the shape)
    const refV = vectors.get(referenceId) ?? [];
    const neighbors = pairs
      .filter((r) => r.a === referenceId)
      .sort((x, y) => x.euclid - y.euclid)
      .map((r) => {
        const v = vectors.get(r.b) ?? [];
        const contrib = v
          .map((x, k) => ({ k, c: x * (refV[k] ?? 0), weight: x }))
          .filter((d) => d.c > 0)
          .sort((x, y) => y.c - x.c)
          .slice(0, 3)
          .map((d) => ({
            atom: atoms[Math.floor(d.k / TRAJECTORY_PARAMS.gridPoints)],
            gridIndex: d.k % TRAJECTORY_PARAMS.gridPoints,
            weight: d.weight,
          }));
        return { positionId: r.b, cosine: r.cosine, euclid: r.euclid, topDims: contrib };
      });

    const step = TRAJECTORY_PARAMS.theta / (TRAJECTORY_PARAMS.gridPoints - 1);
    return {
      atoms,
      gridDays: Array.from({ length: TRAJECTORY_PARAMS.gridPoints }, (_, i) => Math.round(i * step)),
      vectors,
      neighbors,
      topK: 10,
      positionCount: vectors.size,
      gapRich: new Set(
        raw
          .filter(
            (r) =>
              r.gaps.filter((g) => (RETRIEVAL_RULES as readonly string[]).includes(g.ruleId)).length >=
              RETRIEVAL_MIN_GAPS,
          )
          .map((r) => r.positionId),
      ),
    };
  });
}

export interface GapHoldout {
  positionId: string;
  ruleId: string;
  removedLabel: string;
  removedEventIds: string[];
}

export async function fetchGapHoldout(): Promise<GapHoldout[]> {
  try {
    const resp = await fetch("/data/holdout_gaps.json");
    return resp.ok ? await resp.json() : [];
  } catch {
    return [];
  }
}

/** Output button — the neighbour lands in the S4 watchlist, audit-logged. */
export async function addToWatchlist(positionId: string, referenceId: string, asOf: string): Promise<void> {
  await withGroup(`Discovery · watchlist + ${positionId}`, () =>
    runQuery(
      `MATCH (p:Position {id: $pid})
       MERGE (w:WatchlistEntry {id: 'WL-' + $pid})
       SET w.reason = 'trajectory similar to ' + $ref + ' as of ' + $asOf,
           w.addedAt = datetime()
       MERGE (w)-[:WATCHES]->(p)`,
      { pid: positionId, ref: referenceId, asOf: asOf.slice(0, 10) },
    ),
  );
}

export interface WatchlistRow {
  positionId: string;
  reason: string;
  addedAt: string;
}

export async function fetchWatchlist(): Promise<WatchlistRow[]> {
  return runQuery<WatchlistRow>(
    `MATCH (w:WatchlistEntry)-[:WATCHES]->(p:Position)
     RETURN p.id AS positionId, w.reason AS reason, toString(w.addedAt) AS addedAt
     ORDER BY w.addedAt DESC`,
  );
}

// ── Panel 3 · Peer decorrelation ─────────────────────────────────────────────
// MIRROR of scripts/discovery_signals.py — keep compute logic and Cypher texts
// byte-consistent (like the companion cache key): the tests prove the Python,
// the app runs this.

export interface DecorrParams {
  windowWeeks: number;
  threshold: number;
  periods: number;
  clusterMin: number; // CORRELATES_WITH edges below this stay out of the peer clusters
}

export const DECORR_DEFAULTS: DecorrParams = { windowWeeks: 8, threshold: 0.45, periods: 2, clusterMin: 0.5 };
const MIN_PEERS = 3;

const FETCH_MARKS = `
MATCH (m:Mark) WHERE m.at <= $asOf
RETURN m.positionId AS pid, left(toString(m.at), 10) AS d, m.clean AS clean
ORDER BY pid, m.at`;

const FETCH_GROUPS = `
MATCH (p:Position)-[:HAS_RISK_ATTRIBUTE]->(ra:RiskAttribute)
WHERE ra.type IN ['methodologyFamily', 'liquidityTier']
WITH p, ra ORDER BY ra.type
RETURN p.id AS pid, reduce(s = '', v IN collect(ra.value) | s + '|' + v) AS grp`;

const WRITE_SIGNALS = `
UNWIND $signals AS s
MATCH (p:Position {id: s.positionId})
CREATE (ds:DecorrelationSignal:Event {id: 'DS-' + s.positionId})
SET ds.at = datetime(s.at + 'T17:00:00Z'), ds.positionId = s.positionId,
    ds.correlation = s.correlation, ds.peerGroup = s.peerGroup,
    ds.windowWeeks = $window, ds.threshold = $threshold
CREATE (p)-[:GENERATED_SIGNAL]->(ds)`;

function pearsonCorr(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx <= 0 || syy <= 0) return 0; // frozen marks do not correlate with anything
  return sxy / Math.sqrt(sxx * syy);
}

export interface DecorrSignal {
  positionId: string;
  at: string;
  correlation: number;
  peerGroup: string;
}

/** 1:1 mirror of discovery_signals.compute_signals. */
export function computeSignalsFromSeries(
  marks: Map<string, [string, number][]>,
  groups: Map<string, string>,
  p: DecorrParams,
): DecorrSignal[] {
  const returns = new Map<string, Map<string, number>>();
  for (const [pid, series] of marks) {
    const r = new Map<string, number>();
    for (let i = 1; i < series.length; i++) {
      const [, v0] = series[i - 1];
      const [d1, v1] = series[i];
      if (v0 > 0 && v1 > 0) r.set(d1, Math.log(v1 / v0));
    }
    returns.set(pid, r);
  }
  const groupAcc = new Map<string, Map<string, [number, number]>>();
  for (const [pid, g] of groups) {
    const r = returns.get(pid);
    if (!r) continue;
    const acc = groupAcc.get(g) ?? new Map<string, [number, number]>();
    for (const [d0, v] of r) {
      const [s, c] = acc.get(d0) ?? [0, 0];
      acc.set(d0, [s + v, c + 1]);
    }
    groupAcc.set(g, acc);
  }
  const signals: DecorrSignal[] = [];
  for (const pid of [...returns.keys()].sort()) {
    const g = groups.get(pid);
    if (!g) continue;
    const acc = groupAcc.get(g) ?? new Map();
    const own = returns.get(pid)!;
    const dates = [...own.keys()].sort();
    let streak = 0;
    let firstBreach: [string, number] | null = null;
    for (let i = p.windowWeeks - 1; i < dates.length; i++) {
      const win = dates.slice(i - p.windowWeeks + 1, i + 1);
      const xs: number[] = [];
      const ys: number[] = [];
      for (const d0 of win) {
        const [s, c] = acc.get(d0) ?? [0, 0];
        if (c - 1 >= MIN_PEERS) {
          xs.push(own.get(d0)!);
          ys.push((s - own.get(d0)!) / (c - 1));
        }
      }
      if (xs.length < p.windowWeeks) {
        streak = 0;
        firstBreach = null;
        continue;
      }
      const corr = pearsonCorr(xs, ys);
      if (corr !== null && corr < p.threshold) {
        if (streak === 0) firstBreach = [dates[i], corr];
        streak += 1;
        if (streak >= p.periods && firstBreach) {
          signals.push({
            positionId: pid,
            at: firstBreach[0],
            correlation: Math.round(firstBreach[1] * 1e4) / 1e4,
            peerGroup: g,
          });
          break;
        }
      } else {
        streak = 0;
        firstBreach = null;
      }
    }
  }
  return signals;
}

export interface DecorrResult {
  signals: DecorrSignal[];
  clusters: { id: number; members: string[] }[];
  positionCount: number;
}

/** Compute the marks' peer correlations as of $h: writes the
 *  :DecorrelationSignal events (PositionTimeline markers), CORRELATES_WITH
 *  relationships and the peer clusters — all replaced on each run. */
export async function computeDecorrelation(
  asOf: string = AS_OF_DEFAULT,
  p: DecorrParams = DECORR_DEFAULTS,
): Promise<DecorrResult> {
  return withGroup(`Discovery · peer decorrelation as of ${asOf.slice(0, 10)}`, async () => {
    const markRows = await runQuery<{ pid: string; d: string; clean: number }>(FETCH_MARKS, {
      asOf: neoDateTime(asOf),
    });
    const marks = new Map<string, [string, number][]>();
    for (const r of markRows) marks.set(r.pid, [...(marks.get(r.pid) ?? []), [r.d, r.clean]]);
    const groupRows = await runQuery<{ pid: string; grp: string }>(FETCH_GROUPS);
    const groups = new Map(groupRows.map((r) => [r.pid, r.grp]));

    const signals = computeSignalsFromSeries(marks, groups, p);
    await runQuery(`MATCH (ds:DecorrelationSignal) DETACH DELETE ds`);
    await runQuery(WRITE_SIGNALS, { signals, window: p.windowWeeks, threshold: p.threshold });

    // aligned return vectors over the last windowWeeks common dates → PEARSON knn
    const allDates = [...new Set(markRows.map((r) => r.d))].sort();
    const grid = allDates.slice(-p.windowWeeks - 1);
    const vectors: { id: string; v: number[] }[] = [];
    for (const [pid, series] of marks) {
      const byDate = new Map(series);
      const v: number[] = [];
      for (let i = 1; i < grid.length; i++) {
        const a = byDate.get(grid[i - 1]);
        const b = byDate.get(grid[i]);
        if (a && b && a > 0 && b > 0) v.push(Math.log(b / a));
      }
      if (v.length === p.windowWeeks) vectors.push({ id: pid, v });
    }
    await runQuery(`MATCH (p:Position) REMOVE p.markReturns`);
    await runQuery(`UNWIND $rows AS r MATCH (p:Position {id: r.id}) SET p.markReturns = r.v`, {
      rows: vectors,
    });
    await runQuery(`CALL gds.graph.drop('disc_corr', false) YIELD graphName RETURN graphName`);
    await runQuery(
      `MATCH (p:Position) WHERE p.markReturns IS NOT NULL
       WITH gds.graph.project('disc_corr', p, null,
              {sourceNodeProperties: {markReturns: p.markReturns}, targetNodeProperties: {}}) AS g
       RETURN g.nodeCount AS nodes`,
    );
    const knn = await runQuery<{ a: string; b: string; pearson: number }>(
      `CALL gds.knn.stream('disc_corr', {topK: 10, nodeProperties: [{markReturns: 'PEARSON'}]})
       YIELD node1, node2, similarity
       RETURN gds.util.asNode(node1).id AS a, gds.util.asNode(node2).id AS b, similarity AS pearson`,
    );
    await runQuery(`CALL gds.graph.drop('disc_corr', false) YIELD graphName RETURN graphName`);
    await runQuery(`MATCH ()-[r:CORRELATES_WITH]->() DELETE r`);
    await runQuery(
      `UNWIND $rows AS r
       MATCH (a:Position {id: r.a}) MATCH (b:Position {id: r.b})
       CREATE (a)-[c:CORRELATES_WITH]->(b)
       SET c.pearson = r.pearson, c.windowWeeks = $window, c.asOf = $asOf`,
      { rows: knn, window: p.windowWeeks, asOf: neoDateTime(asOf) },
    );

    // peer clusters: community detection over the strong correlation edges
    await runQuery(`CALL gds.graph.drop('disc_corr_cluster', false) YIELD graphName RETURN graphName`);
    await runQuery(
      `MATCH (a:Position)-[r:CORRELATES_WITH]->(b:Position)
       WHERE r.pearson >= $min
       WITH a, b, r.pearson AS w
       WITH gds.graph.project('disc_corr_cluster', a, b,
              {relationshipProperties: {w: w}}, {undirectedRelationshipTypes: ['*']}) AS g
       RETURN g.nodeCount AS nodes`,
      { min: p.clusterMin },
    );
    const clusterRows = await runQuery<{ pid: string; community: number }>(
      `CALL gds.louvain.stream('disc_corr_cluster', {relationshipWeightProperty: 'w'})
       YIELD nodeId, communityId
       RETURN gds.util.asNode(nodeId).id AS pid, communityId AS community`,
    );
    await runQuery(`CALL gds.graph.drop('disc_corr_cluster', false) YIELD graphName RETURN graphName`);
    const byCommunity = new Map<number, string[]>();
    for (const r of clusterRows) byCommunity.set(r.community, [...(byCommunity.get(r.community) ?? []), r.pid]);
    const clusters = [...byCommunity.entries()]
      .map(([id, members]) => ({ id, members: members.sort() }))
      .filter((c) => c.members.length >= 2)
      .sort((a, b) => b.members.length - a.members.length);

    return { signals, clusters, positionCount: marks.size };
  });
}

/** Output button — R10 into the Policy panel and the gap query's (inert) branch.
 *  Keep these properties in sync with tests/test_discovery.py CREATE_R10. */
export async function addRuleR10(p: DecorrParams = DECORR_DEFAULTS): Promise<void> {
  await withGroup("Discovery · add rule R10 (peer decorrelation resolution)", () =>
    runQuery(
      `MERGE (o:ControlObligation {id: 'R10'})
       SET o.name = 'Peer decorrelation resolution',
           o.status = 'industry practice, not a rule',
           o.severity = 'medium', o.timing = 'AFTER', o.slaDays = 30,
           o.triggerEvent = 'DecorrelationSignal',
           o.requiredControl = 'Pre-approved MethodologyChange effective around the signal OR IPVReview within slaDays that ADDRESSES the divergence (adjustment/challenge evidence, or outcome adjusted|challenged|explained)',
           o.requiredByRole = 'Desk head + IPV',
           o.gapDefinition = 'DecorrelationSignal with neither an approved methodology change nor an IPV review that addressed it — a review that merely occurred does not count',
           o.paramsJson = '{"windowWeeks": ' + toString($w) + ', "decorrThreshold": ' + toString($t)
             + ', "decorrPeriods": ' + toString($n) + '}',
           o.defaultParamsJson = o.paramsJson`,
      { w: p.windowWeeks, t: p.threshold, n: p.periods },
    ),
  );
}

/** Second output button — the peer clusters become instrument-agnostic
 *  :RiskAttribute nodes S3/S4 can match on. Discovery Reset removes them. */
export async function addBehaviourClusterAttributes(
  clusters: { id: number; members: string[] }[],
): Promise<number> {
  return withGroup("Discovery · behaviour clusters as risk attributes", async () => {
    let written = 0;
    for (const c of clusters) {
      await runQuery(
        `MERGE (ra:RiskAttribute {id: 'RA-behaviourCluster-cluster-' + toString($id)})
         SET ra.type = 'behaviourCluster', ra.value = 'cluster-' + toString($id),
             ra.provenance = 'Discovery — peer decorrelation (market-derived, instrument-agnostic)'
         WITH ra
         UNWIND $members AS pid
         MATCH (p:Position {id: pid})
         MERGE (p)-[:HAS_RISK_ATTRIBUTE]->(ra)`,
        { id: c.id, members: c.members },
      );
      written += 1;
    }
    return written;
  });
}

/** Output button — a CANDIDATE obligation into the Policy panel. No gap-query
 *  branch evaluates it: candidate = hypothesis found by structure, not a rule. */
export async function proposeApprovalCircleRule(communityResolution = 1.0): Promise<void> {
  await withGroup("Discovery · propose candidate rule R-C1", () =>
    runQuery(
      `MERGE (o:ControlObligation {id: 'R-C1'})
       SET o.name = 'Approval circles',
           o.status = 'candidate — found by structure, not validated',
           o.severity = 'candidate', o.timing = 'STRUCTURAL', o.slaDays = 0,
           o.triggerEvent = 'Approval',
           o.requiredControl = 'approver from outside the approval community of the owner',
           o.requiredByRole = 'independent function',
           o.gapDefinition = 'approver and owner in the same approval community',
           o.communityResolution = $res,
           o.paramsJson = '{"communityResolution": ' + toString($res) + '}',
           o.defaultParamsJson = '{"communityResolution": ' + toString($res) + '}'`,
      { res: communityResolution },
    ),
  );
}
