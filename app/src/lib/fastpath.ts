// FastPath — TypeScript mirror of scripts/fastpath.py (keep the two in sync).
// The oracle is the PUBLISHED worked example in inputs/fastpath_worked_example.md;
// fastpath.test.ts (vitest) proves THIS file against it — golden vector, both
// intermediate event embeddings, +100-day shift equivariance, to 4 decimals —
// exactly like tests/test_fastpath.py proves the Python. One embedding code path:
// the identity basis used by the Discovery panel goes through the same `embed`
// the golden test exercises.
//
// Semantics pinned by the worked example:
//  * event kept iff 0 < elapsed <= theta (strictly before the output time);
//  * grid: g points evenly over [0, theta];
//  * smoothing: window = nearest grid point ± s STEPS, truncated at the grid
//    boundary; weights ∝ exp(−λ·|τ − elapsed|) normalised over the truncated
//    window, |τ − elapsed| against the RAW elapsed time;
//  * base embedding = Σ over events of exp(−γ·elapsed) · event embedding.

export interface FastPathParams {
  gridPoints: number; // g
  theta: number; // max elapsed (lookback horizon), in the same unit as elapsed
  smoothingWindow: number; // s, in grid steps
  smoothingRate: number; // λ
  decayRate: number; // γ
}

export interface FpEvent {
  elapsed: number; // t_o − t_e, already computed by the caller
  atoms: string[];
}

/** (atom, gridIndex) → basis vector; undefined atoms contribute nothing. */
export type BasisLookup = (atom: string, gridIndex: number) => number[] | undefined;

export function gridTimes(p: FastPathParams): number[] {
  if (p.gridPoints === 1) return [0];
  const step = p.theta / (p.gridPoints - 1);
  return Array.from({ length: p.gridPoints }, (_, i) => i * step);
}

export function dimensionName(atoms: string[], p: FastPathParams, k: number): { atom: string; gridIndex: number } {
  const sorted = [...atoms].sort();
  return { atom: sorted[Math.floor(k / p.gridPoints)], gridIndex: k % p.gridPoints };
}

export function smoothingWeights(elapsed: number, p: FastPathParams): [number, number][] {
  const grid = gridTimes(p);
  let nearest = 0;
  for (let i = 1; i < grid.length; i++) {
    if (Math.abs(grid[i] - elapsed) < Math.abs(grid[nearest] - elapsed)) nearest = i;
  }
  const lo = Math.max(0, nearest - p.smoothingWindow);
  const hi = Math.min(grid.length - 1, nearest + p.smoothingWindow);
  const raw: [number, number][] = [];
  for (let i = lo; i <= hi; i++) raw.push([i, Math.exp(-p.smoothingRate * Math.abs(grid[i] - elapsed))]);
  const z = raw.reduce((s, [, w]) => s + w, 0);
  return raw.map(([i, w]) => [i, w / z]);
}

/** Smoothing-weighted sum of the event's atom basis vectors (no decay). */
export function eventEmbedding(ev: FpEvent, basis: BasisLookup, dimension: number, p: FastPathParams): number[] {
  const emb = Array.from({ length: dimension }, () => 0);
  for (const [gi, w] of smoothingWeights(ev.elapsed, p)) {
    for (const atom of ev.atoms) {
      const vec = basis(atom, gi);
      if (vec) for (let k = 0; k < dimension; k++) emb[k] += w * vec[k];
    }
  }
  return emb;
}

/** Base-node embedding over an arbitrary basis — THE code path (golden-tested). */
export function embed(events: FpEvent[], basis: BasisLookup, dimension: number, p: FastPathParams): number[] {
  const emb = Array.from({ length: dimension }, () => 0);
  for (const ev of events) {
    if (!(ev.elapsed > 0 && ev.elapsed <= p.theta)) continue;
    const decay = Math.exp(-p.decayRate * ev.elapsed);
    const e = eventEmbedding(ev, basis, dimension, p);
    for (let k = 0; k < dimension; k++) emb[k] += decay * e[k];
  }
  return emb;
}

/** Identity basis over SORTED atoms: dimension k = atomIndex * g + gridIndex —
 *  every dimension nameable (see dimensionName). Used by the Discovery panel. */
export function identityBasis(atoms: string[], p: FastPathParams): { basis: BasisLookup; dimension: number } {
  const sorted = [...atoms].sort();
  const index = new Map(sorted.map((a, i) => [a, i]));
  const d = sorted.length * p.gridPoints;
  const cache = new Map<string, number[]>();
  const basis: BasisLookup = (atom, gi) => {
    const ai = index.get(atom);
    if (ai === undefined) return undefined;
    const key = `${ai}|${gi}`;
    let v = cache.get(key);
    if (!v) {
      v = Array.from({ length: d }, () => 0);
      v[ai * p.gridPoints + gi] = 1;
      cache.set(key, v);
    }
    return v;
  };
  return { basis, dimension: d };
}

/** Trajectory of one base node over the identity basis of `atoms` (sorted). */
export function baseEmbedding(events: FpEvent[], atoms: string[], p: FastPathParams): number[] {
  const { basis, dimension } = identityBasis(atoms, p);
  return embed(events, basis, dimension, p);
}

export function euclidean(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}
