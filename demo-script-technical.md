# Fraudulent valuation — under the hood
## Technical cut (`make video-technical` → `dist/demo-technical.mp4`)

Audience: the customer's technical team and FinCrime colleagues — people who
want to see the engine. Fully deterministic: no LLM scene. Technical vocabulary
is allowed and expected here (the `vocabulary:` allow-list below lifts the
executive gate); **"prediction" and "alert" stay banned in every cut**. Every
heavy computation is fast-forwarded with a labelled badge; the audit drawer is
on screen (zoomed) wherever a query is discussed. The executive cut
(`demo-script.md` → `dist/demo.mp4`) is untouched.

```scene-config
title: Fraudulent valuation — under the hood
subtitle: One gap query, patterns as data, structure-driven analysis — every claim one click from its Cypher.
output: demo-technical
vocabulary: GDS, Louvain, kNN, Pearson, embedding, FastPath, Cypher, MCP, algorithm
```

```scene
id: tech-cold-open
before: database loaded (make load); dev server up; Explore tab.
actions: schema peek on each of the three layers (market, governance, cases); open the audit drawer on the peek queries.
shot: the cases-layer mini-schema + sample; the drawer open with the live Cypher.
narration: Three layers in one graph. Market is real — public TRACE prints,
  regulator liquidity flags, Treasury curves. Governance is generated from nine
  control obligations with a per-desk compliance rate, and the two cases are
  injected event by event from the public record. Every peek you just saw is a
  live Cypher query, and it is already in the drawer.
```

```scene
id: tech-policy-provenance
before: cold open done.
actions: Scenarios → Policy; frame the nine rules; hover a Source label (verbatim quote + link to docs/rules-provenance.md).
shot: the policy grid; one provenance tooltip open.
narration: The nine rules are data on ControlObligation nodes — placeholders, to
  be replaced by the institution's thresholds. Each carries the public text it
  echoes, quoted and linked in the provenance doc. Editing a parameter here
  changes the next run of one file: data slash gap underscore query dot cypher.
```

```scene
id: tech-gap-branches
before: the Policy step on screen.
actions: Compute governance gaps (fast-forwarded); frame the counts; open the drawer on the Compute group — the gap query text on screen, zoomed.
shot: the MET/LATE/MISSED counts, then the UNION branches in the drawer.
narration: One parameterised query, one UNION branch per rule family. Temporal
  branches check an SLA window after a trigger; the periodic branch walks review
  calendars; the structural branches test pure graph shape — same-desk approval,
  missing evidence. Thresholds are read off the nodes at run time, so the Policy
  panel edits the query's behaviour without touching its text.
```

```scene
id: tech-s2-engine
before: gaps computed.
actions: S2 → Reconstruct POS-TP; click a timeline marker (popover: the three prices); open the drawer on the QPP chain query.
shot: the marker popover with traderMark / modelPrice / ipvPrice; then the QPP Cypher.
narration: Every marker carries three prices written on the event node itself —
  trader mark, model price, IPV price — so the popover reads the graph, it never
  recomputes. The chronology behind it is a quantified path pattern over the
  per-position NEXT chain, and the R five row is the one to remember: the review
  executed and upheld the marks. Executed is not effective.
```

```scene
id: tech-pattern-node
before: S2 on screen.
actions: S3 → Abstract the confirmed case; frame the Pattern node and its REQUIRES edges; drawer on the extraction query.
shot: the Pattern star in the graph view; the MERGE/REQUIRES Cypher.
narration: The pattern is a node. Its extraction can only traverse two edge
  types — risk attributes, and concrete gaps hopped up to their abstract
  classes — so instrument identity, dates and people are unreachable by
  construction, not by convention. Discarded, not hidden.
```

```scene
id: tech-matching-query
before: the pattern exists.
actions: S4 → Run read-across; drawer on the scoring query; close; drop the same-desk gap condition (set widens), restore it.
shot: the scoring Cypher; then the editor chips and the re-ranking table.
narration: Matching is counting satisfied REQUIRES per position — adjacency on
  shared attribute and gap-class nodes, no fan-out from attribute hubs, no joins
  that grow with the condition count. Drop the same-desk condition and the set
  widens; restore it and it tightens. The pattern library grows by adding rows.
```

```scene
id: tech-discovery-open
before: executive scenarios done.
actions: Technical toggle on; open the Discovery tab; frame the sub-header.
shot: the Discovery tab, sub-header centred.
narration: Behind the Technical toggle sits Discovery. Rules find what you
  described; structure finds what you didn't; then structure becomes a rule.
  Everything here runs through the same audited query path, and a reset removes
  every write.
```

```scene
id: tech-circles
before: Discovery open.
actions: Find approval circles (fast-forwarded); drawer on the projection + Louvain stream; Propose as rule → R-C1 badged in Policy; open the explainer, page to the modularity slide, close.
shot: coloured circles + the closed CIO circle; the projection Cypher; R-C1 as candidate; the modularity formula.
narration: A weighted person-to-person projection — who approves whose
  overrides — and a Louvain pass over it. The closed circle on the CIO book falls
  out with no rule describing it. On synthetic data the structure finds what the
  generator planted. On your data it finds what you did not plant — which is why
  the output is a candidate rule, not a finding.
```

```scene
id: tech-trajectories
before: Discovery open.
actions: Compare trajectories (fast-forwarded); frame the fingerprint heatmaps and the evaluation line; open the explainer to the published worked-example slide; close; Add to watchlist → the S4 receiver row.
shot: two atom-by-time-band heatmaps; the retrieval + holdout lines; the worked-example table; the watchlist row with provenance.
narration: Each position's history becomes a FastPath embedding over an identity
  basis, so every dimension has a name and similarity reads in words. It is a
  reimplementation of the published algorithm, tested against the published
  example; not available self-managed before twenty-twenty-seven. The evaluation
  is on screen: held out at generation; recall stated with its sample size; a
  hypothesis, not evidence.
```

```scene
id: tech-decorrelation
before: Discovery open.
actions: Compute peer correlations (fast-forwarded); drawer on the Mark fetch + Pearson kNN; the 5-row table (2 MISSED); Add as rule R10 → inline verdicts; explainer step "why the IPV ran is not a control"; behaviour clusters; then POS-TP's ▼ marker between its overrides in S2 and the new attributes in Explore's counters.
shot: the signals table; the ▼ on the timeline inside the override series; the R10 verdicts; the clusters landing as attributes.
narration: Weekly trader marks, log returns, a rolling Pearson against the
  attribute peers, kNN for the behaviour clusters. Five books decorrelate — and
  the same gap query separates them: the case and the near-miss stay broken, the
  explained ones are met, because R ten demands a review that addresses the
  divergence, not one that merely occurs. The signal is dated at the first
  breach, inside the override series it detects.
```

```scene
id: tech-reset
before: Discovery outputs written (R-C1, R10, signals, watchlist, clusters).
actions: Reset Discovery; then the real test output as an overlay (pytest test_no_gds_executive).
shot: the reset note; the terminal overlay with the passing test line.
narration: Reset removes every Discovery write — candidate rules, signals,
  watchlist, clusters, relationships — and the executive flow was never touched:
  no GDS procedure is called anywhere in the executive flow — enforced by a
  test. This is the line that proves it, run just now.
```

```scene
id: tech-mcp-close
before: Discovery reset done.
actions: a real MCP tool call (expected_controls on POS-TP) rendered as a terminal overlay; then end on the open audit drawer.
shot: the tool-call JSON; the audit drawer as the closing frame.
narration: The same typed tools the assistant composes are exposed over MCP —
  here is one real call, the broken controls of the case, straight from the gap
  query. The graph does not detect fraud. It detects the shape fraud leaves
  behind — a human establishes intent. And every claim you saw tonight is one
  click from its Cypher, in this drawer.
```
