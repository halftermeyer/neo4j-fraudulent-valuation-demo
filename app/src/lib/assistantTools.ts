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

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "list_positions":
      return listPositions();
    case "timeline":
      return timeline(String(args.positionId));
    case "expected_controls":
      return expectedControls(String(args.positionId), {
        asOf: args.asOf ? String(args.asOf) : undefined,
      });
    case "who_approved":
      return whoApproved(String(args.eventId));
    case "divergence":
      return divergence(String(args.positionId));
    case "read_across":
      return nearMisses(args.minRules ? Number(args.minRules) : 2);
    case "policy_params":
      return policyParams();
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
- Be concise and precise; use tables or numbered chronologies where they help a risk manager read fast.`;
