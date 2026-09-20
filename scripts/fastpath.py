#!/usr/bin/env python3
"""FastPath — faithful reimplementation of the published algorithm.

Source of truth: the Neo4j GDS FastPath algorithm as published (docs
"How the algorithm works" + the PS worked example re-derived in
inputs/fastpath_worked_example.md, which tests/test_fastpath.py reproduces
to 4 decimals). On Aura Graph Analytics this is a built-in; self-managed
support is announced for 2027 — the demo reimplements it so the score can
be READ (identity basis: every dimension nameable in words).

Semantics (all pinned by the worked example):
  * an event enters the embedding iff 0 < elapsed <= theta,
    elapsed = t_o - t_e  (strictly before the output time, not older than theta);
  * time grid: g points evenly over [0, theta], spacing theta/(g-1);
  * basis: one vector of dimension d per (atom x grid point) — pluggable:
      - identity: d = n_atoms * g, one nameable dimension per (atom, grid point);
      - given: caller-supplied vectors (the worked example's +-1 matrix);
      - sparse random +-1/0 from a seed (deterministic);
  * event pre-embedding at grid point tau = sum of its atoms' basis vectors at tau;
  * time smoothing: window = nearest grid point +- s grid STEPS, truncated at the
    grid boundary; weights prop. to exp(-lambda * |tau - elapsed|), normalised
    over the (truncated) window — |tau - elapsed| uses the RAW elapsed time;
  * base embedding = sum over events of exp(-gamma * elapsed) * event embedding.

The TypeScript mirror (app/src/lib/fastpath.ts) must stay in sync — same
formulas, same atom ordering, same grid; the demo compares like with like.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass, field


@dataclass(frozen=True)
class FastPathParams:
    dimension: int  # d — ignored by the identity basis (derived)
    grid_points: int  # g
    theta: float  # max elapsed time (lookback horizon)
    smoothing_window: int = 1  # s, in grid steps
    smoothing_rate: float = 0.5  # lambda
    decay_rate: float = 0.1  # gamma


@dataclass
class Event:
    t: float  # timestamp (same unit as theta)
    atoms: tuple[str, ...]  # categorical atoms (event label, rule id, role, desk…)


def grid_times(p: FastPathParams) -> list[float]:
    if p.grid_points == 1:
        return [0.0]
    step = p.theta / (p.grid_points - 1)
    return [i * step for i in range(p.grid_points)]


@dataclass
class Basis:
    """vectors[(atom, grid_index)] -> list[float] of length `dimension`."""
    dimension: int
    vectors: dict[tuple[str, int], list[float]] = field(default_factory=dict)

    def get(self, atom: str, gi: int) -> list[float]:
        try:
            return self.vectors[(atom, gi)]
        except KeyError:
            raise KeyError(f"basis has no vector for atom {atom!r} at grid index {gi}")


def given_basis(vectors: dict[tuple[str, int], list[float]]) -> Basis:
    dims = {len(v) for v in vectors.values()}
    if len(dims) != 1:
        raise ValueError("all basis vectors must share one dimension")
    return Basis(dimension=dims.pop(), vectors=dict(vectors))


def identity_basis(atoms: list[str], p: FastPathParams) -> Basis:
    """One nameable dimension per (atom, grid point): dimension = n_atoms * g.
    Dimension index k = atom_index * g + grid_index — dimension_name() inverts it."""
    d = len(atoms) * p.grid_points
    vectors: dict[tuple[str, int], list[float]] = {}
    for ai, atom in enumerate(sorted(atoms)):
        for gi in range(p.grid_points):
            v = [0.0] * d
            v[ai * p.grid_points + gi] = 1.0
            vectors[(atom, gi)] = v
    return Basis(dimension=d, vectors=vectors)


def identity_dimension_name(k: int, atoms: list[str], p: FastPathParams) -> tuple[str, int]:
    """dimension index -> (atom, grid_index) for the identity basis."""
    return sorted(atoms)[k // p.grid_points], k % p.grid_points


def sparse_random_basis(atoms: list[str], p: FastPathParams, seed: int,
                        sparsity: float = 1 / 3) -> Basis:
    """Deterministic sparse +-1/0 basis (Achlioptas-style): P(+1)=P(-1)=sparsity/2 …
    seeded per (atom, grid index) so the basis is stable across runs and processes."""
    vectors: dict[tuple[str, int], list[float]] = {}
    for atom in sorted(atoms):
        for gi in range(p.grid_points):
            rng = random.Random(f"{seed}|{atom}|{gi}")
            v = []
            for _ in range(p.dimension):
                u = rng.random()
                v.append(1.0 if u < sparsity / 2 else -1.0 if u < sparsity else 0.0)
            vectors[(atom, gi)] = v
    return Basis(dimension=p.dimension, vectors=vectors)


def smoothing_weights(elapsed: float, p: FastPathParams) -> list[tuple[int, float]]:
    """[(grid_index, weight)] over the +-s window around the NEAREST grid point,
    truncated at the boundaries, weights normalised to sum to 1."""
    grid = grid_times(p)
    nearest = min(range(len(grid)), key=lambda i: (abs(grid[i] - elapsed), i))
    lo = max(0, nearest - p.smoothing_window)
    hi = min(len(grid) - 1, nearest + p.smoothing_window)
    raw = [(i, math.exp(-p.smoothing_rate * abs(grid[i] - elapsed))) for i in range(lo, hi + 1)]
    z = sum(w for _, w in raw)
    return [(i, w / z) for i, w in raw]


def event_embedding(ev: Event, output_time: float, basis: Basis,
                    p: FastPathParams) -> list[float]:
    elapsed = output_time - ev.t
    emb = [0.0] * basis.dimension
    for gi, w in smoothing_weights(elapsed, p):
        for atom in ev.atoms:
            vec = basis.get(atom, gi)
            for k in range(basis.dimension):
                emb[k] += w * vec[k]
    return emb


def base_embedding(events: list[Event], output_time: float, basis: Basis,
                   p: FastPathParams) -> list[float]:
    emb = [0.0] * basis.dimension
    for ev in events:
        elapsed = output_time - ev.t
        if not (0.0 < elapsed <= p.theta):  # strictly before t_o, within theta
            continue
        decay = math.exp(-p.decay_rate * elapsed)
        e_emb = event_embedding(ev, output_time, basis, p)
        for k in range(basis.dimension):
            emb[k] += decay * e_emb[k]
    return emb
