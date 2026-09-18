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
`.env` and `app/.env`). Set Policy-panel parameters **before** the demo if the
customer sent their own thresholds; the panel exists so you can change them live
when asked.

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

Timing: Act 0 ≈ 5 min · Act 1 ≈ 4 min · Act 2 ≈ 6 min · Act 3 ≈ 3 min · Act 4 ≈ 5 min ·
Assistant ≈ 2 min. Keep the Cypher audit drawer closed until the first time someone
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

## Act 1 — S1 Conjunction: below threshold alone, a shape together

> **Tab: Scenarios → S1**

**The business problem (say it before clicking):** every control function sees its
own column — IPV sees divergence, Product Control sees unexplained P&L, MAP sees
review calendars. Each is below its threshold. Nobody sees the row.

Run the conjunction query live. POS-TP ranks first; note which *other* positions
score high (the sloppy desks). Then run community detection: the community around
POS-TP lights up, the rest of the graph greys out.

*Talking point:* "This is not an anomaly score on a column. It's a count of
connected weak signals around one position. The community colouring is the same
idea topologically: the pattern IS the neighbourhood."

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

Walk the timeline of POS-TP top to bottom — it reads like the public record because
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
