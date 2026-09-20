# Mismarking Detection on Neo4j — 25-minute Walkthrough

**Audience**: senior operational-risk managers (RISK ORM), experts in IPV, P&L attribution,
controls and read-across — new to graphs. Explain nothing about the business;
explain everything about how to read the screen.

**The one-sentence thesis** (say it twice — at the start and at the end):
> **The graph does not detect fraud. It detects the conjunction of weak signals that
> fraud leaves behind — a human establishes intent.**

Two capabilities decide the deal, and each has its own act:
- **Read-across** (Act 3–4): abstract one confirmed case into an instrument-agnostic
  pattern and run it across the whole population.
- **Early detection** (Act 4): partial matches and predicted links *before* the
  pattern completes.

---

## Prerequisites (before the audience arrives)

```bash
make data          # one-time: downloads & caches OSBAP/FITRS/FRED, generates the layers
cd app && npm install && npm run dev    # http://localhost:5173
```

(Vite picks the next free port — 5174, 5175… — if other dev servers are running;
check the terminal line before opening the browser tab you'll present from.)

`inputs/.env` holds the Neo4j credentials and the Gemini key (`make env` derives
`.env` and `app/.env`). The **flow is Explore → Policy → S1 → S2 → S3 → S4**: the
Policy step is where the bank's control framework is formalised and the gaps are
computed — **S1 stays locked until "Compute governance gaps" has run once** in the
session. Every threshold is an indicative placeholder (per-rule provenance with
verified public-source quotes: `docs/rules-provenance.md`); load the customer's own
values before the demo if they sent them — the panel exists so you can change them
live when asked.

Run `make explain` after `make data` (and again after changing Policy defaults —
the cache key includes the active parameters): it pre-generates the AI-companion
explanations for the whole scripted path, EN and FR, so every Explain click during
the demo is instant and marked "pre-generated". Off-script clicks fall back to a
live Gemini call; if that fails the panel shows a one-line error and nothing else
is affected.

The **Glossary** toggle (top bar) is a preparation and onboarding aid — dotted
terms with one-line definitions and a "show me in the graph" click-through. Keep it
**OFF during the executive demo**: the audience knows the vocabulary.

**The grounding answer, once for the whole demo** (someone WILL ask "is this
hallucinating?"): the companion receives exactly what is on screen — the scene id,
the rows the scenario query returned, the active ControlObligation parameters and
the Cypher that produced them — and is instructed to say "not shown here" for
anything else. Open the Cypher drawer and expand a companion entry's
`contextSent`: the entire prompt context is auditable, like every query.

Start from an **empty database** (Explore → Reset database): the ingest is part of
the show.

Timing: Act 0 ≈ 5 min · Policy ≈ 2 min · Act 1 ≈ 4 min · Act 2 ≈ 6 min · Act 3 ≈ 3 min ·
Act 4 ≈ 5 min · Assistant ≈ 2 min. Keep the Cypher audit drawer closed until the first time someone
asks "what did it just run?" — then never close it again.

---

## Act 0 — Explore: three layers, ingested live

> **Tab: Explore**

### 0.1 — Ingest, layer by layer
Click the three ingest buttons in order, narrating what each layer *is*:

1. **Market — real data.** ~3,000 real illiquid US corporate bonds from the public
   TRACE panel (144A and/or <5% of days traded, alive through the 2022 rate shock),
   ESMA's own liquidity assessments where they exist, US Treasury curves from FRED.
   *Talking point:* "Nothing in this layer is invented. These are real bonds with
   real prices; the 2022 rate shock is in the data because it happened."
2. **Governance — synthetic, generated from rules.** ~100 positions, ~20 desks,
   ~60 people, 3 years monthly. *Talking point:* "We took nine control obligations —
   the kind your Valuation Policy already contains — and generated the *observed*
   events from them with a per-desk compliance rate. The misses you'll see were
   never hand-placed: the same query you'll watch running computes them."
3. **Cases — one confirmed public case, one deliberate false positive.**
   *Talking point:* "The true positive is a well-documented 2012 mismarking case,
   encoded event by event from the public record — you'll see the citations in the
   audit drawer. We shifted its clock +10 years to sit inside the demo window; every
   event keeps its authentic date."

Watch the counters fill. Point at the line "computing governance gaps (expected vs
observed)" — that sentence is the product.

### 0.2 — One position, revealed one hop at a time
Select **POS-TP**. Add the instrument, the desk, the owner. Add the price chart:
trader marks vs dealer midpoints, drifting apart through Q1.
*Talking point:* "Today this reconstruction is a week of manual work across five
systems — marks, IPV, P&L, approvals, committee minutes. Here it's one graph, and
I'm choosing to reveal it one hop at a time. We never open on the full graph;
neither should your analysts."

Add the signals one at a time: PnL signals… price overrides… methodology changes…
IPV reviews… governance gaps. *Talking point:* "Watch the shape form. Every single
node you just saw is, on its own, below threshold somewhere."

**The node inspector, once for the whole demo:** click any node, in any graph view
(here, S1, S3, the Assistant's answers). A panel opens with the node's properties,
its relationship summary (`← ON_POSITION × 47`, `→ OVERRIDDEN_BY × 12`…), and —
for case events — the public-record citation in a "Source:" box. The lookup runs
through the same audited query path as everything else. Where the node is
position-anchored, the inspector offers **Open in Explore →**; on desks, rules,
patterns or attributes it deliberately doesn't — Explore starts from a Position.

**✦ Explain beat:** click the POS-TP node, then **✦ Explain** in the inspector.
The companion panel opens with a grounded 3–5 sentence read of the node and its
neighbourhood — toggle **FR** if the room prefers French. Point at the
"pre-generated" badge and say the live fallback exists for anything off-script.

---

## Policy — the bank's control framework, formalised

> **Tab: Scenarios → Policy · Control framework** (the second step of the flow)

Walk the nine rules. Say the honesty sentence verbatim: **"Formalisation of the
bank's own control framework. Default values are indicative placeholders, to be
replaced by the institution's thresholds."** Hover a **Source** label: each rule
carries the public source it *echoes* — a regulatory requirement (CRR Art. 105),
supervisory guidance (SR 11-7) or a public case finding (Senate PSI, SEC) — with
the verbatim quote and link; "regulation-informed" appears only where the status
warrants it. Never claim a threshold is regulation-derived; the full provenance
table is `docs/rules-provenance.md`.

Then the visible step: click **Compute governance gaps**. One parameterised query
evaluates all nine rules over every position, expected vs observed, and
materialises the gaps — the counts per rule (MET / LATE / MISSED) appear, and S1
unlocks. *Talking point:* "The rules you just saw are data, not code. This button
is the whole detection engine — everything after this screen only reads what it
computed."

---

## Act 1 — S1 Conjunction: below threshold alone, a shape together

> **Tab: Scenarios → S1**

**The business problem (say it before clicking):** every control function sees its
own column — IPV sees divergence, Product Control sees unexplained P&L, MAP sees
review calendars. Each is below its threshold. Nobody sees the row.

Run the conjunction query live. POS-TP ranks first; note which *other* positions
score high (the sloppy desks). Clicking a row now opens **the financial timeline
first** — the investigator's native language: observed prices as candles (real
OHLC when several trades printed) or ticks, gaps left as gaps; the model price as
a continuous line — *the distance between line and candles is the divergence*;
one marker per governance event; dashed vertical lines where a control came due
and never fired; the cumulative broken-control score below; per-rule score bars
alongside. Click a marker: date, role, trader mark / model price / IPV price
(written on the event by the generator, never recomputed client-side), the rules
it concerns, and "Open in graph".

Then click **Show graph** — the network is one click away, not the opening shot —
and run community detection: the community around POS-TP lights up, the rest
greys out.

*Talking point:* "This is not an anomaly score on a column. The chart is what your
first line already reads — price against model. The graph behind it is what they
don't have: the count of connected weak signals around one position. The community
colouring is the same idea topologically: the pattern IS the neighbourhood."

**✦ Explain beat:** click **✦ Explain** on the ranking card. The companion
restates, from the rows alone, why the top position's mix of signals is
informative — and what to check next. This is the moment to open the Cypher
drawer once and show the `contextSent` expander: rows + policy parameters +
the query, nothing else.

**Objection you will get — "we already have quant tools for outlier marks."**
Answer: "So did the bank in the public case; its VaR model had just been changed to
say everything was fine. Quant tools score positions column by column, in isolation.
This screen scores the *conjunction across your silos* — marks, approvals, IPV, P&L,
org structure — which is where the 2012 case actually lived. And in Act 3 the output
is not a score, it's a reusable pattern."

---

## Act 2 — S2 Chronology: which control should have fired, and didn't

> **Tab: Scenarios → S2** (this screen is also what the Assistant answers)

**The business problem:** post-incident forensics take weeks and produce a PDF.
Supervisors now ask for the chronology *and* the control-expectation gap on demand.

Reconstruct POS-TP. The **financial timeline** opens above the chronology — the
same component as S1, so the room has already learnt to read it: marks flat while
the model price falls, the override markers clustering exactly where the dashed
missed-control lines stand. Click one override marker: the popover shows the
trader mark, the model price and the IPV price *carried by the event node itself*,
its divergence, the rules it concerns with their status — and "Open in graph"
opens the node in the Explore graph (or selects it in place when an NVL view is
already on screen), flashing its chronology row on the way.

Then walk the event timeline of POS-TP top to bottom — it reads like the public record because
it is the public record: the VaR model change, the informal switch away from
midpoints, the override series with a desk-head sign-off, the spreadsheet that
quantified the gap and went nowhere, the quarter-end IPV that *upheld* the marks,
the collateral disputes, the incident, the restatement.

Then the expected-vs-observed table. Every row is one obligation evaluated by ONE
parameterised query reading the thresholds off the policy nodes. Point at:
- **R1 MISSED** — the marking-practice change had no approval at all;
- **R5 MISSED** — the IPV review that happened *and stopped nothing* ("control
  executed ≠ control effective — this is the row that proves the difference");
- **R8 MISSED** — the desk head approving his own desk's overrides.

Set **as-of = mid-2022 (mid-case)** and rerun: some rows flip to PENDING.
*Talking point:* "Same query, evaluated as of any date. That's early detection, not
hindsight: this table existed *before* the loss announcement."

Open the audit drawer on the R5 row: the `sourceRef` cites the Senate report page.
*Talking point:* "Every claim on this screen is one click from its query and, for the
case, one click from the public record."

**✦ Explain beat:** click the small **✦ Explain** on the R5 gap row (the review
that upheld the marks). The companion narrates that single gap — trigger, SLA,
what was observed instead — in strict chronological order with event ids. If a
francophone risk manager is in the room, flip **FR** and click again: same
grounding, same citation discipline.

---

## Act 3 — S3 Abstraction: the pattern is a template, not a lookup

> **Tab: Scenarios → S3**

**The business problem:** read-across today means an analyst re-reading incident
reports and manually listing 'books like this one'. It doesn't scale and it anchors
on instrument identity.

Create the Pattern live from the confirmed incident. Show what it contains — and
what it doesn't: *no instrument name, no desk, no dates, no people.* Only risk
attributes (illiquid, dealer-quoted, long-dated) and governance-gap classes (no
pre-approval, unresolved IPV divergence, recurring unescalated overrides…).

*Talking point:* "This is the read-across you already do in your head, made
executable. The pattern matches *attributes*, never instrument fields — that's a
design rule in the model, not a convention."

**✦ Explain beat:** click **✦ Explain** on the pattern card. The companion
describes the template from its REQUIRES list only — and, because instrument
identity is not in its context, it *cannot* name the underlying book. That absence
is itself the demonstration.

---

## Act 4 — S4 Read-across: the whole population, ranked; the false positive, exonerated

> **Tab: Scenarios → S4**

**The business problem:** after every public incident the question is "do we have
one?" — and the honest answer today is "give us three weeks per portfolio."

Run the pattern against all ~100 positions. Read the screen:
- **Exact matches** at 1.0 — the confirmed case matches itself (sanity check, say so).
- **Partial matches ranked** — "score = satisfied requirements / total. 5/7 today is
  a case file *before* the loss, not after. That is the early-detection story."
- **📈 timeline on any match row** — expand the financial timeline in place: for a
  true near-miss you see the price story forming; for the false positive you see
  prices tracking the model and only three dashed lines (R2, R4, R6 — all
  process-lateness, no price story). The chart is the fastest exoneration.
- **✦ Explain beat:** click the small **✦ Explain** on the POS-FP match row
  *before* jumping to its chronology: the companion reads the score from the
  satisfied/missing lists — which conditions matched, which did not — and says
  what to audit next. Then follow its advice by clicking through:
- **POS-FP near the top.** Click it → the app jumps back to S2 with its chronology:
  methodology change *after* the 2022 rate shock, committee-approved in advance,
  IPV done (late), P&L explained (late), MAP review after the regime break.
  *Talking point:* "The shape matched — and the graph shows you the controls that
  DID happen, in one click. The tool doesn't accuse; it assembles both the signals
  and the exculpatory evidence. A human closes the case. That's the design."

**Objection — "so it alerts on everything."**
Answer: "Nothing here is an alert. It's a ranked match against a pattern *you*
authored, with *your* policy parameters — edit the divergence threshold to 100 bps
right now (Policy panel) and watch the ranking change without regenerating anything.
The false positive is in the demo on purpose: the cost of a match is one click of
review, not an investigation."

Widen the pattern live (add a REQUIRES, e.g. issuer sector) and rerun.
*Talking point:* "Pattern size is not self-censored — you can make it as broad or as
narrow as your risk appetite, live, in front of the committee."

Then the predicted links: "we removed six known position-attribute links at
generation time; the similarity algorithm recovers most of them — it says so on
screen. **Held-out ground truth, not circular confirmation.**"

**Objection — "link prediction proving what you planted is circular."**
Answer: "Correct — which is why the screen only claims recovery of links that exist
in reality and were *hidden from the algorithm*. In production you'd do the same
with a temporal split: train on last year, validate on what this year revealed. The
demo's honesty about this is deliberate: if a vendor shows you link prediction
without a holdout, ask them this question."

---

## Assistant — the chronology, in natural language

> **Tab: Assistant**

Type (or click the chip):

```
Reconstruct what happened to POS-TP, in order, and tell me which control should have fired.
```

The model composes only typed tools over the same query functions the tabs use — no
free-form text-to-Cypher — and every statement it triggers lands in the audit drawer.
Under the answer, flip the **graph / table** toggle: the same subgraph the tools
returned, in the scenarios' colours with the timeline pinned left-to-right in event
time — or sortable grids whose event ids jump straight into Explore's node
inspector. Clicking a node in the answer graph inspects it in place (same inspector
as everywhere else); its **Open in Explore →** button does the jump when the node is
position-anchored. The suggestion chips never disappear: the one you clicked is
replaced by a contextual follow-up, so the conversation path is always one click
away.
*Talking point:* "This was one of your validation criteria: a natural-language,
chronological investigation. Note that it answers with control obligation IDs from
your own policy, and that the drawer shows exactly what it ran — the assistant has
no private access path."

Follow-up if time: `Why is POS-FP not an incident?`

---

## Wrap-up — why this matters

| Layer | What it does | What it cannot do alone |
|---|---|---|
| Your quant/IPV tooling | scores marks column by column | see the conjunction across silos |
| This graph | connects marks, controls, approvals, people, time; abstracts one case into a population-wide, parameterised pattern | establish intent |

Close with the thesis, third time: **the graph detects the conjunction of weak
signals fraud leaves behind; a human establishes intent.**

---

## Objections cheat-sheet (compressed)

1. **Circular link prediction** → held-out ground truth on screen; temporal splits in production; distrust anyone who shows link prediction without a holdout.
2. **"We already have quant tools"** → they score columns per position; the value here is cross-silo conjunction + executable read-across + on-demand chronology with an audit trail. Complement, not replacement.
3. **"It alerts on everything"** → no alerts: ranked matches against patterns you author with your policy's parameters, editable live; the deliberate false positive shows the cost of a match is one click of exculpatory review.
4. *(bonus)* **"The 2012 case is derivatives, we're bonds"** → the pattern never contains instrument identity — that's the point of RiskAttributes; the demo runs it over a real bond population.

---

## Bibliography (public true positive — sources from `inputs/public_true_positive_2012.csv`)

- US Senate Permanent Subcommittee on Investigations, *JPMorgan Chase Whale Trades:
  A Case History of Derivatives Risks and Abuses*, report, 15 March 2013 — incl.
  ch. III (risk limits), ch. IV "Hiding Losses" ($161m reported vs $593m at midpoints
  by 16 March 2012; $512m mid-vs-used difference at 31 March; collateral disputes
  peaking at $690m; the 10 April $6m→~$400m re-issue; the 23 March stop-trading order).
- PSI hearing record and exhibits, 15 March 2013 — incl. exhibit 77 (OCC e-mails:
  CIO VaR change effective 27 Jan 2012, VaR −44% to ~$57m), exhibit 1f (inaccurate
  public statements of 13 April 2012), exhibit 1i (timeline).
- JPMorgan Chase & Co., Form 10-Q Q2 2012 and Q3 2012; Form 8-K, 13 July 2012
  (restatement of Q1 2012, pre-tax income overstated by $660m; SCP transfer to CIB
  on 2 July 2012); Form 10-K 2012 (Task Force report; OCC Cease & Desist).
- U.S. SEC, press release 2013-154, 14 August 2013 (charges against two former CIO
  traders for fraudulent mismarking; "most aggressive end of the dealers' bid-offer
  spread"; "desired daily loss target").

**Data sources (market layer)**
- Open Source Bond Asset Pricing — stage-1 daily TRACE panel (Enhanced + Standard +
  144A), openbondassetpricing.com.
- ESMA FITRS non-equity transparency full files (FULNCR…_D_…): quarterly bond
  liquidity assessments (`<Lqdty>`), registers.esma.europa.eu.
- FRED, U.S. Treasury constant-maturity yields (DGS series), fred.stlouisfed.org.

---

## Video storyboard (make video)

The blocks below are the machine-readable source for `make video`
(`scripts/record_demo.py` parses them; `scripts/tts.py` narrates them;
`scripts/assemble_video.py` cuts `dist/demo.mp4`). Each fenced `scene` block has a
stable `id:` (the recorder maps ids to UI actions — do not rename without updating
`record_demo.py`), an `action:` line documenting what the recorder does on screen,
and a `narration:` of 2–4 presenter-voice sentences. English only. Edit narration
freely; re-run `make video` (audio is cached by text hash).

```scene
id: intro
action: Explore tab on an empty database (the recorder resets it first).
narration: The graph does not detect fraud. It detects the conjunction of weak
  signals that fraud leaves behind, and a human establishes intent. Over the next
  few minutes we bootstrap this demo from an empty database and follow one
  confirmed mismarking case end to end.
```

```scene
id: ingest-market
action: Click Ingest on layer 1 · Market; wait for "Loaded".
narration: The first layer is real public data. Three thousand illiquid US
  corporate bonds from the public TRACE panel, ESMA's own liquidity assessments,
  and Treasury curves for the proxy methodology. Nothing in this layer is
  invented, and the twenty-twenty-two rate shock is in the data because it
  happened.
```

```scene
id: ingest-governance
action: Click Ingest on layer 2 · Governance; wait for "Loaded".
narration: The second layer is synthetic governance, generated from rules. Nine
  control obligations drive the creation of reviews, approvals and escalations
  with a compliance rate per desk. The gaps you will see were never hand-placed;
  the same query the app runs computes them, expected versus observed.
```

```scene
id: ingest-cases
action: Click Ingest on layer 3 · Cases; wait for "Loaded".
narration: The third layer holds two cases. A confirmed public mismarking case
  from twenty-twelve, encoded event by event from the public record with its
  citations, and one deliberate false positive whose controls actually worked.
  The clock is shifted ten years so everything sits on the same demo timeline.
```

```scene
id: schema-peek
action: Click the eye on the governance layer card; popover with the layer mini-schema + 5 live sample rows.
narration: Every layer card carries an eye. One click opens a live peek at what
  was just loaded: the labels, how they relate, and five real rows sampled
  straight from the graph — the same audited query path as everything else. This
  is the map an analyst gets before any scenario runs.
```

```scene
id: explore-position
action: Select POS-TP; steps 1, 2, 3 — position, structure, price vs proxy chart.
narration: We start from one position, never from the full graph. One click adds
  its instrument, desk, owner and valuation methodology. The chart shows trader
  marks drifting away from dealer midpoints through the first quarter — that gap
  is the story, and today reconstructing it takes days across five systems.
```

```scene
id: explore-signals
action: Add the five signal families one click at a time.
narration: Now we add the signals one family at a time. P and L signals, price
  overrides, methodology changes, IPV reviews, and the computed governance gaps.
  Watch the shape form. Every single node you see is, on its own, below threshold
  somewhere.
```

```scene
id: policy-framework
action: Scenarios → Policy; the nine rules with editable placeholders and Source labels.
narration: Before any detection, the policy. These nine rules formalise the bank's
  own control framework — every threshold an indicative placeholder, to be replaced
  by the institution's values. Each rule carries its provenance: the public
  requirement, guidance or case finding it echoes, quoted and linked. Never a claim
  that a number came from regulation.
```

```scene
id: policy-compute
action: Click Compute governance gaps; per-rule MET/LATE/MISSED counts appear; S1 unlocks.
narration: This button is the detection engine. One parameterised query evaluates
  all nine obligations over every position, expected versus observed, reading the
  thresholds live off the policy nodes — and materialises the gaps. Met, late,
  missed, counted per rule. Everything after this screen only reads what it just
  computed.
```

```scene
id: s1-conjunction
action: Scenarios → S1 → Run the conjunction query; the top position's FINANCIAL timeline opens first.
narration: Scenario one asks where weak signals cluster, and the confirmed case
  tops the ranking by a factor of six. What opens first is the investigator's
  native language: the price. Trader marks hold firm while the model price falls
  away — that distance is the divergence — and every dashed line is a control that
  came due and never fired.
```

```scene
id: s1-community
action: Click Show graph, then run GDS Louvain; the position's community coloured, the rest greyed.
narration: The network is one click away, never the opening shot. And community
  detection makes the same point topologically: the coloured cluster is the
  neighbourhood of the suspect position, everything grey is the rest of the book.
  The pattern is not a score on a column — the pattern is the neighbourhood
  itself.
```

```scene
id: s2-chronology
action: S2 → Reconstruct POS-TP; financial timeline above the chronology with authentic-date badges.
narration: Scenario two reconstructs the case in event time, under the same price
  timeline. A risk-model change, an informal switch away from midpoints, a weekly
  series of favourable overrides signed off by the desk head, the spreadsheet that
  quantified the gap and went nowhere. Each event keeps its authentic date from
  the public record.
```

```scene
id: s2-gaps
action: Scroll to the expected-vs-observed table.
narration: Below the timeline, one parameterised query evaluates all nine control
  obligations. Rule one missed: the marking change had no approval. Rule five
  missed: the quarter-end review happened and upheld the marks — control executed
  is not control effective. Rule eight missed: the desk head approved his own
  desk's overrides.
```

```scene
id: s3-pattern
action: S3 → Abstract the confirmed case into a :Pattern.
narration: Scenario three abstracts the confirmed case into a pattern. Look at
  what it contains — and what it does not. No instrument name, no desk, no dates,
  no people. Only risk attributes and governance-gap classes. It is a template,
  not a lookup.
```

```scene
id: s4-readacross
action: S4 → Run read-across; every position scored against the pattern.
narration: Scenario four runs that template against the whole population at once.
  The confirmed case matches itself at one hundred percent — that is the sanity
  check. Everything between fifty and one hundred percent is the early-detection
  story: the same shape forming on other books, before any loss.
```

```scene
id: s4-predict
action: GDS link prediction against the held-out links; recovery stated on screen.
narration: The predicted links come with their own honesty check. Six real links
  were removed from the graph at generation time, and the similarity algorithm
  recovers most of them. That is validation against held-out ground truth, not
  circular confirmation — and the screen says so explicitly.
```

```scene
id: s4-false-positive
action: Click the POS-FP match row; the app jumps to its S2 chronology.
narration: This high-scoring match is the deliberate false positive. One click
  opens its chronology: the methodology change was approved in advance by an
  independent committee, IPV was done, the P and L was explained. The shape
  matched, the governance worked, and a human closes the case. The tool does not
  accuse; it assembles both the signals and the exculpatory evidence.
```

```scene
id: policy-change
action: Policy panel → set R5 divergence threshold to 100 bps → Apply → Reset.
narration: Every threshold in those rules belongs to the policy, not to the code.
  Here we raise the IPV divergence threshold to one hundred basis points and
  recompute the gaps live — no data regeneration, no redeployment. And one click
  restores the defaults.
```

```scene
id: explain-click
action: Back to S2; click Explain on the expected-vs-observed card; the AI companion answers.
narration: The AI companion explains what is on screen — and only what is on
  screen. It receives the rows, the active policy parameters, and the Cypher that
  produced them; nothing else. If something is not in that context, it says it is
  not shown rather than guessing. The full payload is auditable in the Cypher
  drawer.
```

```scene
id: assistant-question
action: Assistant tab → ask "Reconstruct what happened to POS-TP…" via the first chip.
narration: The assistant answers the same investigation in natural language. It
  composes typed tools over the same audited query functions — it is not free-form
  text-to-Cypher. And because the question is about one position, the answer opens
  on its financial timeline — the subgraph in event-time order and the raw tables
  are one toggle away.
```

```scene
id: outro
action: Hold on the assistant answer's graph view.
narration: One graph carried the whole story: real market data, rule-generated
  governance, a confirmed case, read-across to the entire population, and early
  detection with an audit trail on every claim. The graph detects the conjunction
  of weak signals fraud leaves behind. A human establishes intent.
```

---

## Appendix — Discovery (technical audiences only)

> **Not part of the executive demo or the video.** Toggle **Technical** in the top
> bar to reveal the Discovery tab — a hood to open in a dry run or PoV, for the
> audience that asks "and what does the graph find that we did NOT describe?".
> Sub-header carries the whole thesis: *"Rules find what you described. Structure
> finds what you didn't. Then structure becomes a rule."* Naming discipline: the
> tab never says GDS, algorithms, machine learning or prediction. Everything runs
> through the audited query path; projections are dropped after use; **Reset
> Discovery removes every write** — nothing persists into S1–S4 unless a panel's
> output button put it there. These are prose scenes, deliberately NOT fenced
> `scene` blocks: the video recorder must never pick them up.

### Discovery scene 1 — Approval circles

Open Discovery → **Find approval circles**. Who approves whose overrides, as a
structure: the communities of the weighted approval graph, coloured in the view,
summarised as circle → members → desks covered. Point at the highlighted rows:
circles containing **no independent control function**. On this dataset the CIO
desk-head/senior-trader pair falls out on its own — no rule said "same desk";
the structure did. Read the honesty line aloud: *"At 60 people this is visible
by eye. At your scale it is not. Nothing here is a finding; it is a hypothesis
for a rule."* **End on the output button**: *Propose as rule* → candidate
**R-C1** appears in the Policy step, badged "candidate — found by structure, not
validated", evaluated by nothing until a human promotes it.

### Discovery scene 2 — Trajectories

**Compare trajectories** against POS-TP. Each position's recent control history
becomes a deterministic fingerprint — an atom (event type, rule, role, desk) per
time band; nothing is learned, nothing is predicted; the same history shifted in
time gives the same fingerprint, which is what makes periods comparable. Show
the two heatmaps (reference vs neighbour) and the similarity *in words* ("0.8×
R3 ≈91 d ago") — the point of reimplementing the published FastPath algorithm
(inputs/fastpath_worked_example.md is the test oracle; on Aura Graph Analytics
this is a built-in, self-managed support is announced for 2027 — reimplemented
here so the score can be read). Point at the evaluation line: recall over the
four held-out positions vs the chance baseline — and when it reads ≈ chance,
say so; the shortlist is a hypothesis, not evidence. **End on the output
button**: *Add to watchlist* → the neighbour lands in S4 with its reason.

### Discovery scene 3 — Peer decorrelation

**Compute peer correlations**. Weekly trader marks against the peer group, in
the same graph as the approvals — "your quants compute this already; what is new
is that the signal sits next to the controls, so it can be one condition among
the others." Exactly two books decorrelate: POS-TP (flat marks that never
tracked peers — the signal fires months before any control noticed) and POS-FP
(frozen at the stale model through the 2022 shock). **End on the output
buttons**: *Add as rule R10* → the same gap query immediately renders the
verdicts — **TP MISSED, FP MET** (its pre-approved methodology change explains
the decorrelation; the marks re-correlate right after) — and *Use behaviour
clusters as attributes* → market-derived, instrument-agnostic peer groups S3/S4
can match on. Then click **Reset Discovery** and show S1–S4 unchanged.
