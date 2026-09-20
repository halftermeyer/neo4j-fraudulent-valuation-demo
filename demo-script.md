# Fraudulent valuation — from weak signals to read-across
## 25-minute executive walkthrough

**Audience**: senior operational-risk managers (RISK ORM) — experts in IPV, P&L
attribution, controls and read-across, new to graphs. Explain nothing about the
business; explain everything about how to read the screen.

**The thesis** (say it twice — opening and close, verbatim):
> **"The graph does not detect fraud. It detects the shape fraud leaves behind. A human establishes intent."**

One position (**POS-TP**), one thread, five acts. Two capabilities decide the
deal: **read-across** (one confirmed case becomes an instrument-agnostic pattern
run against the whole population) and **early detection** (partial matches while
the shape is still forming).

**Vocabulary**: conjunction, read-across, chronology, watchlist, similarity,
signal. The Discovery tab and the Technical toggle exist for technical audiences
only — see the appendix; they never appear in the executive thread.

---

## Prerequisites (before the audience arrives)

```bash
make data          # one-time: downloads & caches public data, generates the layers
make explain       # pre-generates the AI-companion explanations (EN + FR)
cd app && npm install && npm run dev
```

Vite prints the port (other demos may hold 5173/5174 — this app usually lands on
**5175**; check the title bar says "Mismarking"). `inputs/.env` holds the Neo4j
credentials and the Gemini key (`make env` derives `.env` and `app/.env`).

Every threshold in the Policy step is an indicative placeholder — per-rule
provenance with verified public-source quotes in `docs/rules-provenance.md`.
Load the customer's own values beforehand if they sent them.

Keep the **Glossary** and **Technical** toggles OFF. Keep the Cypher audit
drawer closed until someone asks "what did it just run?" — then never close it
again. Start from an empty database: the ingest is part of the show.

Timing: Act 0 ≈ 3 min · Act 1 ≈ 6 min · Act 2 ≈ 6 min · Act 3 ≈ 4 min ·
Act 4 ≈ 5 min · wrap ≈ 1 min.

---

## Act 0 — Data: three layers, live (≈ 3 min)

> **Tab: Explore.** Reset, then ingest market → governance → cases; one schema
> peek on the market layer. No graph exploration here — the thread starts at the
> Policy step.

**Talking points.** Layer 1 is real: ~3,000 illiquid US corporate bonds from the
public TRACE panel, ESMA's own liquidity assessments, Treasury curves — the 2022
rate shock is in the data because it happened. Layer 2 is synthetic governance
generated FROM nine control obligations with a per-desk compliance rate — the
misses are computed, never hand-placed. Layer 3 holds two cases: a
well-documented public 2012 mismarking case encoded event by event from the
public record (clock shifted +10 years; every event keeps its authentic date and
citation), and one deliberate false positive whose controls worked.

**On screen.** The three layer cards filling, node counters climbing, the line
"computing governance gaps (expected vs observed)" — that line is the product.
Then the eye icon on the market card: the layer's labels and relationships from
a live query, plus five real rows.

```scene
id: intro
before: dev server up, database loaded from a previous run.
actions: Explore tab; click Reset database; wait for "database emptied".
shot: the empty Explore tab, three ingest cards armed.
narration: The graph does not detect fraud. It detects the shape fraud leaves
  behind, and a human establishes intent. We start from an empty database and
  follow one confirmed mismarking case end to end.
```

```scene
id: ingest-market
before: empty database.
actions: click Ingest on 1 · Market; wait for "Loaded ✓" (fast-forwarded).
shot: the market card loading, counters climbing.
narration: The first layer is real public data. Three thousand illiquid US
  corporate bonds with their real daily prices, the regulator's own liquidity
  assessments, Treasury curves. The twenty-twenty-two rate shock is in the data
  because it happened.
```

```scene
id: ingest-governance
before: market loaded.
actions: click Ingest on 2 · Governance; wait for "Loaded ✓" (fast-forwarded).
shot: the governance card loading.
narration: The second layer is synthetic governance, generated from nine control
  obligations with a compliance rate per desk. The gaps you will see are computed
  by a query, never hand-placed.
```

```scene
id: ingest-cases
before: governance loaded.
actions: click Ingest on 3 · Cases; wait for "Loaded ✓" (fast-forwarded).
shot: the cases card loading; the gap-computation line visible.
narration: The third layer holds two cases. A public mismarking case from
  twenty-twelve, encoded event by event with its citations, and one deliberate
  false positive whose controls actually worked. Every date is authentic, shifted
  ten years onto the demo clock.
```

```scene
id: schema-peek
before: all three layers loaded.
actions: click the eye on 1 · Market; wait for the mini-schema and the sample table.
shot: the popover — labels, relationships, five live rows.
narration: Every layer card carries an eye: what was just loaded, as a live
  query. The labels, how they relate, and five real rows straight from the
  graph. This is the map an analyst gets before anything runs.
```

---

## Act 1 — Policy & conjunction (≈ 6 min)

> **Tab: Scenarios → Policy · Control framework**, then **S1 · Conjunction**.

### 1.1 The Policy step

**Say verbatim:**
> **"These rules formalise your own governance. The defaults are indicative — you plug in your thresholds. That is what this panel is for."**

**Talking points.** Nine rules, every parameter editable live. Hover a **Source**
label: each rule carries the public text it echoes — a regulatory requirement,
supervisory guidance, or a public case finding — quoted and linked. Nothing here
claims a threshold came from regulation; the numbers are the institution's to
set. Then the visible step: **Compute governance gaps** — one parameterised
query, all nine rules, every position, expected vs observed; the counts land as
MET / LATE / MISSED per rule, and S1 unlocks.

**On screen.** The nine rule cards with Source labels; then the counts table.

```scene
id: policy-framework
before: layers loaded; Scenarios opens on the Policy step.
actions: Scenarios tab; frame the nine rule cards with their Source labels.
shot: the policy grid, provenance labels visible.
narration: Before any detection, the policy. These nine rules formalise the
  bank's own governance — every threshold an indicative placeholder, each rule
  carrying the public source it echoes, quoted and linked. You plug in your
  thresholds; that is what this panel is for.
```

```scene
id: policy-compute
before: the nine rules on screen.
actions: click Compute governance gaps; wait for the per-rule counts table.
shot: the MET / LATE / MISSED counts per rule; S1 unlocked.
narration: This button is the detection engine. One query evaluates all nine
  obligations over every position, expected versus observed, and counts met,
  late, missed per rule. Everything after this screen only reads what it just
  computed.
```

### 1.2 S1 — the conjunction

**Say verbatim:**
> **"Each signal on its own is below threshold. Connected, they have a shape."**

**Talking points.** Every control function sees one column — IPV sees
divergence, Product Control sees unexplained P&L, MAP sees review calendars —
and none of them fires alone. One query counts what co-occurs around every
position; the confirmed case tops the ranking by a factor of six. Clicking the
row opens the **financial timeline first** — the investigator's native language:
real prices as candles or ticks (gaps stay gaps), the model price as a line, one
▼ marker per governance event, dashed verticals where a control came due and
never fired, the cumulative broken-control score below. Then **Show graph**: the
network behind the chart, with the conjunction itself coloured — the position,
the signals that scored it, the gaps' trigger events and the people who touched
them, straight from the same query family — and everything around it grey.

**On screen.** The ranked table (POS-TP at 152 vs 24 for the runner-up), the
timeline with the marker wall, the per-rule score bars; then the coloured
conjunction inside its grey neighbourhood.

```scene
id: s1-conjunction
before: gaps computed (S1 unlocked).
actions: open S1; click Run the conjunction query; the top row's financial timeline renders.
shot: ranked table left, POS-TP timeline right — markers, dashed gaps, score bars.
narration: One query counts what co-occurs around every position, and the
  confirmed case tops the ranking by a factor of six. Each signal on its own is
  below threshold. Connected, they have a shape — and the first view of that
  shape is the price: marks holding firm while the model falls away, under a
  wall of controls that came due and never fired.
```

```scene
id: s1-graph
before: S1 run, POS-TP selected, timeline on screen.
actions: click Show graph; wait for the network view.
shot: the conjunction coloured, the rest of the neighbourhood grey.
narration: One click behind the chart sits the network. Coloured: the
  conjunction itself — the position, its signals, the gaps' triggers, the people
  who touched them. Grey: everything around it. Same evidence as the ranking,
  one query, nothing else.
```

---

## Act 2 — Chronology: which control should have fired (≈ 6 min)

> **Tab: Scenarios → S2 · Chronology.** Timeline + table, one Explain click on a
> gap, then the Assistant question.

**Say verbatim, pointing at a MISSED row:**
> **"The policy prescribes a control at this point. No control event exists."**

**Say verbatim, pointing at the R5 row (the review that upheld the marks):**
> **"The review took place and upheld the marks. A control that executes is not a control that is effective."**

**Talking points.** Reconstruct POS-TP: the financial timeline on top, the event
chronology below it — the informal switch away from midpoints, the weekly
override series signed off by the desk head, the spreadsheet that quantified the
gap and went nowhere, the quarter-end review that upheld the marks. Every case
event keeps its authentic date and its public-record citation (audit drawer).
The expected-vs-observed table is one parameterised query over the nine rules;
set **as-of mid-2022** and rerun to show rows flipping to PENDING — early
detection, not autopsy. Click the small **✦ Explain** on the R5 gap row: the
companion narrates that single gap — trigger, SLA, what was observed instead —
grounded on exactly the rows on screen (the payload is auditable in the drawer).
Then ask the Assistant, in words: *"Reconstruct the timeline of POS-TP and tell
me which control should have fired."* It composes typed tools over the same
audited queries — it is not free-form text-to-Cypher — and because the question
is about one position, the answer opens on its financial timeline.
*(The Assistant runs last in the video cut; in the room it belongs here.)*

**On screen.** Timeline + chronology + gap table; the companion panel with the
grounded explanation; the Assistant answer with its timeline/graph/table toggle.

```scene
id: s2-chronology
before: gaps computed.
actions: open S2; Reconstruct POS-TP; financial timeline + chronology render.
shot: the timeline above, the event chronology below, authentic-date badges.
narration: Scenario two reconstructs the case in event time, under the same
  price timeline. An informal switch away from midpoints, a weekly series of
  favourable overrides signed off by the desk head, the spreadsheet that
  quantified the gap and went nowhere. Every event keeps its authentic date from
  the public record.
```

```scene
id: s2-gaps
before: POS-TP reconstructed.
actions: scroll to the expected-vs-observed table.
shot: the gap table — MET, LATE, MISSED rows with due dates.
narration: One query evaluates the nine obligations against this book. Where a
  row reads missed: the policy prescribes a control at this point, and no
  control event exists. And the quarter-end review is here too — it took place,
  and upheld the marks. A control that executes is not a control that is
  effective.
```

```scene
id: explain-click
before: the gap table on screen.
actions: click ✦ Explain on the R5 gap row; the companion answers, grounded.
shot: the companion panel narrating the single gap, the cited row flashed.
narration: The companion explains one gap — and only from what is on screen: the
  rows, the active thresholds, the query that produced them. If something is not
  in that context, it says it is not shown. The full payload is in the audit
  drawer, like every query.
```

---

## Act 3 — Pattern: the case becomes a template (≈ 4 min)

> **Tab: Scenarios → S3 · Abstraction**, then the pattern editor (it lives with
> the matcher in S4).

**Say verbatim, on the pattern card:**
> **"Everything that identifies the case is discarded, not hidden. Eleven conditions remain. That is the pattern."**

**Say verbatim, while editing:**
> **"The pattern is a thing you can edit."**

**Talking points.** One click abstracts the confirmed incident into a template:
three risk attributes (dealer-quoted, illiquid, long-dated) plus the case's
eight gap classes — no instrument name, no desk, no dates, no people. Then show
it is data, not code: open S4, run the matcher once, and in the pattern editor
remove `maturityBucket` — the scores re-rank live — and add it back. A pattern
that can be edited is a pattern the institution can own: every new confirmed
case adds a template, and the library grows at the cost of a row, not a rebuild.

**On screen.** The pattern card with eleven condition chips; the editor chips
with their × and the add-condition list; scores re-ranking on each change.

```scene
id: s3-pattern
before: gaps computed; the confirmed incident in the graph.
actions: open S3; click Abstract the confirmed case; the pattern renders as chips + graph.
shot: the eleven conditions — three attributes, eight gap classes; the pattern as a node.
narration: One click abstracts the confirmed case into a template. Everything
  that identifies it is discarded, not hidden — no instrument, no desk, no
  dates, no people. Eleven conditions remain: three risk attributes and eight
  classes of missed control. That is the pattern.
```

---

## Act 4 — Read-across: the whole population, one query (≈ 5 min)

> **Tab: Scenarios → S4 · Read-across.**

**Say verbatim, on the ranked matches:**
> **"Nine of eleven is a position worth a look. This one matched on shape; its controls happened — a human closes it."**

**Talking points.** The template runs against every position at once. The
confirmed case matches itself at 100% — the sanity check, say so. Everything
between 50% and 100% is the early-detection story: the same shape forming on
other books, before any loss. Click the high-scoring **POS-FP** row: the app
jumps to its chronology — methodology change approved in advance by an
independent committee, IPV done, P&L explained. The shape matched; the
governance worked; the tool assembled both the signals and the exculpatory
evidence. Back in S4, work the structural condition — the same-desk-approval
gap class, part of the default pattern: **drop it and the match set widens;
restore it and the set tightens** around the books where the structure itself is
broken. Pattern size is the institution's choice, not a system limit. If Discovery has been used in a
dry run, its watchlist shows here as a read-only receiver, each row carrying its
provenance. One line if asked: *structure-driven analysis lives under the
Technical toggle.*

**On screen.** The ranked match table with satisfied/missing chips; POS-FP's
exculpatory chronology; the editor adding the R8 gap class; the list shrinking.

```scene
id: s4-readacross
before: the pattern exists.
actions: open S4; click Run read-across; every position scored against the template.
shot: exact match at 100%, partial matches ranked below with satisfied/missing chips.
narration: The template runs against the whole population at once. The confirmed
  case matches itself at one hundred percent — that is the sanity check. Every
  partial match below it is the same shape forming on another book, before any
  loss.
```

```scene
id: s4-false-positive
before: the ranked matches on screen.
actions: click the POS-FP row; the app jumps to its S2 chronology; Reconstruct.
shot: POS-FP's timeline and gap table — approvals present, reviews done.
narration: This high match is the deliberate false positive. One click opens its
  chronology: change approved in advance, review done, P and L explained. Nine of
  eleven is a position worth a look. This one matched on shape; its controls
  happened — a human closes it.
```

```scene
id: s4-widen
before: POS-FP's chronology on screen (from the previous scene).
actions: back to S4; run read-across; in the pattern editor remove maturityBucket and re-add it; then drop the same-desk-approval gap class (the set widens) and restore it (the set tightens); the scores re-rank on every change.
shot: the editor chips changing, the match scores re-ranking live.
narration: The pattern is a thing you can edit. Remove a condition, the scores
  re-rank live. Drop the same-desk-approval gap and the match set widens; put it
  back and it tightens around the books where the structure itself is broken.
  Every new confirmed case grows this library at the cost of a row, not a
  rebuild.
```

---

## Wrap-up (≈ 1 min)

**Say verbatim:**
> **"You could build the dashboard on any database. You could not build the read-across library anywhere else and keep it cheap to grow."**

Then close on the thesis, verbatim:
> **"The graph does not detect fraud. It detects the shape fraud leaves behind. A human establishes intent."**

Every claim made in the last 25 minutes is one click from its query in the audit
drawer, and — for the case — one click from its public-record citation.

---

## Objections cheat-sheet

1. **"You could do this in Mongo/Postgres."** About 70% of what you saw, yes —
   and say so: the ingest, the policy table, the per-position timeline, even the
   per-rule gap evaluation are portable; they are queries over events. The 30%
   that is not portable is the part that decides the deal: the pattern is a
   **node** whose conditions are **shared attribute and gap-class nodes**, so
   matching the whole population is adjacency, not joins that grow with every
   new condition — and the library grows by adding a row. Rebuild that
   elsewhere and you rebuild a graph.
2. **"Where do the thresholds come from?"** They are indicative placeholders —
   the Policy step exists precisely so you plug in yours. Each rule carries a
   Source label with the public text it echoes, quoted and linked
   (`docs/rules-provenance.md`); none claims its number came from regulation.
   Then return the question: *what are your thresholds?* — that answer is the
   first workshop.
3. **"Isn't similarity on synthetic data circular?"** Partly, and the screen
   says so. The trajectory shortlist in Discovery reports a retrieval check
   against the population share and a held-out check with its sample size
   stated ("too few to conclude"); where a result is ≈ chance it prints
   *hypothesis, not evidence*. Nothing in the executive thread rests on a
   learned score.
4. **"We already have quant tools."** Keep them — their signals are the
   *input*. The graph's contribution is the conjunction: marks, approvals, IPV,
   P&L and org structure in one place, so one query can see what five silos
   cannot. The public case had quant oversight; what was missing was the row
   across the columns.
5. **"So it flags everything?"** It ranked one book at 152 and the runner-up at
   24 — and the highest-scoring match after the case is the deliberate false
   positive, which the same screen exonerates in one click: controls present,
   reviews done, P&L explained. The tool assembles evidence in both directions;
   a human closes the case.
6. **"How do you handle time?"** The rules are temporal — SLAs, windows,
   as-of evaluation (set as-of to mid-2022 and watch rows turn PENDING). The
   pattern is atemporal **by design** in v1: it matches shape, not sequence.
   Sequence-aware comparison exists as trajectories under the Technical toggle,
   for technical audiences.

---

## Video synopsis (make video)

Executive cut, 6–7 minutes, from the scene blocks above in document order —
no Discovery, no explainers, no glossary. The **Assistant scene runs last**
(below), wrapped in before/try/wait-any/fast-forward as the recorder requires;
the ingest waits and the model's tool calls are fast-forwarded with a labelled
badge. Title card: **"Fraudulent valuation — from weak signals to read-across"**.
Narration is 2–3 sentences per scene; audio is cached by text hash; regenerate
with `make video` and check the contact sheet before committing.

```scene
id: assistant-question
before: acts 0–4 recorded; companion panel closed by the recorder.
actions: Assistant tab; click the first suggested question; tool calls fast-forwarded; wait for the answer (retry once with a typed question; fail loudly after that).
shot: the answer opening on POS-TP's financial timeline, tables and subgraph one toggle away.
narration: The assistant answers the same investigation in natural language,
  composing typed tools over the same audited queries — it is not free-form
  text-to-Cypher. Because the question is about one position, the answer opens
  on its financial timeline.
```

```scene
id: outro
before: the assistant answer on screen.
actions: hold on the answer.
shot: the financial timeline inside the assistant's answer.
narration: One graph carried the whole story: real market data, rule-generated
  governance, a confirmed case, and read-across to the entire population. The
  graph does not detect fraud. It detects the shape fraud leaves behind. A human
  establishes intent.
```

---

## Appendix — Discovery (technical audiences)

> Toggle **Technical** in the top bar (off by default, never persisted). Three
> prose scenes, deliberately without `scene` blocks — the video recorder must
> never pick them up. Each panel carries a **"How it works"** explainer;
> explainers open **on request only**. Every panel ends on a button that writes
> into the main flow, shows its evaluation next to its result, and is undone by
> **Reset Discovery**.

**Scene D1 — Approval circles.** Who approves whose overrides, as a structure:
circles of mutual sign-off, coloured in the view; circles containing no
independent control function highlighted. On this dataset the case's closed
desk-head/trader circle falls out unprompted. Honesty line on screen: at 60
people this is visible by eye; at scale it is not; nothing here is a finding.
**End on the output button**: *Propose as rule* → candidate **R-C1** in the
Policy step, badged, evaluated by nothing until a human promotes it.

**Scene D2 — Trajectories.** Each position's recent control history as a
deterministic fingerprint — an atom (event type, rule, role, desk) per time
band; nothing is learned; the same history shifted in time gives the same
fingerprint. Similarity is read **in words** ("0.8× R3 gaps ≈91 d ago"), with
two fingerprint heatmaps side by side. The evaluation line states the retrieval
check against the population share, and the held-out check with its sample size
("too few to conclude"). **End on the output button**: *Add to watchlist* → the
neighbour lands in S4 with its provenance.

**Scene D3 — Peer decorrelation.** Weekly trader marks against the peer group,
in the same graph as the approvals. Five books decorrelate: the confirmed case
(inside its override window), the false positive (at the 2022 shock), two
explained recalibrations, one live near-miss. **End on the output buttons**:
*Add as rule R10* — the same gap query immediately renders the verdicts, two
MISSED, the rest MET, because R10 demands a review that *addresses* the
divergence, not one that merely occurs — and *Use behaviour clusters as
attributes* for S3/S4. Then click **Reset Discovery** and show S1–S4 unchanged.

---

## Bibliography (public case — sources exactly as cited in `inputs/public_true_positive_2012.csv`)

Every number about the public case shown in the demo comes from this file, with
its source in the `source` column. The sources cited there:

- **US Senate Permanent Subcommittee on Investigations**, *JPMorgan Chase Whale
  Trades: A Case History of Derivatives Risks and Abuses* (report + hearing
  record + press release, March 2013) — chapters I, III, IV; findings; hearing
  exhibits 1f, 1i, 77.
- **SEC press release 2013-154** (charges against two former traders).
- **JPMorgan Chase filings**: 10-Q Q2/Q3 2012, 8-K 2012, 10-K 2012 (restatement
  and transfer disclosures).

The bibliography deliberately lists nothing else: if a fact about the case is
not in the CSV with one of these sources, it is not claimed anywhere in the demo.
