// Cross-tab deep link: "select this node in Explore".
// Used by the Assistant's event-id links and answer graphs (and reusable from
// anywhere). App switches to the Explore tab; ExploreTab consumes the pending
// id, selects the node's position and opens the node inspector on it.

let pendingNodeId: string | null = null;
const listeners = new Set<() => void>();

export function openInExplore(nodeId: string): void {
  pendingNodeId = nodeId;
  listeners.forEach((l) => l());
}

export function peekPendingNode(): string | null {
  return pendingNodeId;
}

export function consumePendingNode(): string | null {
  const id = pendingNodeId;
  pendingNodeId = null;
  return id;
}

export function onExploreLink(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
