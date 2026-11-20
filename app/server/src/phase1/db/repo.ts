// Data access. Every SQL read and write goes through Repo.
//
// The methods live in repo/<module>.ts, one class per area: identity, structure,
// graph, ingest, features, media. Each method takes `this: Repo`, and the classes
// are mixed into Repo below, so callers keep using `new Repo(db).method()`.

import type Database from 'better-sqlite3';
import type { Db } from '../../platform/db.js';
import type { Crypto } from '../../platform/crypto.js';
import { cryptoFromEnv } from '../../lib/crypto/boot.js';
import { createSqliteDb } from './driver/sqlite.js';
import { IdentityRepo } from './repo/identity.js';
import { StructureRepo } from './repo/structure.js';
import { GraphRepo } from './repo/graph.js';
import { IngestRepo } from './repo/ingest.js';
import { FeaturesRepo } from './repo/features.js';
import { MediaRepo } from './repo/media.js';

export {
  normalizePhoneDigits,
  CUSTOMER_AUDIT_EVENTS,
} from './repo/shared.js';
export type {
  UpdateMedium,
  UpdateSubscriptionStatus,
  UpdateApprovalMode,
  UpdateDeliveryStatus,
  UpdateKind,
  UpdateTarget,
  UpdateSubscription,
  UpdateDelivery,
  RecipientList,
  PendingRouteRow,
  Workspace,
  SubgraphRow,
  Rule,
  AutomationKind,
  Automation,
  AutomationRun,
  User,
  UserIdentity,
  DefaultSurface,
  UserDefault,
  AgentThread,
  Membership,
  AuditEntry,
  CustomerAuditEvent,
  CustomerAuditEntry,
  CustomerAuditRow,
  ContextUsageTool,
  ContextAccessEntry,
  ContextUsageRow,
  WikiPage,
  WikiBlock,
} from './repo/shared.js';

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface Repo extends IdentityRepo, StructureRepo, GraphRepo, IngestRepo, FeaturesRepo, MediaRepo {}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class Repo {
  /**
   * The C1 Db handle (SQLite adapter on `db`'s connection). Every repo module
   * runs its SQL through it. `db` (raw better-sqlite3) remains for schema
   * migration and tests only.
   */
  readonly sql: Db;

  /**
   * C3 encryption for the seal-map columns. Pass-through (nothing encrypted)
   * unless the server boots with POMEGRANATE_SEAL=1, when it is replaced by
   * cryptoFromEnv (lib/crypto/boot.ts). Repo modules seal on write and open
   * on read through it (repo/sealing.ts).
   */
  crypto: Crypto;

  constructor(public readonly db: Database.Database) {
    this.sql = createSqliteDb(db);
    // From the C9 flags: pass-through unless POMEGRANATE_SEAL=1. The server
    // re-sets it at boot to add the unwrap-failure audit hook.
    this.crypto = cryptoFromEnv(this.sql).crypto;
  }

  /** Run async `fn` in one transaction on the Db handle (nested calls = savepoints). */
  tx<T>(fn: () => Promise<T>): Promise<T> {
    return this.sql.tx(async () => await fn());
  }

}

for (const part of [IdentityRepo, StructureRepo, GraphRepo, IngestRepo, FeaturesRepo, MediaRepo]) {
  for (const name of Object.getOwnPropertyNames(part.prototype)) {
    if (name === 'constructor') continue;
    if (Object.prototype.hasOwnProperty.call(Repo.prototype, name)) throw new Error(`Repo method defined twice: ${name}`);
    Object.defineProperty(Repo.prototype, name, Object.getOwnPropertyDescriptor(part.prototype, name)!);
  }
}
