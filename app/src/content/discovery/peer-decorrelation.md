# Log returns

Weekly trader marks become **log returns**:

$$r_t = \ln\!\left(\frac{P_t}{P_{t-1}}\right)$$

Log returns add across weeks and put a 52-priced bond and a 118-priced bond on the same scale — the *move*, not the level, is what can correlate.

---

# Rolling Pearson over the window

For each week $t$, the position's last $w = 8$ returns are correlated with its **peer mean** return series (peers sharing methodologyFamily + liquidityTier, excluding the position itself, ≥3 peers required):

$$\rho = \frac{\sum_{i}(x_i - \bar{x})(y_i - \bar{y})}{\sqrt{\sum_i (x_i - \bar{x})^2}\,\sqrt{\sum_i (y_i - \bar{y})^2}}$$

One convention matters here: a **frozen** mark series has zero variance, and we define its correlation as **0** — a book that stops moving stops correlating; it must not escape on a division-by-zero technicality.

---

# The peer clusters

Separately from the signal, each position's return vector goes through **kNN with Pearson similarity** (top 10) → `CORRELATES_WITH` relationships; **Louvain** over the strong edges (≥ 0.5) yields **behaviour clusters** — books that move together *in fact*, whatever their sector label says. The second output button writes them as `behaviourCluster` risk attributes, so read-across (S3/S4) can match on market behaviour, not just static traits.

---

# The signal rule

A `DecorrelationSignal` fires when $\rho <$ `decorrThreshold` (0.45) for `decorrPeriods` (2) **consecutive** windows — dated at the **first** breach, so the marker sits where the behaviour started, not where the maths noticed. It lands in the graph as an event on the position: visible on every financial timeline, one condition among the others.

---

# Why the false positive decorrelates too — and what R10 checks instead

Decorrelation is **not** an accusation: POS-FP fires exactly like the case, because its model went stale at the 2022 shock. What separates them is *what happened next*, and that lives in the governance graph, not in the price series. **R10** requires a **pre-approved** methodology change effective around the signal (approval at or before its effective date), **or** an IPV review that **addresses** the divergence — adjustment/challenge evidence, or an explicit `adjusted` / `challenged` / `explained` outcome. POS-FP: recalibration approved Oct 12, effective Oct 20 → **MET**, and its marks re-correlate immediately. POS-TP: nothing but a post-hoc-approved VaR change → **MISSED**. "Pre-approved" is one load-bearing word; "addresses" is the other.

---

# Why "the IPV ran" is not a control

In the public case the quarter-end valuation review **occurred** — and **upheld** the marks (a divergence of 600 bps, judged "within tolerance"). That is why R10's second clause does not accept mere occurrence: a review with outcome `no finding`, `within tolerance`, or with no evidence attached, satisfies nothing. This is R5's lesson applied to a structure-born rule — **control executed ≠ control effective** — and it is what keeps a monthly IPV heartbeat from silently exculpating every decorrelation on real data.

---

# How the honest marks were made honest

It took three iterations, recorded in DECISIONS #22: carry-forward marks made every illiquid book flatline between prints (97/97 false signals), and adding an idiosyncratic drift term still swamped the tiny cross-sectional factor. Honest books are therefore marked **to the shared model** — their weekly return IS the cross-sectional factor plus noise — which is both the realistic behaviour of model-marked illiquid books and what makes peer correlation the norm whose absence means something.

---

# Limits on this dataset

- **Synthetic circularity**: every decorrelation here is planted (two cases, two benign, one near-miss) — the panel demonstrates that the *same* signal separates them via governance, not that the threshold generalises.
- **Sample size**: ~95 books, weekly marks, one peer factor. Real desks have richer factor structure; 0.45/8w/2 are placeholders like every other threshold.
- **Your quants compute this already** — the demo's claim is only about where the signal *lives*: in the same graph as the approvals.

Full notes: `docs/rules-provenance.md` (R10) and `DECISIONS.md` #22.
