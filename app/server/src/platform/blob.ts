// BlobStore.
//
// Replaces direct filesystem access under FILES_DIR and the S3-compatible
// media asset store. Keys are "<workspace_id>/<area>/<id>"; the store
// enforces that every key starts with the workspace it is called for, so a
// caller cannot read across tenants by building a key by hand.
//
// Every object is sealed (C3 sealBytes, context = the key) by the store
// itself, so callers never handle ciphertext. With POMEGRANATE_SEAL=0 the
// bytes are stored as-is.
//
// Implementations: fs (today's FILES_DIR layout) and Azure Blob — A8. This
// file holds the contract and an in-memory store for tests.

export type BlobArea = 'sources' | 'documents' | 'media' | 'exports' | 'evidence';

export interface BlobPutOptions {
  contentType?: string;
}

export interface BlobInfo {
  key: string;
  bytes: number;
  contentType?: string;
}

export interface BlobStore {
  put(workspaceId: string, key: string, data: Uint8Array, opts?: BlobPutOptions): Promise<void>;
  /** undefined when the key does not exist. */
  get(workspaceId: string, key: string): Promise<Buffer | undefined>;
  /** No error when the key does not exist. */
  delete(workspaceId: string, key: string): Promise<void>;
  /** Keys under "<workspaceId>/<prefix>", sorted. */
  list(workspaceId: string, prefix: string): Promise<BlobInfo[]>;
  /** Delete every object of the workspace (workspace deletion). Returns the count deleted. */
  deleteWorkspace(workspaceId: string): Promise<number>;
}

export class BlobKeyError extends Error {
  constructor(workspaceId: string, key: string) {
    super(`blob key ${JSON.stringify(key)} is outside workspace ${workspaceId}`);
    this.name = 'BlobKeyError';
  }
}

/** Build a key. Ids must not contain "/" or "..". */
export function blobKey(workspaceId: string, area: BlobArea, id: string): string {
  if (!id || id.includes('..') || id.startsWith('/')) throw new BlobKeyError(workspaceId, id);
  return `${workspaceId}/${area}/${id}`;
}

/** Throws unless `key` belongs to `workspaceId`. Every implementation calls this first. */
export function assertKeyInWorkspace(workspaceId: string, key: string): void {
  if (!workspaceId || !key.startsWith(`${workspaceId}/`) || key.includes('..')) {
    throw new BlobKeyError(workspaceId, key);
  }
}

/** In-memory BlobStore for tests. Does not seal. */
export function memoryBlobStore(): BlobStore {
  const objects = new Map<string, { data: Buffer; contentType?: string }>();
  return {
    async put(ws, key, data, opts) {
      assertKeyInWorkspace(ws, key);
      objects.set(key, { data: Buffer.from(data), contentType: opts?.contentType });
    },
    async get(ws, key) {
      assertKeyInWorkspace(ws, key);
      const o = objects.get(key);
      return o ? Buffer.from(o.data) : undefined;
    },
    async delete(ws, key) {
      assertKeyInWorkspace(ws, key);
      objects.delete(key);
    },
    async list(ws, prefix) {
      const full = `${ws}/${prefix}`;
      assertKeyInWorkspace(ws, full);
      return [...objects.entries()]
        .filter(([k]) => k.startsWith(full))
        .map(([key, o]) => ({ key, bytes: o.data.length, contentType: o.contentType }))
        .sort((a, b) => a.key.localeCompare(b.key));
    },
    async deleteWorkspace(ws) {
      let n = 0;
      for (const k of [...objects.keys()]) {
        if (k.startsWith(`${ws}/`)) {
          objects.delete(k);
          n++;
        }
      }
      return n;
    },
  };
}
