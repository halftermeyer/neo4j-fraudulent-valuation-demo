# Data-layer plan — fraudulent-valuation (mismarking) demo

Status: **APPROVED** (with amendments: R8 wired to seq-6 desk-head approval; R7 anchor MAPReview on POS-TP; unified demo clock via `TP_CLOCK_OFFSET_YEARS`). See DECISIONS.md.
Verified environment: Neo4j 2026.05.0 Enterprise at `bolt://127.0.0.1:7687`, database `mismarking` (online), GDS 2026.05.0, APOC 2026.05.0, credentials from `inputs/.env`.

---

## 1. Layer 1 — Instruments & prices (REAL public data)

### 1.1 OSBAP file selection
- **File**: `stage1_osbap_0k_volume_2025.zip` from https://openbondassetpricing.com/wp-content/uploads/2025/12/ (~1.83 GB, direct-download confirmed, zipped parquet, daily TRACE panel 2002–present, build 2025-12-11). It is the only OSBAP file that is daily **and** includes 144A (`db_type == 3`; 1 = Enhanced, 2 = Standard).
- Cached at `data/cache/osbap/` — downloaded once by `scripts/download_data.py`, checksum-guarded, never touched at demo time. Read with pyarrow predicate pushdown on `trd_exctn_dt` (2021-01-01 → 2022-12-31) so we never hold 23 years of panel in memory.

### 1.2 Selection filters (bond universe)
Applied in `generate_data.py`, in order:
1. **Window**: at least one trade in 2021-H1 **and** at least one in 2022-H2 (alive across the 2022 rate shock).
2. **Illiquidity** (prompt: "144A and/or <5% days traded"): keep bonds where `db_type == 3` **or** `pctDaysTraded < 5%` (distinct trade days / ~502 trading days — the panel only has rows on traded days, so this is computed, not a column).
3. **Defaults**: flag the subset whose composite rating (`comp_rating`) reaches default territory or whose price collapses below 30% of par during 2022 — keep a handful (5–10) in the universe as the "went through default" bonds.
4. **Cap**: rank by data quality (trade_count, presence of `prc_bid`/`prc_ask`) and cap at **~3,000 instruments**.

Per-instrument fields carried into the graph: `cusip_id` (key), coupon, `bond_maturity`, ratings, `ff30num` sector, `principal_amt`, `db_type`, computed `pctDaysTraded`, median relative bid-ask `(prc_ask − prc_bid)/pr`.

### 1.3 Prices in the graph
- `:MarketPrice {at, clean, dirty, ytm, bid, ask, source:'TRACE'}` — **month-end observed price per instrument held by a Position** (~100 instruments × 24 months ≈ 2.4k nodes), not for all 3,000 (kept as summary properties + RiskAttributes there). Read-across matches attributes, not price series, so the full universe doesn't need full histories. *(Decision noted in DECISIONS.md.)*
- `:MarketPrice {at, clean, source:'proxy-model'}` — model price from the proxy-curve methodology: FRED Treasury CMT yield at the bond's duration point + credit spread frozen at position inception, discounted to a price. `(observed)-[:COMPARED_WITH]->(proxy)` same month. Divergence bps stored on the relationship — this feeds `PnLSignal` and IPV divergence and the Explore "price vs proxy curve" chart.

### 1.4 FRED curves
`https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS1MO,...,DGS30` (verified, no key; date params ignored on multi-series, so we filter locally to 2020-07 → 2023-01). Cached at `data/cache/fred/`. Loaded as `:Curve {date}` nodes with tenor properties (or one node per month-end; only month-ends are needed).

### 1.5 ESMA FITRS liquidity tier
Research verdict (verified by downloading and parsing an actual snapshot):
- The correct files are **FITRS `FULNCR_YYYYMMDD_D_NofM.zip`** (auth.045 non-equity transparency results), *not* FIRDS `FULINS_D` (reference data, no liquidity flag). Listing via the Solr endpoint `registers.esma.europa.eu/solr/esma_registers_fitrs_files/select?q=file_name:FULNCR*_D_*...`, download from `fitrs.esma.europa.eu/fitrs/<name>.zip`.
- `<Id>` carries the ISIN, `<Lqdty>true|false</Lqdty>` the assessment; `US` + CUSIP + check digit gives a deterministic join to OSBAP.
- **Coverage caveat (measured)**: ~29k US numeric-CUSIP ISINs present; expect only a fraction of our TRACE CUSIPs to match, and 99.8% of matched US bonds read `Lqdty=false`.
- **Plan**: download **two snapshots** (`FULNCR_20211106_D_*`, `FULNCR_20221105_D_*` — one per year, ~6 parts each) rather than all 8 quarters, since the flag is nearly static and scenario logic never uses its quarterly evolution. Matched bonds get the *real regulatory label* `liquidityTier = 'not-assessed-liquid (ESMA FITRS)'`; unmatched bonds get the *computed* tier from `pctDaysTraded` with provenance `'computed (TRACE activity)'`. Provenance is shown in the audit drawer / Explore inspector. *(Decision noted.)*

### 1.6 RiskAttribute nodes (non-negotiable design rule #2)
First-class `(:RiskAttribute {type, value, provenance})`, MERGEd so they are shared hubs:
- `issuerSector` (Fama-French 30 bucketed to ~10 sectors), `maturityBucket` (<2Y / 2–5Y / 5–10Y / 10Y+), `liquidityTier` (§1.5), `methodologyFamily` (dealer-quote / proxy-curve / matrix / model, assigned per methodology), `deskId`, `approvalChainShape` (computed from the governance layer: 'independent' / 'same-desk' / 'none').
- Linked `(:Instrument|:Position|:ValuationMethodology)-[:HAS_RISK_ATTRIBUTE]->(:RiskAttribute)`. No risk attribute is ever a matching property on Instrument fields — read-across and `:Pattern` REQUIRES links touch only these nodes (and GovernanceGaps).

---

## 2. Layer 2 — Governance (SYNTHETIC, generated from rules)

### 2.1 Population & clock
~100 `:Position` (each VALUED_BY a `:ValuationMethodology`, OWNED_BY a `:Person` trader, on one of ~20 `:Desk`), ~60 `:Person` with `role` (Trader, Desk Head, IPV Analyst, Risk Officer, Product Controller, MAP Member, CRO), 2 `:Committee` (Valuation Committee, MAP), ~4 `:Policy` nodes. Clock: **monthly, 2020-01 → 2022-12** (3 years); the real price layer covers 2021–2022 inside that window. Every event node carries `at` (datetime); `validFrom`/`validTo` on ValuationMethodology, PriceOverride and Approval where relevant (non-negotiable design rule #1). Per-position chronological `[:NEXT {timeDelta}]` chain over all its events (fraud-event-sequence model).

### 2.2 `control_obligations.csv` → nodes
Each of the 9 rows becomes:

```cypher
(:Policy {name})-[:MANDATES]->(o:ControlObligation {
  id: 'R3', name, severity,
  triggerEvent: 'PriceOverride',          // node label to watch
  triggerCondition: <csv text>,           // human-readable, shown in UI
  requiredControl: 'Approval AND IPVReview',
  requiredByRole, timing: 'AFTER'|'BEFORE'|'PERIODIC'|'STRUCTURAL',
  slaDays, appliesToAttribute,
  gapDefinition: <csv text>,              // spec shown in UI + audit drawer
  thresholdBps: 25, pctOfBidAsk: 50, ...  // params_json flattened to TYPED, EDITABLE properties
  defaultParamsJson: '<original csv json>' // for Policy-panel Reset
})
```
`default_broken_by_TP/FP` are **not** loaded as graph data — they are read by the acceptance tests directly from the CSV.

### 2.3 `control_obligations.csv` → the gap query
One parameterised Cypher statement, `gapQuery(positionId?, ruleId?, asOf?)`, stored once in `data/gap_query.cypher` and imported verbatim by `src/lib/queries.ts`, `mcp_server.py`, and the tests — a single source of truth. Structure: three `UNION` branches keyed on `o.timing`, each branch driven **only** by ControlObligation properties (no literal thresholds anywhere):

1. **TEMPORAL** (R1–R6): match trigger events of label `o.triggerEvent` on the position (label dispatch via a `WHERE any(l IN labels(e) ...)` on a `:Event` superlabel all event nodes carry); evaluate `triggerCondition` as a `CASE o.id` predicate reading `o.thresholdBps`, `o.n`, `o.windowDays`, `o.divergenceBps`, `o.unexplainedThreshold`, `o.consecutiveDays`…; then check existence of the required control event(s) within `o.slaDays` of the trigger (`BEFORE`: control.at ≤ trigger.at). Windowed-count rules (R4) and persistence rules (R6) are expressed with the same branch using per-rule CASE aggregation.
2. **PERIODIC** (R7): illiquid positions (via `appliesToAttribute` → RiskAttribute match) with no MAPReview inside `periodMonths`, or none within `regimeSlaDays` of a regime-break event (the 2022 rate-shock marker node).
3. **STRUCTURAL** (R8, R9): pattern checks — approver owns/shares desk with the position (R8, honouring `sameDeskAllowed`), Approval/Escalation without `EVIDENCED_BY` (R9).

Returns rows `{positionId, ruleId, triggerEventId, expectedControl, observedEventId|null, dueBy, status:'MET'|'MISSED'|'LATE'}`.

**Materialisation**: `:GovernanceGap` nodes are created by running *the same file* with a thin write wrapper (`CALL { <gap query> } WITH rows WHERE status <> 'MET' MERGE (:GovernanceGap {ruleId, positionId, triggerEventId})-[:MISSED_BY]->…`). Never hand-placed by the generator. The app's Policy panel edits `ControlObligation` properties and re-runs the write wrapper (delete + recompute) — results, S4 scores and Assistant answers change **without regenerating data**; Reset re-applies `defaultParamsJson`.

### 2.4 Event generation from obligations
`generate_data.py` walks Position × month and emits *trigger* events (MethodologyChanges occasionally; PriceOverrides clustered on volatile months — derived from the real price series; monthly IPVReviews whose `divergenceBps` comes from the real observed-vs-proxy gap; PnLSignals where real month-over-month price moves are large or unexplained). For every trigger it then emits the obligation's *required control response* with probability = `complianceRate[desk]` (configurable per desk, e.g. 0.85–0.98, two deliberately sloppy desks), with correct actors/roles and `EVIDENCED_BY` evidence — or omits/delays it. Gaps are therefore an emergent property discovered by the gap query, and the generator itself never writes a gap.

---

## 3. Layer 3 — Cases

### 3.1 Public true positive (`public_true_positive_2012.csv`)
- **Anchor**: synthetic position `POS-TP` ("Structured Credit Book A", desk `CIO-EQV`) on a synthetic illiquid instrument of the same *shape* as the real portfolio — RiskAttributes: `liquidityTier=illiquid`, `methodologyFamily=dealer-quote`, `maturityBucket=10Y+`, `issuerSector=Financials`, wide bid-ask. No real portfolio name in the UI; `source` column kept as a node property surfaced **only** in the audit drawer and the demo-script bibliography.
- **Unified demo clock**: `date_precision=day` → exact date; `=month` → deterministic (seeded) day within the stated month, constrained to preserve `seq` order. Then every POS-TP event's `at` is shifted by `TP_CLOCK_OFFSET_YEARS` (default **10**, configurable in `generate_data.py`) so the case lands 2021-12 → 2023-08, inside the population window and the rate-shock regime. The authentic date is kept in `sourceAt` and surfaced in the audit drawer and the demo-script bibliography; offset 0 restores authentic dates. *(Decision noted.)*
- **Encoding**: each row → the node(s) and relationships literally described in `graph_pattern` (labels from `event_label`, ids from `event_id`, `amount_usd_m`, `description`, `source`, `confidence` as properties). `actor_role` → shared `:Person` nodes with role labels only (Trader-A, Desk-Head-A, VCG-Analyst, CIO-Head, Deputy-CRO, …), never names. All events chained `[:NEXT]` in `seq` order.
- Row-specific handling:
  - **seq 6 `PO-DAILY-SERIES`** ("one per business day or per week"): **12 weekly** PriceOverride nodes (Jan 6 → Mar 23 2012 authentic), `side:'favourable'`, escalating `deviation_bps`, each "approved" by the **desk head who owns the position** (same desk, no independent approver, no IPV challenge) — this is the real segregation-of-duties failure, so **R8** fires here (plus R3 via approval-without-IPV-challenge, R4 via windowed count without escalation). CSV `rules_broken` updated to `R3;R4;R8` per approval.
  - **seq 2 `MC-VAR-2012`**: Approval by a *different-function* (risk) approver, missing `EVIDENCED_BY` only → breaks R1 (approval after effective date) and R9, **not** R8.
  - **R7 anchor (encoder-added, not a CSV row)**: one routine `MAPReview` on POS-TP in 2011-Q3 (authentic; outcome `'no finding'`, evidenced) so R7 is MET and the exact-set test holds. The rate-shock regime marker sits at 2022-09-30 and POS-TP's `validTo` is its transfer date (shifted 2022-07), so the regime-break clause of R7 doesn't re-fire on a closed position.
  - **seq 10**: two PnLSignal nodes (−6m, −400m) linked `CHALLENGED_BY`, same `at` day.
  - **seq 13**: `(:Incident {id:'INC-TP'})-[:CAUSED_BY]->(POS-TP)`; later rows attach RootCauses (×3), CorrectiveActions, Evidence to it per `graph_pattern`.

### 3.2 Second true positive — customer slot
`templates/customer_case_template.xlsx`, one tab per entity (Position, Instrument, MethodologyChange, PriceOverride, IPVReview, PnLSignal, Approval, Escalation, MAPReview, Evidence, Incident): columns = field, type, required?, one example row, expected relationships; plus an *Instructions* tab (date precision, role-not-name policy, how rules_broken will be verified). `scripts/load_customer_case.py` ingests a filled workbook through the same encoder as §3.1.

### 3.3 Deliberate false positive
`POS-FP` (desk `RATES-EM`, illiquid proxy-curve bond): a **methodology change in Oct 2022 after the rate shock**, where governance *worked* — committee-approved beforehand with evidence (R1 ✓, R9 ✓), independent approver (R8 ✓), MAPReview within 60 days of the regime break (R7 ✓), IPV divergence resolved with adjustment evidence (R5 ✓), overrides all ≤ thresholdBps and approved with IPV challenge (R3 ✓). It must violate **exactly R2, R4, R6** (per `default_broken_by_FP`):
- **R2**: post-change IPVReview happens, but ~45 days after `effectiveAt` (> 30-day SLA) — "IPV done", just late.
- **R4**: 3 small overrides within 90 days during the vol spike, each individually approved, **no Escalation→MAPReview** within 10 days.
- **R6**: unexplained P&L > 2% for 6 consecutive days around the shock; attribution Control recorded on day 8 (> 5-day SLA) — "P&L explained", just late.
The construction makes the S4 story land: the *shape* matches the pattern, but clicking through to S2 shows its controls did happen — a human closes it.

---

## 4. Acceptance tests (`tests/test_acceptance.py`, pytest + neo4j driver)

Both tests read their expected sets **from the inputs CSVs at test time** (never hard-coded), run the real `data/gap_query.cypher` against the loaded `mismarking` database, and compare exact sets.

### 4.1 TP test
With the seq-6 CSV amendment (`rules_broken = R3;R4;R8`), `union(rules_broken)` = `default_broken_by_TP` = `{R1, R2, R3, R4, R5, R6, R8, R9}` — the columns now agree. The test asserts `gapQuery(positionId='POS-TP')` returns **exactly** that set (computed from the CSVs at test time) and asserts the two columns' agreement as a data-consistency check. R7 is MET via the encoder-added 2011-Q3 anchor MAPReview (§3.1).

### 4.2 FP test
`gapQuery(positionId='POS-FP')` must return **exactly** `{R2, R4, R6}` (read from `default_broken_by_FP`) — nothing else, in particular not R3/R5/R8/R9.

Run via `make test` after `make data` + load. (The Assistant chronology test is a separate later workstream per the prompt, with its own test file.)

---

## 5. Pipeline & repo mechanics

```
make data   = scripts/download_data.py (cache OSBAP/FITRS/FRED, skip-if-present)
              → generate_data.py (reads caches + inputs/*.csv, seeded)
              → writes data/layers/{market,governance,cases}.json   (UI ingest payloads)
                       data/load_data.cypher                        (CLI/MCP parity, cosmo-rd convention)
                       data/gap_query.cypher                        (single source of truth)
                       data/holdout_links.json                      (S4 link-prediction ground truth)
make test   = pytest tests/
```
- **UI-triggered ingest** (deviation from cosmo-rd, required by the prompt): the Explore tab's Ingest flow loads `data/layers/*.json` (served by Vite) and runs fixed `UNWIND $rows …` ingest queries through the audited `runQuery` — layer by layer: market → governance (ends by materialising gaps via the gap query) → cases. Reset = `MATCH (n) DETACH DELETE n` from the app. `data/load_data.cypher` provides the same result via cypher-shell/MCP `load_demo`.
- **Link-prediction holdout**: `generate_data.py` removes a known set of true links (e.g. `HAS_RISK_ATTRIBUTE`/`GENERATED_SIGNAL` on a few near-miss positions) and records them in `holdout_links.json`; S4 shows GDS recovering them and says so on screen.
- **Env**: single source `inputs/.env` (already provided — `mismarking` db, Gemini key). `make env` copies/derives root `.env` and `app/.env` (`VITE_NEO4J_*`, `VITE_GEMINI_API_KEY`). `.env` files gitignored.
- **Python**: uv + pyproject.toml (pandas, pyarrow, requests, lxml, openpyxl, neo4j, python-dotenv, mcp, pytest).
- **App stack** (locked to cosmo-rd): React 19, Vite 8, TS ~6, `@neo4j-ndl/react` ^4.16, `@neo4j-nvl/react` for graph viz, `@google/genai` (declared in package.json this time), oxlint; module-level audited `runQuery` + listener-set audit drawer; `withGroup`-wrapped scenario functions with banner comments; FastMCP `mcp_server.py` with per-tool `cypher_audit_trail`.

## 6. Sizing estimate
~3,000 Instrument, ~100 Position, ~2.4k observed + ~2.4k proxy MarketPrice, ~3.6k IPVReview, ~1–2k PriceOverride/PnLSignal/Approval/Escalation/MAPReview/Control/Evidence combined, ~50 RiskAttribute hubs, 9 ControlObligation, GovernanceGaps computed (~a few hundred). Total ≈ 15–25k nodes — comfortable for browser NVL with progressive reveal and for GDS.
