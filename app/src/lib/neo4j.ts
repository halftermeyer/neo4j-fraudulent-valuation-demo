// Driver singleton + query audit logging (cosmo-rd pattern).
// Every Cypher statement the app runs goes through runQuery() and lands in the
// audit log that the right-edge drawer renders — the audit trail IS the product.

import neo4j, { Driver } from "neo4j-driver";

let driver: Driver | null = null;

export function getDriver(): Driver {
  if (!driver) {
    driver = neo4j.driver(
      import.meta.env.VITE_NEO4J_URI || "bolt://127.0.0.1:7687",
      neo4j.auth.basic(
        import.meta.env.VITE_NEO4J_USER || "neo4j",
        import.meta.env.VITE_NEO4J_PASSWORD || "",
      ),
    );
  }
  return driver;
}

export interface QueryLogEntry {
  id: number;
  timestamp: Date;
  cypher: string;
  params: Record<string, unknown>;
  durationMs: number;
  rowCount: number;
  results?: unknown[];
  error?: string;
  group?: string;
}

export interface QueryGroup {
  label: string;
  entries: QueryLogEntry[];
  totalMs: number;
  totalRows: number;
  hasError: boolean;
}

let _logCounter = 0;
let _queryLog: QueryLogEntry[] = [];
let _currentGroup: string | null = null;
const _listeners: Set<() => void> = new Set();

function _notifyListeners(): void {
  _listeners.forEach((l) => l());
}

export function getQueryLog(): QueryLogEntry[] {
  return _queryLog;
}

export function clearQueryLog(): void {
  _queryLog = [];
  _notifyListeners();
}

export function pushLogEntry(entry: Omit<QueryLogEntry, "id">): void {
  _queryLog = [..._queryLog, { ...entry, id: ++_logCounter }];
  _notifyListeners();
}

export function beginGroup(label: string): void {
  _currentGroup = label;
}

export function endGroup(): void {
  _currentGroup = null;
}

export async function withGroup<T>(label: string, fn: () => Promise<T>): Promise<T> {
  beginGroup(label);
  try {
    return await fn();
  } finally {
    endGroup();
  }
}

export function onQueryLogChange(listener: () => void): () => void {
  _listeners.add(listener);
  return () => _listeners.delete(listener);
}

export function getGroupedLog(): QueryGroup[] {
  const groups: QueryGroup[] = [];
  for (const e of _queryLog) {
    const label = e.group || e.cypher.split("\n")[0].slice(0, 60);
    const last = groups[groups.length - 1];
    if (last && e.group && last.label === e.group) {
      last.entries.push(e);
      last.totalMs += e.durationMs;
      last.totalRows += e.rowCount;
      last.hasError = last.hasError || !!e.error;
    } else {
      groups.push({
        label,
        entries: [e],
        totalMs: e.durationMs,
        totalRows: e.rowCount,
        hasError: !!e.error,
      });
    }
  }
  return groups;
}

// Neo4j value -> plain JS (Integer, DateTime, Node, Relationship, Path aware)
export function toJS(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (neo4j.isInt(value)) return (value as { toNumber: () => number }).toNumber();
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (neo4j.isDateTime(value as never) || neo4j.isDate(value as never)) {
      return String(value);
    }
    if (v.labels && v.properties) {
      // Node
      return { _labels: v.labels, ...(toJS(v.properties) as Record<string, unknown>) };
    }
    if (v.type && v.properties && v.startNodeElementId !== undefined) {
      // Relationship
      return { _type: v.type, ...(toJS(v.properties) as Record<string, unknown>) };
    }
    if (Array.isArray(value)) return value.map(toJS);
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = toJS(val);
    return out;
  }
  return value;
}

export async function runQuery<T = Record<string, unknown>>(
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  const database = import.meta.env.VITE_NEO4J_DATABASE || undefined;
  const session = getDriver().session({ database });
  const start = performance.now();
  try {
    const result = await session.run(cypher, params);
    const rows = result.records.map((r) => {
      const row: Record<string, unknown> = {};
      r.keys.forEach((k) => {
        row[String(k)] = toJS(r.get(k));
      });
      return row as T;
    });
    pushLogEntry({
      timestamp: new Date(),
      cypher: cypher.trim(),
      params,
      durationMs: Math.round(performance.now() - start),
      rowCount: rows.length,
      results: rows.slice(0, 20),
      group: _currentGroup || undefined,
    });
    return rows;
  } catch (e) {
    pushLogEntry({
      timestamp: new Date(),
      cypher: cypher.trim(),
      params,
      durationMs: Math.round(performance.now() - start),
      rowCount: 0,
      error: (e as Error).message,
      group: _currentGroup || undefined,
    });
    throw e;
  } finally {
    await session.close();
  }
}
