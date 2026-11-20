// Seal-map plumbing for the repo modules (A4–A6 port of C3/C4).
//
// Every column in platform/seal-map.ts is sealed on write and opened on read
// through these helpers, so the modules never touch the crypto API directly.
// With sealing off (POMEGRANATE_SEAL=0, the default) each helper returns its
// input unchanged and never calls into crypto: stored bytes and read results
// are identical to the code before sealing existed.
//
// Row binding: the AAD includes a row id, so a sealed value only opens in the
// row it was written for. Callers pass the row's primary id; for tables keyed
// otherwise the caller documents what it binds to.

import type { Repo } from '../repo.js';

const on = (repo: Repo) => repo.crypto.sealing;

/** Seal a TEXT column value. null/undefined pass through (nullable columns). */
export async function sealText<T extends string | null | undefined>(repo: Repo, ws: string, column: string, rowId: string, value: T): Promise<T> {
  if (!on(repo) || value == null) return value;
  return (await repo.crypto.seal(ws, column, rowId, value)) as T;
}

export async function openText<T extends string | null | undefined>(repo: Repo, ws: string, column: string, rowId: string, value: T): Promise<T> {
  if (!on(repo) || value == null) return value;
  return (await repo.crypto.open(ws, column, rowId, value)) as T;
}

/** Seal a BLOB column (embeddings). */
export async function sealBlob<T extends Buffer | Uint8Array | null | undefined>(repo: Repo, ws: string, column: string, rowId: string, value: T): Promise<T> {
  if (!on(repo) || value == null) return value;
  return (await repo.crypto.sealBytes(ws, `${column}:${rowId}`, value)) as unknown as T;
}

export async function openBlob<T extends Buffer | Uint8Array | null | undefined>(repo: Repo, ws: string, column: string, rowId: string, value: T): Promise<T> {
  if (!on(repo) || value == null) return value;
  return (await repo.crypto.openBytes(ws, `${column}:${rowId}`, value)) as unknown as T;
}

const JSON_FIELDS: Record<string, readonly string[]> = {
  'graph_nodes.data': ['body'],
  'graph_nodes.redacted_data': ['body'],
  'candidates.proposed_node': ['body'],
  'wiki_blocks.content': ['text'],
};

/**
 * Seal the seal-map fields of a JSON column given as a string. Only those
 * top-level string fields change; everything else (title, type, attrs, …)
 * stays readable, and key order is preserved.
 */
export async function sealJson<T extends string | null | undefined>(repo: Repo, ws: string, column: string, rowId: string, json: T): Promise<T> {
  if (!on(repo) || json == null) return json;
  const obj = JSON.parse(json) as Record<string, unknown>;
  for (const f of fieldsOf(column)) {
    if (typeof obj[f] === 'string') obj[f] = await repo.crypto.seal(ws, `${column}#${f}`, rowId, obj[f] as string);
  }
  return JSON.stringify(obj) as T;
}

export async function openJson<T extends string | null | undefined>(repo: Repo, ws: string, column: string, rowId: string, json: T): Promise<T> {
  if (!on(repo) || json == null) return json;
  const obj = JSON.parse(json) as Record<string, unknown>;
  for (const f of fieldsOf(column)) {
    if (typeof obj[f] === 'string') obj[f] = await repo.crypto.open(ws, `${column}#${f}`, rowId, obj[f] as string);
  }
  return JSON.stringify(obj) as T;
}

function fieldsOf(column: string): readonly string[] {
  const f = JSON_FIELDS[column];
  if (!f) throw new Error(`sealing: ${column} is not a json-fields column`);
  return f;
}

/** A graph node's JSON is bound to the node id it carries. */
export function nodeIdOf(json: string): string {
  return (JSON.parse(json) as { id: string }).id;
}

/** Open a stored graph_nodes.data / redacted_data value (bound to its own node id). */
export async function openNodeData<T extends string | null | undefined>(repo: Repo, ws: string, json: T, column = 'graph_nodes.data'): Promise<T> {
  if (!on(repo) || json == null) return json;
  return openJson(repo, ws, column, nodeIdOf(json), json);
}

export async function sealNodeData(repo: Repo, ws: string, json: string, column = 'graph_nodes.data'): Promise<string> {
  if (!on(repo)) return json;
  return sealJson(repo, ws, column, nodeIdOf(json), json);
}

/** Open the same column on every row of a result, in place. */
export async function openRows<R extends Record<string, any>>(
  rows: R[],
  open: (row: R) => Promise<void>,
): Promise<R[]> {
  for (const r of rows) await open(r);
  return rows;
}
