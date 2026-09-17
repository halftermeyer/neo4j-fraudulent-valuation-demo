// The Assistant's typed tools — NOT free-form text-to-Cypher.
// Each tool maps 1:1 onto a query function in queries.ts (the same functions the
// UI runs), so every Assistant answer is reproducible from the audit drawer.
// The same seven tools are exposed to MCP clients by mcp_server.py.

import { Type, type FunctionDeclaration } from "@google/genai";
import {
  divergence,
  expectedControls,
  listPositions,
  nearMisses,
  policyParams,
  timeline,
  whoApproved,
} from "./queries";

export const TOOL_DECLARATIONS: FunctionDeclaration[] = [
  {
    name: "list_positions",
    description:
      "List all positions with desk, sector and current governance-gap count (worst first).",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "timeline",
    description:
      "Chronological reconstruction of everything that happened to a position, in event-time order (the :NEXT event chain): methodology changes, price overrides, IPV/MAP reviews, P&L signals, approvals, escalations, incident and corrective actions. Case events carry sourceAt (authentic date) and sourceRef (public-record citation).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        positionId: { type: Type.STRING, description: "e.g. POS-TP, POS-FP, POS-014" },
      },
      required: ["positionId"],
    },
  },
  {
    name: "expected_controls",
    description:
      "Expected-vs-observed evaluation of every ControlObligation (R1..R9) for a position: which control should have fired, when it was due (dueBy), what was observed, and the status MET | LATE | MISSED | PENDING. LATE and MISSED are governance gaps.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        positionId: { type: Type.STRING },
        asOf: {
          type: Type.STRING,
          description: "Optional ISO datetime; defaults to the dataset clock end 2023-01-01.",
        },
      },
      required: ["positionId"],
    },
  },
  {
    name: "who_approved",
    description:
      "For a MethodologyChange or PriceOverride event id: who approved it, their role and desk, whether they sit on the same desk as the position (segregation-of-duties, R8) and whether the approval is evidenced (R9).",
    parameters: {
      type: Type.OBJECT,
      properties: { eventId: { type: Type.STRING, description: "e.g. MC-VAR-2012, PO-TP-03" } },
      required: ["eventId"],
    },
  },
  {
    name: "divergence",
    description:
      "Observed price vs proxy-model price history for a position's instrument, with divergence in bps (the input to IPV reviews and P&L signals).",
    parameters: {
      type: Type.OBJECT,
      properties: { positionId: { type: Type.STRING } },
      required: ["positionId"],
    },
  },
  {
    name: "read_across",
    description:
      "Positions (excluding confirmed incidents) that currently accumulate governance gaps on at least minRules distinct obligations — the partial matches of the confirmed pattern (early detection).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        minRules: { type: Type.NUMBER, description: "Minimum distinct broken rules, default 2." },
      },
    },
  },
  {
    name: "policy_params",
    description:
      "Current parameters of every ControlObligation (thresholds, SLA days, window sizes, n) as set in the Policy panel, with each rule's gap definition.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
];

// ── graph-shaped payloads ────────────────────────────────────────────────────
// Tools return {rows, graph}: rows go to the model and the DataGrid; graph is
// the returned subgraph the answer renders with the scenarios' NVL component.
// mcp_server.py mirrors the same shape (see its _graphify).

export interface GraphNode {
  id: string;
  label: string;
  caption?: string;
  order?: number; // event-time rank — timelines render left-to-right by it
}

export interface GraphRel {
  id: string;
  from: string;
  to: string;
  type: string;
}

export interface GraphPayload {
  nodes: GraphNode[];
  rels: GraphRel[];
  ordered?: boolean; // true = pin nodes on an event-time axis
}

export interface ToolResult {
  rows: unknown[];
  graph?: GraphPayload;
}

function timelineGraph(positionId: string, rows: Awaited<ReturnType<typeof timeline>>): GraphPayload {
  // MarketPrice/Curve points belong to the chart, not the event chain render
  const events = rows.filter((e) => e.label !== "MarketPrice" && e.label !== "Curve").slice(0, 60);
  const nodes: GraphNode[] = [
    { id: positionId, label: "Position", caption: positionId, order: -1 },
    ...events.map((e, i) => ({
      id: e.id,
      label: e.label,
      caption: `${e.label} ${String(e.at).slice(0, 10)}`,
      order: i,
    })),
  ];
  const rels: GraphRel[] = events.slice(1).map((e, i) => ({
    id: `next-${i}`,
    from: events[i].id,
    to: e.id,
    type: "NEXT",
  }));
  if (events[0]) {
    rels.unshift({ id: "pos-first", from: positionId, to: events[0].id, type: "FIRST_EVENT" });
  }
  return { nodes, rels, ordered: true };
}

function expectedControlsGraph(positionId: string, rows: Awaited<ReturnType<typeof expectedControls>>): GraphPayload {
  const nodes = new Map<string, GraphNode>([
    [positionId, { id: positionId, label: "Position", caption: positionId }],
  ]);
  const rels: GraphRel[] = [];
  rows.slice(0, 60).forEach((r, i) => {
    if (!nodes.has(r.ruleId)) {
      nodes.set(r.ruleId, { id: r.ruleId, label: "ControlObligation", caption: `${r.ruleId} ${r.ruleName}` });
    }
    if (r.triggerEventId && r.triggerEventId !== positionId) {
      if (!nodes.has(r.triggerEventId)) {
        nodes.set(r.triggerEventId, {
          id: r.triggerEventId,
          label: r.triggerLabel ?? "Event",
          caption: `${r.triggerEventId}`,
        });
        rels.push({ id: `t-${i}`, from: positionId, to: r.triggerEventId, type: "HAS_EVENT" });
      }
      rels.push({ id: `s-${i}`, from: r.triggerEventId, to: r.ruleId, type: r.status });
    }
  });
  return { nodes: [...nodes.values()], rels };
}

function whoApprovedGraph(eventId: string, rows: Awaited<ReturnType<typeof whoApproved>>): GraphPayload {
  const nodes = new Map<string, GraphNode>([[eventId, { id: eventId, label: "Event", caption: eventId }]]);
  const rels: GraphRel[] = [];
  (rows as Record<string, unknown>[]).forEach((r, i) => {
    const approvalId = String(r.approvalId ?? `approval-${i}`);
    nodes.set(approvalId, { id: approvalId, label: "Approval", caption: approvalId });
    rels.push({ id: `a-${i}`, from: eventId, to: approvalId, type: "APPROVED_BY" });
    if (r.approver) {
      const person = String(r.approver);
      nodes.set(person, { id: person, label: "Person", caption: `${person} (${r.approverRole ?? "?"})` });
      rels.push({ id: `p-${i}`, from: approvalId, to: person, type: "APPROVED_BY" });
      if (r.approverDesk) {
        const desk = String(r.approverDesk);
        nodes.set(desk, { id: desk, label: "Desk", caption: desk });
        rels.push({ id: `d-${i}`, from: person, to: desk, type: "ON_DESK" });
      }
    }
  });
  return { nodes: [...nodes.values()], rels };
}

function readAcrossGraph(rows: Awaited<ReturnType<typeof nearMisses>>): GraphPayload {
  const nodes = new Map<string, GraphNode>();
  const rels: GraphRel[] = [];
  (rows as { positionId: string; rules: string[] }[]).slice(0, 15).forEach((r) => {
    nodes.set(r.positionId, { id: r.positionId, label: "Position", caption: r.positionId });
    r.rules.forEach((rule) => {
      if (!nodes.has(rule)) nodes.set(rule, { id: rule, label: "GovernanceGap", caption: rule });
      rels.push({ id: `${r.positionId}-${rule}`, from: r.positionId, to: rule, type: "HAS_GAP" });
    });
  });
  return { nodes: [...nodes.values()], rels };
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case "list_positions":
      return { rows: await listPositions() };
    case "timeline": {
      const positionId = String(args.positionId);
      const rows = await timeline(positionId);
      return { rows, graph: timelineGraph(positionId, rows) };
    }
    case "expected_controls": {
      const positionId = String(args.positionId);
      const rows = await expectedControls(positionId, {
        asOf: args.asOf ? String(args.asOf) : undefined,
      });
      return { rows, graph: expectedControlsGraph(positionId, rows) };
    }
    case "who_approved": {
      const eventId = String(args.eventId);
      const rows = await whoApproved(eventId);
      return { rows, graph: whoApprovedGraph(eventId, rows) };
    }
    case "divergence":
      return { rows: await divergence(String(args.positionId)) };
    case "read_across": {
      const rows = await nearMisses(args.minRules ? Number(args.minRules) : 2);
      return { rows, graph: readAcrossGraph(rows) };
    }
    case "policy_params":
      return { rows: await policyParams() };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export const SYSTEM_PROMPT = `You are the investigation assistant of a mismarking (fraudulent valuation) detection demo for senior operational-risk managers, built on a Neo4j graph.

Ground rules:
- The graph does NOT detect fraud. It detects the CONJUNCTION of weak signals that fraud leaves behind (methodology drift, price overrides, IPV divergence, unexplained P&L, missing approvals and escalations). A human establishes intent.
- You are not a text-to-Cypher engine. Use ONLY the typed tools; compose them.
- When asked to reconstruct a case, answer CHRONOLOGICALLY, in event-time order, and end with the controls that should have fired: always name the ControlObligation ids (R1..R9) and say whether each was MET, LATE, MISSED or PENDING.
- POS-TP is the confirmed public case (a 2012 US bank CIO mismarking case). Its dates are shifted +10 years to sit inside the demo window; each event keeps its authentic date in sourceAt and its public-record citation in sourceRef. Refer to actors by ROLE only.
- Dates: narrate using the event time in \`at\` (the demo clock, consistent with every other screen); when an event has a sourceAt, you may add "(authentic: YYYY-MM-DD)" once per event, never as the primary date.
- POS-FP is the deliberate false positive: its pattern matches, but its controls actually fired (only R2, R4, R6 show late/missing paperwork). Use it to show that the graph surfaces cases for HUMAN judgment.
- Tool results include a cypher_audit_trail field. NEVER echo or summarise it — the audit drawer on the right shows every query to the user.
- Be concise and precise; use GitHub-flavoured markdown tables or numbered chronologies where they help a risk manager read fast (the UI renders markdown properly).`;
