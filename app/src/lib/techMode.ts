// "Technical" mode — gates the Discovery tab. Off by default, session-only by
// design (never persisted): the executive demo must not accidentally open on it.

let on = false;
const listeners = new Set<() => void>();

export function isTechModeOn(): boolean {
  return on;
}

export function toggleTechMode(next?: boolean): void {
  on = next ?? !on;
  listeners.forEach((l) => l());
}

export function onTechModeChange(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
