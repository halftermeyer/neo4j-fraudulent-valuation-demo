// Cypher audit drawer (right edge) — cosmo-rd pattern. Everything the app or
// the Assistant runs shows up here, grouped, newest first. This is the
// transparency artifact the risk-manager audience asked for.

import { useEffect, useState } from "react";
import {
  clearQueryLog,
  getGroupedLog,
  getQueryLog,
  onQueryLogChange,
  type QueryGroup,
  type QueryLogEntry,
} from "../lib/neo4j";

function EntryView({ entry }: { entry: QueryLogEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`audit-entry ${entry.error ? "audit-error" : ""}`}>
      <button className="audit-entry-head" onClick={() => setOpen(!open)}>
        <span className="audit-entry-title">{entry.cypher.split("\n")[0].slice(0, 70)}</span>
        <span className="audit-entry-meta">
          {entry.durationMs}ms · {entry.rowCount} rows
        </span>
      </button>
      {open && (
        <div className="audit-entry-body">
          <pre>{entry.cypher}</pre>
          {Object.keys(entry.params).length > 0 && (
            <div className="audit-params">
              <strong>Params</strong>
              <pre>
                {JSON.stringify(
                  entry.params,
                  (_, v) => (typeof v === "string" && v.length > 200 ? v.slice(0, 200) + "…" : v),
                  2,
                )}
              </pre>
            </div>
          )}
          {entry.error && <div className="audit-error-msg">{entry.error}</div>}
          {entry.results && entry.results.length > 0 && (
            <div className="audit-results">
              <strong>Results (first {entry.results.length})</strong>
              <pre>{JSON.stringify(entry.results.slice(0, 5), null, 1).slice(0, 1500)}</pre>
            </div>
          )}
          <button
            className="audit-copy"
            onClick={() => navigator.clipboard.writeText(entry.cypher)}
          >
            Copy query
          </button>
        </div>
      )}
    </div>
  );
}

function GroupView({ group }: { group: QueryGroup }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`audit-group ${group.hasError ? "audit-error" : ""}`}>
      <button className="audit-group-head" onClick={() => setOpen(!open)}>
        <span>{group.label}</span>
        <span className="audit-entry-meta">
          {group.entries.length} queries · {group.totalMs}ms
        </span>
      </button>
      {open && group.entries.map((e) => <EntryView entry={e} key={e.id} />)}
    </div>
  );
}

export default function QueryAuditDrawer() {
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<QueryGroup[]>([]);
  const [count, setCount] = useState(0);

  useEffect(() => {
    const update = () => {
      setGroups([...getGroupedLog()]);
      setCount(getQueryLog().length);
    };
    update();
    return onQueryLogChange(update);
  }, []);

  return (
    <>
      <button className="audit-toggle" onClick={() => setOpen(!open)}>
        Cypher ({count})
      </button>
      <aside className={`audit-drawer ${open ? "open" : ""}`}>
        <div className="audit-drawer-head">
          <h2>Cypher audit</h2>
          <div>
            <button
              className="audit-copy"
              onClick={() =>
                navigator.clipboard.writeText(
                  getQueryLog()
                    .map((e) => `// ${e.timestamp.toISOString()} (${e.durationMs}ms)\n${e.cypher};`)
                    .join("\n\n"),
                )
              }
            >
              Copy all
            </button>
            <button className="audit-copy" onClick={() => clearQueryLog()}>
              Clear
            </button>
            <button className="audit-copy" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
        </div>
        <p className="audit-hint">
          Every query the app and the Assistant run, in order. Case events carry their
          public-record citation in <code>sourceRef</code> and authentic date in{" "}
          <code>sourceAt</code>.
        </p>
        <div className="audit-list">
          {[...groups].reverse().map((g, i) => (
            <GroupView group={g} key={i} />
          ))}
        </div>
      </aside>
    </>
  );
}
