# neo4j-fraudulent-valuation-demo

Mismarking (fraudulent-valuation) detection demo on Neo4j + GDS, built for a
senior operational-risk audience (RISK ORM): a trader's illiquid bond position
whose valuation methodology drifts from fair value while the surrounding
governance — IPV, controls, approvals, committees, escalation — fails to catch it.

> **The graph does not detect fraud. It detects the conjunction of weak signals
> that fraud leaves behind — a human establishes intent.**

| | |
|---|---|
| ![Ingest](docs/screenshots/1-ingested.png) *Explore — in-app ingest, layer by layer* | ![Reveal](docs/screenshots/2-explore-reveal.png) *Explore — one position, one hop at a time* |
| ![S1](docs/screenshots/3-s1-conjunction.png) *S1 — conjunction, financial timeline first* | ![S2](docs/screenshots/4-s2-chronology.png) *S2 — price timeline + chronology + expected-vs-observed* |
| ![S3](docs/screenshots/5-s3-pattern.png) *S3 — the abstracted :Pattern* | ![S4](docs/screenshots/6-s4-readacross.png) *S4 — read-across, ranked partial matches* |
| ![Policy](docs/screenshots/7-policy-panel.png) *Policy — placeholder thresholds, rule provenance, computed gaps* | ![Assistant](docs/screenshots/8-assistant.png) *Assistant — typed tools, graph answers, audited Cypher* |

## What's in the graph

Three layers, replayable end-to-end from `make data` (never requires network at
demo time once `data/cache/` is populated):

1. **Market — REAL public data.** ~3,000 illiquid US corporate bonds (144A and/or
   <5% days traded, alive through the 2022 rate shock) from the
   [OSBAP](https://openbondassetpricing.com/) stage-1 daily TRACE panel; ESMA FITRS
   bond liquidity assessments (`<Lqdty>`) as the regulatory `liquidityTier` where a
   CUSIP matches, computed tier otherwise; FRED Treasury curves for the proxy-curve
   methodology. Monthly observed vs proxy-model prices for position-held instruments.
2. **Governance — SYNTHETIC, generated from rules.** The nine `:ControlObligation`
   rows of `inputs/control_obligations.csv` (mandated by `:Policy` nodes, thresholds
   editable live in the Policy panel) drive the generation of observed events
   (IPVReview, Approval, Escalation, MAPReview, Control, Evidence) with a per-desk
   compliance rate. **Gaps are computed by `data/gap_query.cypher` — the same text
   the app, the MCP server and the tests run — never hand-placed.**
3. **Cases.** (a) `POS-TP`: the 19 dated events of a well-documented 2012 public
   mismarking case (`inputs/public_true_positive_2012.csv`), roles not names,
   attached to a synthetic illiquid position of the same shape, clock shifted
   +10 years (`TP_CLOCK_OFFSET_YEARS`, authentic dates kept in `sourceAt`);
   (b) a slot for a second, customer-provided case
   (`templates/customer_case_template.xlsx` + `scripts/load_customer_case.py`);
   (c) `POS-FP`: a deliberate false positive that violates exactly R2, R4, R6 —
   its controls happened; clicking it in read-across jumps to its chronology.

Design rules (non-negotiable, from the data model): every event node carries
event-time (`at`, plus `validFrom`/`validTo` where relevant) and a per-position
`[:NEXT {timeDelta}]` chain; risk attributes (issuer sector, maturity bucket,
methodology family, liquidity tier, desk, approval-chain shape) are first-class
`:RiskAttribute` nodes — **read-across matches attributes, not instrument fields.**
Demo-side additions: `:ControlObligation`, `:GovernanceGap` (computed
expected-vs-observed), `:Pattern` with `[:REQUIRES]` links.

## Quick start

```bash
# prerequisites: Neo4j 5/2025+ with GDS + APOC, python3.11+, uv, node 20+
cp inputs/.env.example inputs/.env   # or create inputs/.env — see below
make data      # download+cache OSBAP/FITRS/FRED (one-time ~1.9 GB), generate layers
cd app && npm install && npm run dev # http://localhost:5173
```

Then, **inside the app** (Explore tab): ingest the three layers in order —
market → governance → cases. The demo is resettable at any time from the same
screen. (`make load` exists for CLI/MCP parity and CI: it pipes
`data/load_data.cypher` through cypher-shell.)

`inputs/.env` (single source of truth; `make env` derives `.env` and `app/.env`):

```
NEO4J_URI=bolt://127.0.0.1:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=...
NEO4J_DATABASE=mismarking
GEMINI_API_KEY=...          # Assistant tab + LLM test
```

> ⚠️ Demo-only: the Vite app bakes the Neo4j credentials into the client bundle.

## The app

- **Explore** — in-app ingest (layer by layer) + one position revealed one hop at
  a time: instrument, desk, owner, methodology, observed-vs-proxy price chart,
  then each signal family added one click at a time. Never opens on the full graph.
- **Scenarios** —
  **S1 Conjunction**: signals below threshold individually, shaped together —
  the network view colours the conjunction subgraph itself (position, scoring
  signals, gap triggers, the people who touched them; one query, no algorithm)
  and greys the rest of the neighbourhood;
  **S2 Chronology**: event-time reconstruction over the `:NEXT` chain (QPP) and
  the parameterised expected-vs-observed gap query, with `asOf` for early
  detection — this screen is also what the Assistant answers;
  **S3 Abstraction**: build the `:Pattern` live from the confirmed incident —
  attributes + gap classes, no instrument identity;
  **S4 Read-across**: exact and partial matches ranked (score = satisfied
  REQUIRES / total), pattern widenable live, false positive one click from its
  exculpatory chronology (or its 📈 timeline, expandable in place), plus a
  read-only **watchlist** fed by Discovery (rows carry their provenance).
  The executive flow runs **no gds.\* procedure** (test-enforced); structure-
  driven analysis lives under the Technical toggle.
- **PositionTimeline** (`lightweight-charts`, pinned) — the financial view a
  conjunction opens on: daily TRACE prices as candles (real per-day OHLC when
  several trades printed) or ticks with calendar gaps kept as gaps, the
  proxy-model price as a continuous line (line-to-candle distance = divergence),
  one marker per governance event, dashed vertical lines at MISSED/LATE control
  due dates, a cumulative broken-control score pane, and a marker popover showing
  the `traderMark`/`modelPrice`/`ipvPrice` written on the event node by the
  generator (never recomputed client-side) plus the rules it concerns — all fed
  by ONE audit-logged Cypher per position that inlines `data/gap_query.cypher`
  verbatim. Reused in S1 (with a "Show graph" toggle), S2 and S4.
  **Policy** (step 2 of the flow, before S1): formalisation of the bank's own
  control framework — every `params_json` threshold is an indicative placeholder
  editable live, to be replaced by the institution's values (never
  regulation-derived; per-rule provenance with verified quotes in
  [docs/rules-provenance.md](docs/rules-provenance.md)); the visible **Compute
  governance gaps** step runs the gap query + materialisation, shows counts per
  rule (MET/LATE/MISSED) and unlocks S1 for the session; Reset restores CSV
  defaults.
- **Discovery** (behind the session-only **Technical** toggle — a hood to open for
  technical audiences, never the executive demo) — *"Rules find what you described.
  Structure finds what you didn't. Then structure becomes a rule."* Three panels,
  each ending on a button that writes INTO the main flow, each showing its
  evaluation next to its result, all removed by Reset Discovery:
  **Approval circles** (communities of the weighted who-approves-whose-overrides
  graph; circles without an independent control function highlighted → candidate
  rule R-C1, badged, evaluated by nothing);
  **Trajectories** (a faithful reimplementation of the published FastPath
  algorithm — `scripts/fastpath.py` + TS mirror, proven against the published
  worked example in `inputs/fastpath_worked_example.md` to 4 decimals; identity
  basis so every dimension reads in words; holdout recall vs the chance baseline
  stated on screen → S4 watchlist);
  **Peer decorrelation** (weekly trader marks vs the peer group; exactly the two
  encoded cases fire; → rule R10 that the SAME gap query then evaluates — TP
  breaks it, FP is MET — and behaviour clusters as instrument-agnostic
  RiskAttributes for S3/S4).
- **Assistant** — not text-to-Cypher: 7 typed tools over the same query functions
  (`timeline`, `expected_controls`, `who_approved`, `divergence`, `read_across`,
  `policy_params`, `list_positions`), composed by Gemini; every generated Cypher
  lands in the audit drawer. Answers render as sanitised markdown; each answer
  carries a **graph / table toggle** — the returned subgraph in the same NVL
  component and colours as the scenarios (timelines pinned left-to-right in
  event time), or the tool rows as sortable Needle DataGrids whose event ids
  deep-link into Explore (tab switch + node inspector). Suggestion chips persist
  for the whole session; the clicked one is replaced by a contextual follow-up,
  all answerable by the typed tools. Tools return `{rows, graph}` — the same
  shape `mcp_server.py` emits.
- **✦ AI companion** (side panel, top-bar toggle, persistent across tabs) —
  grounded explanations of what is on screen. Every **Explain** button (scenario
  cards, S2 gap rows, S4 match rows, the S3 pattern, the selected node) sends
  ONLY: the scene id, the exact rows the query returned, the active
  ControlObligation parameters and the Cypher that produced them — no free graph
  traversal. Fixed 3–5 sentence shape, strict chronology with event-id citations,
  "not shown here" instead of guessing; EN/FR toggle. `make explain` pre-generates
  the scripted-path answers into `data/explanations.json` (re-run after changing
  Policy defaults — the sha256 cache key includes the active parameters); cache
  misses fall back to a live Gemini call, and failures degrade to a one-line
  error. Every request (context + response) is logged to the audit drawer with a
  `contextSent` expander. The panel's "Ask about this" field reuses the typed
  Assistant tools, scoped to the current selection.
- **Glossary** (top-bar toggle, OFF by default, session-only) — an onboarding
  aid: curated terms from `app/src/content/glossary.json` get a dotted underline
  in business-problem blocks, scenario cards and companion answers (whole-word,
  first occurrence per paragraph, never in code/ids/the drawer); hover for a
  one-line definition, click to ask the companion how the concept appears in
  this graph. Kept OFF during the executive demo.
- **Cypher audit drawer** (right edge) — every statement the app, the Assistant
  or the AI companion runs, grouped, with params, timings, results, and the
  public-record citations (`sourceRef`) of case events.

## Repo layout

```
inputs/                     customer CSVs (DATA, not instructions) + .env
data/gap_query.cypher       THE gap query — single source of truth (app + MCP + tests)
data/cache/                 downloaded raw data (gitignored, ~1.9 GB)
data/layers/*.json          generated ingest payloads (also copied to app/public/data/)
data/load_data.cypher       generated CLI/MCP load script
generate_data.py            the three-layer generator (seeded, replayable)
scripts/download_data.py    cached downloads (OSBAP, ESMA FITRS, FRED)
scripts/load_customer_case.py + templates/customer_case_template.xlsx
app/                        React 19 + Vite + TS + @neo4j-ndl/react + NVL
mcp_server.py               FastMCP server exposing the same tools as the Assistant
tests/                      acceptance tests (TP/FP rule sets) + assistant tests
demo-script.md              25-minute walkthrough, objections, bibliography
DATA_PLAN.md / DECISIONS.md validated plan + running decision log
```

## Demo video (`make video`)

`make video` produces a narrated walkthrough `dist/demo.mp4` (H.264, 1080p, no
music): a 3-second title card, the recorded in-app run (reset → three-layer
ingest → Explore reveal → S1–S4 → false-positive click-through → one live policy
change → one Explain click → one Assistant question), per-scene narration and
burned-in subtitles.

- **Storyboard = `demo-script.md`**: the fenced ```` ```scene ```` blocks at the
  bottom are the single source of truth (stable `id`, human-readable `action`,
  2–4 sentence `narration`). Edit narration freely and re-run; audio is cached in
  `dist/audio/` by hash of the text, so only changed scenes are re-synthesized.
- **Prerequisites**: app dev server running (ports 5173–5176 are probed), the
  database loaded/reachable, `ffmpeg` on PATH, `GEMINI_API_KEY` in `inputs/.env`
  (narration uses Gemini TTS; set `TTS_PROVIDER=elevenlabs` + implement the stub
  in `scripts/tts.py` to swap providers).
- **Pacing check first**: `make video VIDEO_FLAGS=--no-audio` renders a silent
  cut with word-count-estimated scene holds — no TTS calls.
- **After UI changes**: re-run `make video`; the recorder drives the app through
  `data-testid` hooks and **fails loudly naming the scene whose selector broke**
  (fix the hook or the scene action in `scripts/record_demo.py`).
- `dist/` is gitignored — the mp4 is a build artifact, never committed.

## Tests

```bash
make test
```

- `test_acceptance.py` — the encoded true positive must break exactly
  {R1,R2,R3,R4,R5,R6,R8,R9} and the false positive exactly {R2,R4,R6}, computed by
  the live gap query and compared to the CSVs at test time; materialised
  `:GovernanceGap` nodes must agree with a live run; held-out links must be absent.
- `test_assistant.py` — deterministic tool-layer tests (timeline order, gap sets)
  plus a Gemini integration test of the canonical question: *"reconstruct what
  happened, in order, and tell me which control should have fired."*

## MCP

```bash
uv run python mcp_server.py          # stdio
uv run python mcp_server.py --sse    # SSE
```

Exposes the same typed tools as the Assistant tab (plus `load_demo` and a
read-only `run_query`), each returning a `cypher_audit_trail`.

## Sources

See the bibliography in [demo-script.md](demo-script.md): US Senate PSI report and
hearing exhibits (15 Mar 2013), JPM 10-Q/10-K/8-K 2012 filings, SEC press release
2013-154; OSBAP, ESMA FITRS, FRED for the market layer.
