"""FastPath reimplementation vs the PUBLISHED worked example.

Oracle: inputs/fastpath_worked_example.md (Neo4j PS deck "FastPath — Use GDS to
analyze journeys", re-derived independently). This test is the proof that
scripts/fastpath.py implements THE algorithm, not something shaped like it:
golden final vector, the two intermediate event embeddings (to localise a
failure to smoothing vs decay), and +100-day shift equivariance.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from fastpath import (  # noqa: E402
    Basis,
    Event,
    FastPathParams,
    base_embedding,
    event_embedding,
    given_basis,
    grid_times,
    identity_basis,
    identity_dimension_name,
    smoothing_weights,
)

# ── the published example, verbatim ──────────────────────────────────────────

P = FastPathParams(dimension=4, grid_points=4, theta=9,
                   smoothing_window=1, smoothing_rate=0.5, decay_rate=0.1)

BASIS = given_basis({
    ("aspirin", 0): [1, -1, 1, 1],
    ("aspirin", 1): [1, 1, -1, 1],
    ("aspirin", 2): [-1, 1, 1, -1],
    ("aspirin", 3): [1, 1, 1, -1],
    ("checkup", 0): [1, 1, 1, 1],  # never used: e3 is filtered (elapsed 10 > theta)
    ("checkup", 1): [1, 1, 1, 1],
    ("checkup", 2): [1, 1, 1, 1],
    ("checkup", 3): [1, 1, 1, 1],
})

JOE = [
    Event(t=10, atoms=("aspirin",)),  # e0 — at t_o, excluded
    Event(t=3, atoms=("aspirin",)),   # e1 — elapsed 7
    Event(t=9, atoms=("aspirin",)),   # e2 — elapsed 1
    Event(t=0, atoms=("checkup",)),   # e3 — elapsed 10 > theta, excluded
]

GOLDEN = (0.8586, 0.2750, 0.5971, 0.5294)
EMB_E1 = (-0.0931, 1.0000, 0.7561, -0.7561)
EMB_E2 = (1.0000, -0.2449, 0.2449, 1.0000)


def test_grid_is_0_3_6_9():
    assert grid_times(P) == [0.0, 3.0, 6.0, 9.0]


def test_intermediate_event_embeddings():
    """Localises a failure: smoothing (this test) vs decay (the golden test)."""
    e1 = event_embedding(JOE[1], 10, BASIS, P)
    e2 = event_embedding(JOE[2], 10, BASIS, P)
    assert tuple(round(x, 4) for x in e1) == pytest.approx(EMB_E1, abs=1e-4)
    assert tuple(round(x, 4) for x in e2) == pytest.approx(EMB_E2, abs=1e-4)


def test_e2_window_truncated_at_boundary():
    """e2 (elapsed 1, nearest 0): window {0, 3}, normalised over the TRUNCATED set."""
    w = dict(smoothing_weights(1.0, P))
    assert set(w) == {0, 1}
    assert w[0] == pytest.approx(0.6225, abs=1e-4)
    assert w[1] == pytest.approx(0.3775, abs=1e-4)


def test_published_golden_vector():
    emb = base_embedding(JOE, 10, BASIS, P)
    assert tuple(round(x, 4) for x in emb) == pytest.approx(GOLDEN, abs=1e-4)


def test_time_shift_equivariance():
    """+100 shift of every timestamp and t_o: same elapsed times, same vector —
    what makes trajectories comparable across periods."""
    shifted = [Event(t=e.t + 100, atoms=e.atoms) for e in JOE]
    emb = base_embedding(shifted, 110, BASIS, P)
    assert tuple(round(x, 4) for x in emb) == pytest.approx(GOLDEN, abs=1e-4)


def test_exclusions_are_exact():
    """e0 sits exactly at t_o and e3 exactly at theta+1 — both excluded; an event
    at exactly elapsed == theta is INCLUDED (0 < elapsed <= theta)."""
    only_edge = [Event(t=1, atoms=("aspirin",))]  # elapsed 9 == theta
    emb = base_embedding(only_edge, 10, BASIS, P)
    assert any(abs(x) > 1e-9 for x in emb)
    at_output = [Event(t=10, atoms=("aspirin",))]
    assert base_embedding(at_output, 10, BASIS, P) == [0.0, 0.0, 0.0, 0.0]


def test_identity_basis_dimensions_are_nameable():
    """Identity basis: one dimension per (atom × grid point), invertible by name —
    what lets the UI say '2× R3 gaps 0–90 d ago' instead of showing a vector."""
    atoms = ["R3", "PriceOverride"]
    b = identity_basis(atoms, P)
    assert b.dimension == len(atoms) * P.grid_points
    ev = Event(t=9, atoms=("R3",))  # elapsed 1 → grid 0 (0.6225) + grid 3 (0.3775)
    emb = event_embedding(ev, 10, b, P)
    nonzero = [k for k, x in enumerate(emb) if abs(x) > 1e-9]
    names = [identity_dimension_name(k, atoms, P) for k in nonzero]
    assert names == [("R3", 0), ("R3", 1)]


def test_smoothing_weights_sum_to_one():
    for elapsed in (0.0, 1.0, 4.5, 7.0, 9.0):
        assert sum(w for _, w in smoothing_weights(elapsed, P)) == pytest.approx(1.0)
