// migration flags.
//
// Deployments run the same code with different flags: the default
// (existing users, defaults below) and Azure (new users, every flag flipped).
// Every Azure-side capability lands on master behind one of these, and the
// FIRST value of each is the default — the single-server setup.
// A merge with default flags must leave that default behaviour
// unchanged.
//
// This parser is the only reader of these variables. Once C7 config() exists
// (A8), it calls parseFlags(process.env) and exposes the result as
// config().flags; nothing else reads them.

export type DbDriverFlag = 'sqlite' | 'pg';
export type BlobDriverFlag = 'fs' | 'azure';
export type KeyProviderFlag = 'local' | 'azurekv';
export type JobQueueFlag = 'inproc' | 'pg';
export type SurfaceName = 'slack' | 'whatsapp';

export interface Flags {
  /** POMEGRANATE_DB_DRIVER */
  dbDriver: DbDriverFlag;
  /** POMEGRANATE_BLOB_DRIVER */
  blobDriver: BlobDriverFlag;
  /** POMEGRANATE_KEY_PROVIDER */
  keyProvider: KeyProviderFlag;
  /** POMEGRANATE_JOB_QUEUE */
  jobQueue: JobQueueFlag;
  /** POMEGRANATE_SEAL — false: seal() is the identity function (default). */
  seal: boolean;
  /** SURFACES — which bots the host process mounts. Empty = none (bots run as separate processes). */
  surfaces: SurfaceName[];
  /**
   * MCP_CAPABILITY_URLS — serve the legacy secret-in-URL connector paths
   * (/mcp/connector/:secret). On by default; off where MCP
   * clients sign in with OAuth (decision I).
   */
  mcpCapabilityUrls: boolean;
}

export const FLAG_DEFAULTS: Readonly<Flags> = Object.freeze({
  dbDriver: 'sqlite',
  blobDriver: 'fs',
  keyProvider: 'local',
  jobQueue: 'inproc',
  seal: false,
  surfaces: [],
  mcpCapabilityUrls: true,
});

export class FlagError extends Error {
  constructor(readonly variable: string, readonly value: string, readonly allowed: readonly string[]) {
    super(`${variable}=${JSON.stringify(value)} is not one of: ${allowed.join(', ')}`);
    this.name = 'FlagError';
  }
}

function oneOf<T extends string>(env: Record<string, string | undefined>, name: string, allowed: readonly T[]): T {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return allowed[0] as T;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new FlagError(name, raw, allowed);
}

/**
 * Parse the C9 flags. Unknown values throw — a typo in a flag must fail boot,
 * never silently fall back to a different backend.
 */
export function parseFlags(env: Record<string, string | undefined>): Flags {
  const sealRaw = oneOf(env, 'POMEGRANATE_SEAL', ['0', '1'] as const);
  const surfaces: SurfaceName[] = [];
  for (const s of (env.SURFACES ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    if (s !== 'slack' && s !== 'whatsapp') throw new FlagError('SURFACES', s, ['slack', 'whatsapp']);
    if (!surfaces.includes(s)) surfaces.push(s);
  }
  return Object.freeze({
    dbDriver: oneOf(env, 'POMEGRANATE_DB_DRIVER', ['sqlite', 'pg'] as const),
    blobDriver: oneOf(env, 'POMEGRANATE_BLOB_DRIVER', ['fs', 'azure'] as const),
    keyProvider: oneOf(env, 'POMEGRANATE_KEY_PROVIDER', ['local', 'azurekv'] as const),
    jobQueue: oneOf(env, 'POMEGRANATE_JOB_QUEUE', ['inproc', 'pg'] as const),
    seal: sealRaw === '1',
    surfaces,
    mcpCapabilityUrls: oneOf(env, 'MCP_CAPABILITY_URLS', ['1', '0'] as const) === '1',
  });
}
