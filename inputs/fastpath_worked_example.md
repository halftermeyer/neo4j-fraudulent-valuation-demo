# FastPath — published worked example (test oracle)

Source: Neo4j Professional Services deck "FastPath — Use GDS to analyze journeys" (N. Smith,
J. A. Alvarado-Guzmán), section "A Worked Example: hand-computing one patient's embedding".
Numbers below are the published ones; they were re-derived independently and match to 4 decimals.
Categorical source only (event type). No context nodes, no dense features.

## Setup

Base node: patient "Joe". Output time t_o = 10.

| event | type    | t_e |
|-------|---------|-----|
| e0    | aspirin | 10  |
| e1    | aspirin | 3   |
| e2    | aspirin | 9   |
| e3    | checkup | 0   |

| parameter        | symbol | value |
|------------------|--------|-------|
| dimension        | d      | 4     |
| grid points      | g      | 4     |
| max elapsed      | Θ      | 9     |
| smoothing window | s      | 1     |
| smoothing rate   | λ      | 0.5   |
| decay factor     | γ      | 0.1   |

## Step 1 — filter

Keep an event iff 0 < elapsed ≤ Θ, elapsed = t_o − t_e (strictly before output time, not older than Θ).

| event | elapsed | kept | reason                    |
|-------|---------|------|---------------------------|
| e0    | 0       | no   | occurs at t_o             |
| e1    | 7       | yes  |                           |
| e2    | 1       | yes  |                           |
| e3    | 10      | no   | 10 > Θ                    |

## Step 2 — grid

g = 4 points over [0, Θ]: spacing Δ = 9/(g−1) = 3 → grid = {0, 3, 6, 9}.
Nearest grid point: e2 (elapsed 1) → 0 ; e1 (elapsed 7) → 6.

## Step 3 — random ±1 basis for atom "aspirin", one vector per grid time

| grid τ | r_τ (d = 4)      |
|--------|------------------|
| 0      | ( 1, −1,  1,  1) |
| 3      | ( 1,  1, −1,  1) |
| 6      | (−1,  1,  1, −1) |
| 9      | ( 1,  1,  1, −1) |

Pre-embedding at grid τ for an aspirin event = r_τ (single atom).

## Step 4 — time smoothing (window ±s around the nearest grid point, weights ∝ exp(−λ·|τ − elapsed|), normalised)

e1 (elapsed 7, nearest 6, window {3, 6, 9}):

| τ | |τ−7| | exp(−0.5·|τ−7|) | normalised weight |
|---|-------|------------------|-------------------|
| 3 | 4     | 0.1353           | 0.1220            |
| 6 | 1     | 0.6065           | 0.5465            |
| 9 | 2     | 0.3679           | 0.3315            |

emb(e1) = 0.1220·r_3 + 0.5465·r_6 + 0.3315·r_9 = (−0.0931, 1.0000, 0.7561, −0.7561)

e2 (elapsed 1, nearest 0, window {0, 3} — truncated at the grid boundary):

| τ | |τ−1| | exp(−0.5·|τ−1|) | normalised weight |
|---|-------|------------------|-------------------|
| 0 | 1     | 0.6065           | 0.6225            |
| 3 | 2     | 0.3679           | 0.3775            |

emb(e2) = 0.6225·r_0 + 0.3775·r_3 = (1.0000, −0.2449, 0.2449, 1.0000)

## Step 5 — recency decay and aggregation, weight = exp(−γ·elapsed)

| event | elapsed | weight            |
|-------|---------|-------------------|
| e1    | 7       | exp(−0.7) = 0.4966 |
| e2    | 1       | exp(−0.1) = 0.9048 |

emb(Joe) = 0.4966·emb(e1) + 0.9048·emb(e2) = **(0.8586, 0.2750, 0.5971, 0.5294)**

## Time equivariance check (second assertion)

Shift every t_e and t_o by +100 (events at 110, 103, 109, 100; t_o = 110): all elapsed times are
unchanged, the same two events survive, and the embedding is identical to 4 decimals.

## Test contract

`tests/test_fastpath.py` must:
1. build this example with the pluggable basis set to the four vectors above,
2. assert emb(Joe) == (0.8586, 0.2750, 0.5971, 0.5294) to 4 decimals,
3. assert the +100 shifted history gives the same vector,
4. assert intermediate values emb(e1) and emb(e2) as above (to localise a failure to smoothing vs decay).