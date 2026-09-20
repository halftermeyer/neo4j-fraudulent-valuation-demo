# The projection

We build a small graph of **people only**: an edge $a \to t$ means *"person $a$ approved a price override entered by person $t$"*, weighted by **how many times** that happened. The edge list comes from one Cypher pattern — `(t)<-[:PERFORMED_BY]-(:PriceOverride)-[:APPROVED_BY]->(:Approval)-[:APPROVED_BY]->(a)` — and is projected **undirected**: for circles, who signed and who booked are two ends of the same habit.

---

# What a community is

A **community** (here found with **Louvain**) is a set of nodes with *more edge weight inside the set than a random graph with the same degrees would have*. No labels, no rules, no thresholds go in — only the who-approves-whom structure. People who repeatedly approve each other's overrides end up in the same community because that repetition IS excess internal weight.

---

# The modularity formula

Louvain greedily maximises **modularity**:

$$Q = \frac{1}{2m}\sum_{ij}\left[A_{ij} - \frac{k_i k_j}{2m}\right]\delta(c_i, c_j)$$

- $A_{ij}$ — the observed approval weight between persons $i$ and $j$;
- $\frac{k_i k_j}{2m}$ — the weight a **random** rewiring with the same activity levels would put there (the null model);
- $\delta(c_i, c_j)$ — counts a pair only when both sit **in the same community**;
- $\frac{1}{2m}$ — normalises by total weight, so $Q$ compares across graphs.

A high-$Q$ partition means the circles you see are **denser than chance**, given how active each person is.

---

# Why "no independent role" is a hypothesis, not a finding

The panel highlights circles whose members carry **no independent control function** (IPV, Product Control, Risk, MAP). That is a *shape*, not an offence: a small desk can legitimately look like this. The point is that **no rule described it** — R1–R9 test events, not the topology of who approves whom. A closed circle is exactly the kind of structure a rule-writer would want to know about — which is why the panel's only output is a **candidate** obligation (R-C1), badged as unvalidated, evaluated by nothing until a human promotes it.

---

# The resolution parameter

Louvain has a **resolution** knob (our candidate rule records it as `communityResolution`). It scales the null-model term: resolution $> 1$ demands *more* internal density, splitting the graph into **smaller, tighter** circles; resolution $< 1$ merges them into fewer, larger ones. Sweep it and the stable circles — the ones that survive across resolutions — are the ones worth writing a rule about.

---

# Limits on this dataset

- **Synthetic circularity**: the generator plants the closed circle (the case's desk head approving his own desk), so finding it here demonstrates the *mechanism*, not discovery power.
- **Sample size**: ~60 people. At this size the circles are visible by eye; the method matters at thousands of people, not here.
- **Weights are counts**: no notional, no severity — a production version would weight by exposure.

Full provenance and rule semantics: `docs/rules-provenance.md`.
