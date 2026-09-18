// <Term> — a glossary occurrence: dotted underline in the current text colour,
// keyboard-focusable, Needle Tooltip with the short definition on hover/focus,
// click asks the AI companion how the concept appears in this graph.
// <GlossaryText> — wraps its children and marks the FIRST occurrence of each
// term per paragraph scope, skipping <code> and anything non-textual. Placed by
// hand only (business problems, scenario cards, companion answers).

import { Tooltip } from "@neo4j-ndl/react";
import { Children, cloneElement, isValidElement, useEffect, useState, type ReactNode } from "react";
import { askGlossary } from "../lib/companion";
import {
  findFirstMatch,
  isGlossaryOn,
  onGlossaryChange,
  type CompiledEntry,
} from "../lib/glossary";

export function Term({ entry, children }: { entry: CompiledEntry; children: string }) {
  return (
    <Tooltip isPortaled type="simple">
      <Tooltip.Trigger
        className="glossary-term"
        htmlAttributes={{
          onClick: () => void askGlossary(entry.term, entry.graphHint),
          "aria-label": `${entry.term}: ${entry.short}`,
        }}
      >
        {children}
      </Tooltip.Trigger>
      <Tooltip.Content>{entry.short}</Tooltip.Content>
    </Tooltip>
  );
}

function wrapString(text: string, seen: Set<string>, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let k = 0;
  while (rest.length > 0) {
    const match = findFirstMatch(rest, seen);
    if (!match) {
      out.push(rest);
      break;
    }
    seen.add(match.entry.term);
    if (match.index > 0) out.push(rest.slice(0, match.index));
    out.push(
      <Term entry={match.entry} key={`${keyBase}-${k++}`}>
        {rest.slice(match.index, match.index + match.length)}
      </Term>,
    );
    rest = rest.slice(match.index + match.length);
  }
  return out;
}

function walk(node: ReactNode, seen: Set<string>, keyBase: string): ReactNode {
  if (typeof node === "string") return wrapString(node, seen, keyBase);
  if (Array.isArray(node)) return node.map((c, i) => walk(c, seen, `${keyBase}.${i}`));
  if (isValidElement(node)) {
    // never inside code / ids
    if (node.type === "code" || node.type === "pre") return node;
    const props = node.props as { children?: ReactNode };
    if (props.children === undefined) return node;
    return cloneElement(node, { key: node.key ?? keyBase }, walk(props.children, seen, `${keyBase}>`));
  }
  return node;
}

export default function GlossaryText({ children }: { children: ReactNode }) {
  const [, force] = useState(0);
  useEffect(() => onGlossaryChange(() => force((n) => n + 1)), []);
  if (!isGlossaryOn()) return <>{children}</>;
  const seen = new Set<string>(); // first occurrence per paragraph scope
  return <>{Children.map(children, (c, i) => walk(c, seen, `g${i}`))}</>;
}
