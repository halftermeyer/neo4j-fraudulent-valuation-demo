// ═══════════════════════════════════════════════════════════════════════════
// GAP QUERY — single source of truth (DECISIONS.md #9)
// Expected-vs-observed evaluation of every :ControlObligation against every
// :Position. Semantics of each branch come from the `gap_definition` column of
// inputs/control_obligations.csv. All thresholds/SLAs/windows are read from
// the ControlObligation node (edited live by the Policy panel) — no literal
// threshold appears below.
//
// Parameters (always pass all three; use null to mean "all"/"default"):
//   $positionId  string | null
//   $ruleId      string | null
//   $asOf        datetime | null  (callers default it to dataset clock end 2023-01-01)
//
// Returns one row per (obligation × trigger) evaluation:
//   status: 'MET' | 'LATE' | 'MISSED' | 'PENDING'
// A *gap* is a row with status MISSED or LATE. PENDING = SLA not yet expired
// at $asOf (the early-detection nuance shown in S2).
//
// Consumed verbatim by src/lib/queries.ts (?raw import), mcp_server.py and
// tests/. GovernanceGap materialisation wraps this same text (materialise_gaps.cypher).
// ═══════════════════════════════════════════════════════════════════════════

// ── R1 · Methodology pre-approval (BEFORE) ──────────────────────────────────
// "MethodologyChange with no Approval, or Approval.at > MethodologyChange.effectiveAt"
MATCH (o:ControlObligation {id: 'R1'})
WHERE $ruleId IS NULL OR $ruleId = o.id
MATCH (p:Position)-[:CHANGED_TO]->(mc:MethodologyChange)
WHERE ($positionId IS NULL OR p.id = $positionId) AND mc.at <= $asOf
WITH o, p, mc, coalesce(mc.effectiveAt, mc.at) AS effAt
OPTIONAL MATCH (mc)-[:APPROVED_BY]->(a:Approval)
WITH o, p, mc, effAt, a ORDER BY a.at
WITH o, p, mc, effAt, collect(a) AS approvals
WITH o, p, mc, effAt, approvals, [x IN approvals WHERE x.at <= effAt] AS prior
WITH o, p, mc, effAt,
     CASE WHEN size(prior) > 0 THEN 'MET'
          WHEN size(approvals) > 0 THEN 'LATE'
          ELSE 'MISSED' END AS status,
     coalesce(head(prior), head(approvals)) AS obs
RETURN o.id AS ruleId, o.name AS ruleName, o.severity AS severity,
       o.requiredControl AS expectedControl, o.requiredByRole AS requiredByRole,
       p.id AS positionId, mc.id AS triggerEventId, mc.at AS triggerAt,
       'MethodologyChange' AS triggerLabel, effAt AS dueBy,
       obs.id AS observedEventId, obs.at AS observedAt, status

UNION ALL

// ── R2 · Post-change IPV (AFTER, slaDays) ───────────────────────────────────
// "No IPVReview on the Position within slaDays after MethodologyChange.effectiveAt"
MATCH (o:ControlObligation {id: 'R2'})
WHERE $ruleId IS NULL OR $ruleId = o.id
MATCH (p:Position)-[:CHANGED_TO]->(mc:MethodologyChange)
WHERE ($positionId IS NULL OR p.id = $positionId) AND mc.at <= $asOf
WITH o, p, mc, coalesce(mc.effectiveAt, mc.at) AS effAt
WITH o, p, mc, effAt, effAt + duration({days: o.slaDays}) AS dueBy
OPTIONAL MATCH (p)-[:REVIEWED_BY]->(ipv:IPVReview)
WHERE ipv.at > effAt AND ipv.at <= $asOf
WITH o, p, mc, dueBy, ipv ORDER BY ipv.at
WITH o, p, mc, dueBy, collect(ipv) AS reviews
WITH o, p, mc, dueBy, reviews, [x IN reviews WHERE x.at <= dueBy] AS within
WITH o, p, mc, dueBy,
     CASE WHEN size(within) > 0 THEN 'MET'
          WHEN size(reviews) > 0 THEN 'LATE'
          WHEN dueBy > $asOf THEN 'PENDING'
          ELSE 'MISSED' END AS status,
     coalesce(head(within), head(reviews)) AS obs
RETURN o.id AS ruleId, o.name AS ruleName, o.severity AS severity,
       o.requiredControl AS expectedControl, o.requiredByRole AS requiredByRole,
       p.id AS positionId, mc.id AS triggerEventId, mc.at AS triggerAt,
       'MethodologyChange' AS triggerLabel, dueBy,
       obs.id AS observedEventId, obs.at AS observedAt, status

UNION ALL

// ── R3 · Override beyond tolerance (AFTER, slaDays) ─────────────────────────
// "PriceOverride above threshold without Approval within sla, or Approval
//  without IPV challenge"
MATCH (o:ControlObligation {id: 'R3'})
WHERE $ruleId IS NULL OR $ruleId = o.id
MATCH (p:Position)-[:OVERRIDDEN_BY]->(po:PriceOverride)
WHERE ($positionId IS NULL OR p.id = $positionId) AND po.at <= $asOf
  AND (po.deviationBps > o.thresholdBps
       OR coalesce(po.pctOfBidAsk, 0) > o.pctOfBidAsk)
WITH o, p, po, po.at + duration({days: o.slaDays}) AS dueBy
OPTIONAL MATCH (po)-[:APPROVED_BY]->(a:Approval)
WITH o, p, po, dueBy, a ORDER BY a.at
WITH o, p, po, dueBy, collect(a) AS approvals,
     EXISTS { (po)-[:CHALLENGED_BY]->(:IPVReview) } AS challenged
WITH o, p, po, dueBy, approvals, challenged,
     [x IN approvals WHERE x.at <= dueBy] AS within
WITH o, p, po, dueBy,
     CASE WHEN size(within) > 0 AND challenged THEN 'MET'
          WHEN size(approvals) > 0 AND challenged THEN 'LATE'
          WHEN dueBy > $asOf AND challenged THEN 'PENDING'
          ELSE 'MISSED' END AS status,
     coalesce(head(within), head(approvals)) AS obs
RETURN o.id AS ruleId, o.name AS ruleName, o.severity AS severity,
       o.requiredControl AS expectedControl, o.requiredByRole AS requiredByRole,
       p.id AS positionId, po.id AS triggerEventId, po.at AS triggerAt,
       'PriceOverride' AS triggerLabel, dueBy,
       obs.id AS observedEventId, obs.at AS observedAt, status

UNION ALL

// ── R4 · Recurring overrides (AFTER, n within windowDays) ───────────────────
// "Nth override in window with no Escalation within sla"
MATCH (o:ControlObligation {id: 'R4'})
WHERE $ruleId IS NULL OR $ruleId = o.id
MATCH (p:Position)-[:OVERRIDDEN_BY]->(po:PriceOverride)
WHERE ($positionId IS NULL OR p.id = $positionId) AND po.at <= $asOf
WITH o, p, po,
     COUNT { MATCH (p)-[:OVERRIDDEN_BY]->(x:PriceOverride)
             WHERE x.at <= po.at AND x.at > po.at - duration({days: o.windowDays}) } AS cnt
WHERE cnt >= o.n
WITH o, p, po, po.at + duration({days: o.slaDays}) AS dueBy
WITH o, p, po, dueBy,
     (EXISTS { MATCH (p)-[:OVERRIDDEN_BY]->(:PriceOverride)-[:ESCALATED_TO]->(e:Escalation)
               WHERE e.at >= po.at - duration({days: o.windowDays}) AND e.at <= dueBy }
      OR EXISTS { MATCH (p)-[:ESCALATED_TO]->(e:Escalation)
                  WHERE e.at >= po.at - duration({days: o.windowDays}) AND e.at <= dueBy }) AS escalated
WITH o, p, po, dueBy,
     CASE WHEN escalated THEN 'MET'
          WHEN dueBy > $asOf THEN 'PENDING'
          ELSE 'MISSED' END AS status
ORDER BY po.at
WITH o, p, collect({poId: po.id, poAt: po.at, dueBy: dueBy, status: status}) AS rows
WITH o, p,
     coalesce(head([r IN rows WHERE r.status IN ['MISSED', 'LATE']]), head(rows)) AS r
RETURN o.id AS ruleId, o.name AS ruleName, o.severity AS severity,
       o.requiredControl AS expectedControl, o.requiredByRole AS requiredByRole,
       p.id AS positionId, r.poId AS triggerEventId, r.poAt AS triggerAt,
       'PriceOverride' AS triggerLabel, r.dueBy AS dueBy,
       null AS observedEventId, null AS observedAt, r.status AS status

UNION ALL

// ── R5 · IPV divergence resolution (AFTER, slaDays) ─────────────────────────
// "IPVReview above threshold followed by neither adjustment Evidence nor
//  challenge nor Escalation within sla"
MATCH (o:ControlObligation {id: 'R5'})
WHERE $ruleId IS NULL OR $ruleId = o.id
MATCH (p:Position)-[:REVIEWED_BY]->(ipv:IPVReview)
WHERE ($positionId IS NULL OR p.id = $positionId) AND ipv.at <= $asOf
  AND ipv.divergenceBps > o.divergenceBps
WITH o, p, ipv, ipv.at + duration({days: o.slaDays}) AS dueBy
WITH o, p, ipv, dueBy,
     (EXISTS { MATCH (ipv)-[:ESCALATED_TO]->(e:Escalation) WHERE e.at <= dueBy }
      OR EXISTS { MATCH (ipv)-[:EVIDENCED_BY]->(:Evidence {type: 'adjustment'}) }
      OR EXISTS { (ipv)-[:CHALLENGED_BY]->() }) AS resolved
WITH o, p, ipv, dueBy,
     CASE WHEN resolved THEN 'MET'
          WHEN dueBy > $asOf THEN 'PENDING'
          ELSE 'MISSED' END AS status
RETURN o.id AS ruleId, o.name AS ruleName, o.severity AS severity,
       o.requiredControl AS expectedControl, o.requiredByRole AS requiredByRole,
       p.id AS positionId, ipv.id AS triggerEventId, ipv.at AS triggerAt,
       'IPVReview' AS triggerLabel, dueBy,
       null AS observedEventId, null AS observedAt, status

UNION ALL

// ── R6 · Persistent unexplained P&L (AFTER, slaDays) ────────────────────────
// "Persistent PnLSignal with no attribution Control recorded within sla"
MATCH (o:ControlObligation {id: 'R6'})
WHERE $ruleId IS NULL OR $ruleId = o.id
MATCH (p:Position)-[:GENERATED_SIGNAL]->(s:PnLSignal)
WHERE ($positionId IS NULL OR p.id = $positionId) AND s.at <= $asOf
  AND coalesce(s.unexplainedPct, 0) >= o.unexplainedThreshold
  AND coalesce(s.consecutiveDays, 0) >= o.consecutiveDays
WITH o, p, s, s.at + duration({days: o.slaDays}) AS dueBy
OPTIONAL MATCH (p)-[:SUBJECT_TO_CONTROL]->(c:Control {kind: 'attribution'})
WHERE c.at >= s.at AND c.at <= $asOf
WITH o, p, s, dueBy, c ORDER BY c.at
WITH o, p, s, dueBy, collect(c) AS controls
WITH o, p, s, dueBy, controls, [x IN controls WHERE x.at <= dueBy] AS within
WITH o, p, s, dueBy,
     CASE WHEN size(within) > 0 THEN 'MET'
          WHEN size(controls) > 0 THEN 'LATE'
          WHEN dueBy > $asOf THEN 'PENDING'
          ELSE 'MISSED' END AS status,
     coalesce(head(within), head(controls)) AS obs
RETURN o.id AS ruleId, o.name AS ruleName, o.severity AS severity,
       o.requiredControl AS expectedControl, o.requiredByRole AS requiredByRole,
       p.id AS positionId, s.id AS triggerEventId, s.at AS triggerAt,
       'PnLSignal' AS triggerLabel, dueBy,
       obs.id AS observedEventId, obs.at AS observedAt, status

UNION ALL

// ── R7a · Periodic review of illiquids (PERIODIC, periodMonths) ─────────────
// "Illiquid Position with no MAPReview in period"
// Applies to positions active at $asOf, open for at least one full period.
MATCH (o:ControlObligation {id: 'R7'})
WHERE $ruleId IS NULL OR $ruleId = o.id
WITH o, split(o.appliesToAttribute, '=') AS kv
MATCH (p:Position)-[:HAS_RISK_ATTRIBUTE]->(ra:RiskAttribute)
WHERE ra.type = kv[0] AND ra.value = kv[1]
  AND ($positionId IS NULL OR p.id = $positionId)
  AND (p.validTo IS NULL OR p.validTo > $asOf)
  AND p.openedAt <= $asOf - duration({months: o.periodMonths})
OPTIONAL MATCH (p)-[:REVIEWED_BY]->(m:MAPReview)
WHERE m.at <= $asOf AND m.at > $asOf - duration({months: o.periodMonths})
WITH o, p, m ORDER BY m.at DESC
WITH o, p, collect(m) AS inPeriod
WITH o, p, inPeriod,
     CASE WHEN size(inPeriod) > 0 THEN 'MET' ELSE 'MISSED' END AS status,
     head(inPeriod) AS obs
RETURN o.id AS ruleId, o.name AS ruleName, o.severity AS severity,
       o.requiredControl AS expectedControl, o.requiredByRole AS requiredByRole,
       p.id AS positionId, p.id AS triggerEventId, p.openedAt AS triggerAt,
       'Position' AS triggerLabel, $asOf AS dueBy,
       obs.id AS observedEventId, obs.at AS observedAt, status

UNION ALL

// ── R7b · Post-regime-break review (PERIODIC, regimeSlaDays) ────────────────
// "... or no MAPReview within regimeSlaDays after a regime-break event"
MATCH (o:ControlObligation {id: 'R7'})
WHERE $ruleId IS NULL OR $ruleId = o.id
WITH o, split(o.appliesToAttribute, '=') AS kv
MATCH (rb:RegimeBreak) WHERE rb.at <= $asOf
MATCH (p:Position)-[:HAS_RISK_ATTRIBUTE]->(ra:RiskAttribute)
WHERE ra.type = kv[0] AND ra.value = kv[1]
  AND ($positionId IS NULL OR p.id = $positionId)
  AND p.openedAt <= rb.at
  AND (p.validTo IS NULL OR p.validTo > rb.at)
WITH o, p, rb, rb.at + duration({days: o.regimeSlaDays}) AS dueBy
WITH o, p, rb, dueBy,
     EXISTS { MATCH (p)-[:REVIEWED_BY]->(m:MAPReview)
              WHERE m.at > rb.at AND m.at <= dueBy } AS reviewed
WITH o, p, rb, dueBy,
     CASE WHEN reviewed THEN 'MET'
          WHEN dueBy > $asOf THEN 'PENDING'
          ELSE 'MISSED' END AS status
RETURN o.id AS ruleId, o.name AS ruleName, o.severity AS severity,
       o.requiredControl AS expectedControl, o.requiredByRole AS requiredByRole,
       p.id AS positionId, rb.id AS triggerEventId, rb.at AS triggerAt,
       'RegimeBreak' AS triggerLabel, dueBy,
       null AS observedEventId, null AS observedAt, status

UNION ALL

// ── R8 · Segregation of duties (STRUCTURAL) ─────────────────────────────────
// "(a:Approval)-[:APPROVED_BY]->(p) where p OWNS the Position or belongs to
//  the same Desk"
MATCH (o:ControlObligation {id: 'R8'})
WHERE ($ruleId IS NULL OR $ruleId = o.id) AND o.sameDeskAllowed = false
MATCH (p:Position)-[:CHANGED_TO|OVERRIDDEN_BY|GENERATED_SIGNAL|SUBJECT_TO_CONTROL|REVIEWED_BY]->(trig)
      -[:APPROVED_BY]->(a:Approval)-[:APPROVED_BY]->(pr:Person)
WHERE ($positionId IS NULL OR p.id = $positionId) AND a.at <= $asOf
  AND ((p)-[:OWNED_BY]->(pr)
       OR EXISTS { MATCH (pr)-[:ON_DESK]->(:Desk)<-[:ON_DESK]-(p) })
RETURN o.id AS ruleId, o.name AS ruleName, o.severity AS severity,
       o.requiredControl AS expectedControl, o.requiredByRole AS requiredByRole,
       p.id AS positionId, trig.id AS triggerEventId, trig.at AS triggerAt,
       head(labels(trig)) AS triggerLabel, a.at AS dueBy,
       a.id AS observedEventId, a.at AS observedAt, 'MISSED' AS status

UNION ALL

// ── R9 · Documentary evidence (STRUCTURAL) ──────────────────────────────────
// "Approval or Escalation node with no EVIDENCED_BY relationship"
MATCH (o:ControlObligation {id: 'R9'})
WHERE $ruleId IS NULL OR $ruleId = o.id
MATCH (p:Position)
      -[:CHANGED_TO|OVERRIDDEN_BY|GENERATED_SIGNAL|SUBJECT_TO_CONTROL|REVIEWED_BY|ESCALATED_TO|APPROVED_BY*1..2]->(x)
WHERE ($positionId IS NULL OR p.id = $positionId)
  AND (x:Approval OR x:Escalation) AND x.at <= $asOf
  AND NOT EXISTS { MATCH (x)-[:EVIDENCED_BY]->(:Evidence) }
WITH DISTINCT o, p, x
RETURN o.id AS ruleId, o.name AS ruleName, o.severity AS severity,
       o.requiredControl AS expectedControl, o.requiredByRole AS requiredByRole,
       p.id AS positionId, x.id AS triggerEventId, x.at AS triggerAt,
       head(labels(x)) AS triggerLabel, x.at AS dueBy,
       null AS observedEventId, null AS observedAt, 'MISSED' AS status

UNION ALL

// ── R10 · Peer decorrelation resolution (Discovery-proposed) ─────────────────
// "DecorrelationSignal with neither a PRE-APPROVED MethodologyChange effective
//  around it nor an IPVReview within slaDays that ADDRESSES the divergence" —
// a review that merely OCCURS does not count (in the public case the quarter-end
// review occurred and upheld the marks): it must carry an adjustment/challenge
// Evidence or an explicit outcome in ('adjusted','challenged','explained').
// Status 'industry practice, not a rule'. INERT until the Discovery panel
// creates both the R10 obligation and the :DecorrelationSignal events; the
// acceptance sets are untouched without them.
MATCH (o:ControlObligation {id: 'R10'})
WHERE $ruleId IS NULL OR $ruleId = o.id
MATCH (p:Position)-[:GENERATED_SIGNAL]->(ds:DecorrelationSignal)
WHERE ($positionId IS NULL OR p.id = $positionId) AND ds.at <= $asOf
WITH o, p, ds, ds.at + duration({days: o.slaDays}) AS dueBy
WITH o, p, ds, dueBy,
     (EXISTS { MATCH (p)-[:CHANGED_TO]->(mc:MethodologyChange)-[:APPROVED_BY]->(a:Approval)
               WHERE a.at <= coalesce(mc.effectiveAt, mc.at)
                 AND coalesce(mc.effectiveAt, mc.at) >= ds.at - duration({days: o.slaDays})
                 AND coalesce(mc.effectiveAt, mc.at) <= dueBy }
      OR EXISTS { MATCH (p)-[:REVIEWED_BY]->(ipv:IPVReview)
                  WHERE ipv.at >= ds.at AND ipv.at <= dueBy
                    AND (ipv.outcome IN ['adjusted', 'challenged', 'explained']
                         OR EXISTS { MATCH (ipv)-[:EVIDENCED_BY]->(ev:Evidence)
                                     WHERE ev.type IN ['adjustment', 'challenge'] }) }) AS resolved
WITH o, p, ds, dueBy,
     CASE WHEN resolved THEN 'MET'
          WHEN dueBy > $asOf THEN 'PENDING'
          ELSE 'MISSED' END AS status
RETURN o.id AS ruleId, o.name AS ruleName, o.severity AS severity,
       o.requiredControl AS expectedControl, o.requiredByRole AS requiredByRole,
       p.id AS positionId, ds.id AS triggerEventId, ds.at AS triggerAt,
       'DecorrelationSignal' AS triggerLabel, dueBy,
       null AS observedEventId, null AS observedAt, status
