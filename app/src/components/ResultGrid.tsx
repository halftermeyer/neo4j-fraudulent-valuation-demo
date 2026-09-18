// Tabular tool results as a real Needle DataGrid — sortable, with event ids
// rendered as links that select the node in Explore. Never raw pipes/dashes.

import { DataGrid } from "@neo4j-ndl/react";
import {
  createColumnHelper,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { useMemo, useState } from "react";
import { openInExplore } from "../lib/exploreLink";

type Row = Record<string, unknown>;

// Explore starts from a Position, so only position-context ids link there:
// positions themselves and the event/gap ids that carry a positionId. Rules,
// desks, people, attributes, patterns etc. have no Explore anchoring.
const NODE_ID_RE =
  /^(POS|PO|MC|MCH|IPV|MAP|PNL|CTL|APR|ESC|EV|RC|CA|INC|GAP|OVR)-[A-Za-z0-9:._-]+$/;

function isNodeId(v: unknown): v is string {
  return typeof v === "string" && v.length >= 2 && NODE_ID_RE.test(v) && v !== v.toLowerCase();
}

function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(3);
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);
  if (Array.isArray(v)) return v.map(String).join(", ");
  if (typeof v === "object") return JSON.stringify(v).slice(0, 80);
  return s.length > 90 ? s.slice(0, 90) + "…" : s;
}

export default function ResultGrid({ rows }: { rows: Row[] }) {
  const [sorting, setSorting] = useState<SortingState>([]);

  const columns = useMemo<ColumnDef<Row, unknown>[]>(() => {
    const keys = rows.length > 0 ? Object.keys(rows[0]).filter((k) => k !== "props") : [];
    const helper = createColumnHelper<Row>();
    return keys.map((key) =>
      helper.accessor((r) => r[key], {
        id: key,
        header: key,
        cell: (info) => {
          const v = info.getValue();
          if (isNodeId(v)) {
            return (
              <button className="grid-node-link" onClick={() => openInExplore(v)}>
                {v}
              </button>
            );
          }
          if (Array.isArray(v) && v.every(isNodeId)) {
            return (
              <span>
                {v.map((id) => (
                  <button className="grid-node-link" key={id} onClick={() => openInExplore(id)}>
                    {id}
                  </button>
                ))}
              </span>
            );
          }
          return fmtCell(v);
        },
      }),
    );
  }, [rows]);

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableSorting: true,
  });

  if (rows.length === 0) return <div className="hint">no rows</div>;
  return (
    <div className="result-grid">
      <DataGrid
        isKeyboardNavigable={false}
        isResizable
        styling={{ hasZebraStriping: true, borderStyle: "horizontal", isCompact: true }}
        tableInstance={table}
      />
    </div>
  );
}
