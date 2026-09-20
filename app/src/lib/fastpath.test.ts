// TS mirror vs the PUBLISHED FastPath worked example — the same contract as
// tests/test_fastpath.py (inputs/fastpath_worked_example.md is the oracle):
// golden vector, both intermediate event embeddings, +100-day shift
// equivariance, to 4 decimals. No untested mirror.

import { describe, expect, it } from "vitest";
import {
  baseEmbedding,
  dimensionName,
  embed,
  eventEmbedding,
  gridTimes,
  smoothingWeights,
  type BasisLookup,
  type FastPathParams,
  type FpEvent,
} from "./fastpath";

const P: FastPathParams = { gridPoints: 4, theta: 9, smoothingWindow: 1, smoothingRate: 0.5, decayRate: 0.1 };

const VECTORS: Record<string, number[]> = {
  "aspirin|0": [1, -1, 1, 1],
  "aspirin|1": [1, 1, -1, 1],
  "aspirin|2": [-1, 1, 1, -1],
  "aspirin|3": [1, 1, 1, -1],
  "checkup|0": [1, 1, 1, 1], // never used: e3 is filtered (elapsed 10 > theta)
  "checkup|1": [1, 1, 1, 1],
  "checkup|2": [1, 1, 1, 1],
  "checkup|3": [1, 1, 1, 1],
};
const BASIS: BasisLookup = (atom, gi) => VECTORS[`${atom}|${gi}`];

// Joe, output time 10 → elapsed per event; e0 (at t_o) and e3 (elapsed 10 > Θ) excluded
const joe = (shift = 0): FpEvent[] => [
  { elapsed: 10 + shift - (10 + shift), atoms: ["aspirin"] }, // e0 — elapsed 0
  { elapsed: 10 + shift - (3 + shift), atoms: ["aspirin"] }, // e1 — elapsed 7
  { elapsed: 10 + shift - (9 + shift), atoms: ["aspirin"] }, // e2 — elapsed 1
  { elapsed: 10 + shift - (0 + shift), atoms: ["checkup"] }, // e3 — elapsed 10
];

const GOLDEN = [0.8586, 0.275, 0.5971, 0.5294];
const EMB_E1 = [-0.0931, 1.0, 0.7561, -0.7561];
const EMB_E2 = [1.0, -0.2449, 0.2449, 1.0];

const round4 = (v: number[]) => v.map((x) => Math.round(x * 1e4) / 1e4);
const close = (a: number[], b: number[]) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 4));

describe("FastPath TS mirror vs the published worked example", () => {
  it("grid is {0, 3, 6, 9}", () => {
    expect(gridTimes(P)).toEqual([0, 3, 6, 9]);
  });

  it("intermediate event embeddings (localises smoothing vs decay failures)", () => {
    close(round4(eventEmbedding({ elapsed: 7, atoms: ["aspirin"] }, BASIS, 4, P)), EMB_E1);
    close(round4(eventEmbedding({ elapsed: 1, atoms: ["aspirin"] }, BASIS, 4, P)), EMB_E2);
  });

  it("e2's window truncates at the grid boundary and renormalises", () => {
    const w = new Map(smoothingWeights(1, P));
    expect([...w.keys()].sort()).toEqual([0, 1]);
    expect(w.get(0)).toBeCloseTo(0.6225, 4);
    expect(w.get(1)).toBeCloseTo(0.3775, 4);
  });

  it("published golden vector to 4 decimals", () => {
    close(round4(embed(joe(), BASIS, 4, P)), GOLDEN);
  });

  it("+100-day shift equivariance", () => {
    close(round4(embed(joe(100), BASIS, 4, P)), GOLDEN);
  });

  it("exclusions: at output time and beyond theta out; exactly theta in", () => {
    expect(embed([{ elapsed: 0, atoms: ["aspirin"] }], BASIS, 4, P)).toEqual([0, 0, 0, 0]);
    expect(embed([{ elapsed: 10, atoms: ["checkup"] }], BASIS, 4, P)).toEqual([0, 0, 0, 0]);
    expect(embed([{ elapsed: 9, atoms: ["aspirin"] }], BASIS, 4, P).some((x) => x !== 0)).toBe(true);
  });

  it("identity basis goes through the same embed path and stays nameable", () => {
    const atoms = ["R3", "PriceOverride"];
    const v = baseEmbedding([{ elapsed: 1, atoms: ["R3"] }], atoms, P);
    const nonzero = v.map((x, k) => [x, k] as const).filter(([x]) => Math.abs(x) > 1e-9).map(([, k]) => k);
    expect(nonzero.map((k) => dimensionName(atoms, P, k))).toEqual([
      { atom: "R3", gridIndex: 0 },
      { atom: "R3", gridIndex: 1 },
    ]);
  });
});
