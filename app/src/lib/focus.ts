// Focus bus — "the companion mentioned (PO-TP-03): show it to me".
// Graph canvases register a handler (select + fit in NVL); tables and timelines
// opt in by putting data-node-id on their rows. focusNodeMention() scans an
// explanation for node ids and focuses the first one visible in the current
// view, graph first, DOM second — BEFORE the text is shown.

// same id grammar as ResultGrid's deep links (generator id prefixes)
const NODE_ID_SCAN =
  /\b(?:POS|PO|MC|MCH|IPV|MAP|PNL|CTL|APR|ESC|EV|RC|CA|INC|GAP|OVR)-[A-Za-z0-9:._-]*[A-Za-z0-9]/g;

export function extractNodeIds(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.match(NODE_ID_SCAN) ?? []) seen.add(m);
  return [...seen];
}

export interface GraphFocusHandler {
  has: (id: string) => boolean;
  focus: (id: string) => void;
}

const graphs = new Set<GraphFocusHandler>();

export function registerGraphFocus(h: GraphFocusHandler): () => void {
  graphs.add(h);
  return () => graphs.delete(h);
}

function flashDomRow(el: Element): void {
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("node-focus-flash");
  window.setTimeout(() => el.classList.remove("node-focus-flash"), 2600);
}

/** Select + fit the node in an on-screen NVL canvas. False if none holds it. */
export function focusNodeInGraph(id: string): boolean {
  for (const g of graphs) {
    if (g.has(id)) {
      g.focus(id);
      return true;
    }
  }
  return false;
}

/** Scroll + flash the table/timeline row carrying the id. False if absent. */
export function flashNodeRow(id: string): boolean {
  const el = document.querySelector(`[data-node-id="${CSS.escape(id)}"]`);
  if (el) {
    flashDomRow(el);
    return true;
  }
  return false;
}

/** Focus one node id if it is on screen. Returns the id focused, or null. */
export function focusNodeId(id: string): string | null {
  if (focusNodeInGraph(id)) return id;
  return flashNodeRow(id) ? id : null;
}

/** Scan an explanation and focus the first mentioned node visible right now. */
export function focusNodeMention(text: string): string | null {
  for (const id of extractNodeIds(text)) {
    const hit = focusNodeId(id);
    if (hit) return hit;
  }
  return null;
}
