// Session gate: S1 stays disabled until governance gaps have been computed once
// in this session (the visible "Compute governance gaps" step of the Policy
// panel — the flow is Explore → Policy → S1 → S2 → S3 → S4). Session-only by
// design: reloading the app re-arms the gate even if the DB already holds gaps.

let computed = false;
const listeners = new Set<() => void>();

export function gapsComputedThisSession(): boolean {
  return computed;
}

export function markGapsComputed(): void {
  computed = true;
  listeners.forEach((l) => l());
}

export function onGapSessionChange(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
