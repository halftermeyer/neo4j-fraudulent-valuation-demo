# The six FastPath steps, with our parameters

1. **Atoms** — each event contributes categorical atoms: its **type** (PriceOverride, Escalation…), the **rule id** for computed gaps, the **approver/performer role**, the **desk**.
2. **Filter** — an event counts iff $0 < t_h - t_e \le \Theta$ with $\Theta = 365$ d: strictly before the output time $h$, not older than a year.
3. **Grid** — elapsed time lands on $g = 5$ anchors evenly over $[0, 365]$: $\{0, 91, 183, 274, 365\}$ days.
4. **Smoothing** — each event spreads over its nearest anchor $\pm 1$ step with weights $\propto e^{-\lambda\,|\tau - \text{elapsed}|}$ ($\lambda = 0.02$/d), **normalised over the (boundary-truncated) window**.
5. **Decay** — the event's contribution is scaled by $e^{-\gamma \cdot \text{elapsed}}$ ($\gamma = 0.005$/d): recent history counts more.
6. **Sum** — the position's trajectory is the sum over its surviving events. Deterministic, no fitting, no training.

---

# Proven against the published example

The reimplementation reproduces the published worked example (Neo4j PS deck; `inputs/fastpath_worked_example.md`) **to 4 decimals**, in both mirrors (Python and TypeScript, same suite each):

| | published | ours |
|---|---|---|
| emb(e1), elapsed 7 | (−0.0931, 1.0000, 0.7561, −0.7561) | ✓ |
| emb(e2), elapsed 1 | (1.0000, −0.2449, 0.2449, 1.0000) | ✓ |
| **emb(Joe)** | **(0.8586, 0.2750, 0.5971, 0.5294)** | ✓ |

The intermediates matter: they localise any failure to the smoothing step vs the decay step. On Aura Graph Analytics FastPath is a built-in (self-managed support announced for 2027); we reimplement it so the score can be **read**.

---

# Cosine to shortlist, Euclidean to rank

**Cosine** similarity (kNN, top 10) compares *shape* — which atoms, in which time bands — ignoring size: a small book breaking the same rules in the same order as the reference is a cosine neighbour. **Euclidean** distance then ranks the shortlist by *magnitude*: with exponential decay, magnitude is **gap velocity** — how much, how recently. Same shape + same velocity = top of the list.

---

# Time equivariance, in one line

The embedding depends only on **elapsed** times $t_h - t_e$: shift every event and the output time by +100 days and the vector is identical (asserted in both test suites) — which is what makes a 2021 trajectory comparable with a 2022 one.

---

# Identity basis vs random basis

We run the **identity basis**: one dimension per (atom × time band), so every coordinate has a name and the panel can say *"0.8× R3 gaps ≈91 d ago"* instead of showing a vector. The published algorithm's **sparse random ±1 basis** compresses the same information into a fixed dimension $d$ — what you want at production scale (thousands of atoms), at the price of readability. The implementation is pluggable; the maths is identical.

---

# Limits on this dataset

- **Synthetic circularity**: gap-heavy trajectories exist because the generator planted gap-heavy books; enrichment here demonstrates the mechanism, not discovery power.
- **Sample size**: ~95 positions and a 4-book holdout — the secondary recall line says "too few to conclude" because it is.
- **Placeholder parameters**: $\Theta$, $g$, $\lambda$, $\gamma$ are demo choices, as editable as every other threshold in the Policy step.

Full notes: `docs/rules-provenance.md` and `DECISIONS.md` #22.
