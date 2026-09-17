# Inputs for the neo4j-fraudulent-valuation-demo build

Two CSV files to hand to Claude Code. Both are DATA, not instructions: encode them, do not reinterpret them.

## control_obligations.csv
The normative layer (`:ControlObligation` nodes, mandated by `:Policy`). Nine rules R1–R9.
- `params_json` holds the thresholds that must be editable from the app's Policy panel (default values = placeholders to validate with the customer).
- `gap_definition` is the semantics of the expected-vs-observed query for that rule.
- `default_broken_by_TP` / `default_broken_by_FP`: which rules the public true positive and the deliberate false positive must violate after generation (acceptance test for the generator).

## public_true_positive_2012.csv
19 dated events reconstructing a well-documented public mismarking case (2012, US bank CIO synthetic credit portfolio), mapped to the BNP data model.
- `event_label` = node label to create; `graph_pattern` = the relationships to create (hint, Cypher-like).
- `rules_broken` = which ControlObligations this event violates (must match the gap query output).
- `date_precision`: `day` = exact date from the source; `month` = place anywhere in that month.
- `confidence`: `high` = date and figure taken from a primary source (Senate PSI report/hearing record, JPM SEC filings, SEC press release); `medium` = from the same sources but the exact date is a window, not a day.
- `actor_role`: use ROLES in the demo, never real names.
- Instrument identity: do not use the real portfolio name in the UI; attach these events to a synthetic illiquid position of the same shape (long-dated, dealer-quoted, wide bid-ask). Keep the source column for the audit drawer / demo script only.

Primary sources (for the demo-script bibliography, not for the UI):
- US Senate PSI, "JPMorgan Chase Whale Trades: A Case History of Derivatives Risks and Abuses", report 15 Mar 2013 + hearing exhibits.
- JPMorgan Chase 10-Q (Q2, Q3 2012), 10-K 2012, 8-K 13 Jul 2012.
- SEC press release 2013-154 (14 Aug 2013).
