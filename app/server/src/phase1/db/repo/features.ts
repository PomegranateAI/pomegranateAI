// Repo methods: data agents, templates, the Report, rules, automations, context usage, wiki, Subscribe to Updates, recipient lists.
// Split from repo.ts.
// Methods take `this: Repo` so they can call across modules; repo.ts
// mixes every module class into Repo, so callers still use `repo.method()`.

import { nanoid } from 'nanoid';
import { ContextProfile, IngestionCriteria } from '../../../lib/schemas.js';
import type { ContextProfile as ContextProfileT } from '../../../lib/schemas.js';
import { embeddingToBlob } from '../../../lib/embeddings.js';
import { ReportContent, type ReportContent as ReportContentT } from '../../report/types.js';
import {
  UpdateMedium,
  UpdateSubscriptionStatus,
  UpdateApprovalMode,
  UpdateDeliveryStatus,
  UpdateKind,
  UpdateTarget,
  UpdateSubscription,
  UpdateDelivery,
  RecipientList,
  Workspace,
  Rule,
  AutomationKind,
  Automation,
  AutomationRun,
  Membership,
  ContextAccessEntry,
  ContextUsageRow,
  WikiPage,
  WikiBlock,
  RecipientListRow,
  rowToRecipientList,
  UpdateSubscriptionRow,
  UpdateDeliveryRow,
  rowToUpdateSubscription,
  rowToUpdateDelivery,
} from './shared.js';
import type Database from 'better-sqlite3';
import type { ExecResult, SqlValue } from '../../../platform/db.js';
import type { Repo } from '../repo.js';
import { openJson, openRows, openText, sealJson, sealText } from './sealing.js';

/** node_evidence has no id column: a sealed quote is bound to its node + document. */
function evidenceSealRef(node_id: string, document_id: string): string {
  return `${node_id}\u0000${document_id}`;
}

/**
 * context_request_texts' id is assigned by the database at insert, after the
 * value is sealed, so its request_text is bound to the workspace and column
 * only (still unreadable outside them).
 */
const REQUEST_TEXT_REF = 'request';

export class FeaturesRepo {
  // ---------- data agents (spec-data-agents-and-subfolder-wiki.md) ----------

  /** The active (status='active') binding for one subfolder, or undefined —
   *  the single read the capture dispatch branch (§3) is decided from. */
  async getActiveDataAgent(this: Repo,
    workspace_id: string,
    subgraph_id: string,
  ):
    Promise<| {
        template_id: string;
        template: ContextProfileT;
        cadence: 'once' | 'per_document' | 'scheduled';
        cadence_ms: number | null;
        attached_at: string;
        last_run_at: string | null;
      }
    | undefined> {
    const row = (await this.sql.one<any>(`SELECT template_id, template, cadence, cadence_ms, attached_at, last_run_at
         FROM subfolder_data_agents WHERE workspace_id = ? AND subgraph_id = ? AND status = 'active'`, [workspace_id, subgraph_id])) as
      | {
          template_id: string;
          template: string;
          cadence: 'once' | 'per_document' | 'scheduled';
          cadence_ms: number | null;
          attached_at: string;
          last_run_at: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return { ...row, template: ContextProfile.parse(JSON.parse(row.template)) };
  }

  /**
   * Attach (or, over an existing active row, Change — same write, no
   * distinct code path needed since the PK already enforces "one at a
   * time"). `template` is the FROZEN resolved snapshot at this moment —
   * never a live reference (spec §5.3).
   */
  async attachDataAgent(this: Repo,
    workspace_id: string,
    subgraph_id: string,
    opts: {
      template_id: string;
      template: ContextProfileT;
      cadence: 'once' | 'per_document' | 'scheduled';
      cadence_ms?: number;
      attached_by: string;
    },
  ): Promise<void> {
    const now = new Date().toISOString();
    const existing = (await this.sql.one<any>(`SELECT created_at FROM subfolder_data_agents WHERE workspace_id = ? AND subgraph_id = ?`, [workspace_id, subgraph_id])) as { created_at: string } | undefined;
    (await this.sql.exec(`INSERT OR REPLACE INTO subfolder_data_agents
           (workspace_id, subgraph_id, template_id, template, cadence, cadence_ms, status,
            attached_by, attached_at, detached_at, last_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL, ?, ?)`, [workspace_id, subgraph_id, opts.template_id, JSON.stringify(opts.template), opts.cadence, opts.cadence_ms ?? null, opts.attached_by, now, existing?.created_at ?? now, now]));
  }

  /**
   * Turns the agent off for a subfolder — the row is KEPT with
   * status='detached', not deleted (spec §5.1/§6a: the sidebar dot and
   * Setup's history read this; the note pass resumes for future documents
   * because `getActiveDataAgent` no longer returns a row). No-op if
   * already detached or never attached.
   */
  async detachDataAgent(this: Repo, workspace_id: string, subgraph_id: string): Promise<void> {
    (await this.sql.exec(`UPDATE subfolder_data_agents SET status = 'detached', detached_at = ?, updated_at = ?
         WHERE workspace_id = ? AND subgraph_id = ? AND status = 'active'`, [new Date().toISOString(), new Date().toISOString(), workspace_id, subgraph_id]));
  }

  /** Every subfolder in the workspace with a currently-active agent — the
   *  sidebar dot (§4.1) reads this in one call rather than per-subfolder. */
  async listActiveDataAgentSubgraphs(this: Repo, workspace_id: string): Promise<string[]> {
    return (
      (await this.sql.query<any>(`SELECT subgraph_id FROM subfolder_data_agents WHERE workspace_id = ? AND status = 'active'`, [workspace_id])) as { subgraph_id: string }[]
    ).map((r) => r.subgraph_id);
  }

  // ---- custom template CRUD (the workspace's own library, §4.2/Setup) ----

  async listDataAgentTemplates(this: Repo, workspace_id: string): Promise<Array<{
    id: string;
    name: string;
    profile: ContextProfileT;
    created_at: string;
    updated_at: string;
  }>> {
    const rows = (await this.sql.query<any>(`SELECT id, name, profile, created_at, updated_at FROM data_agent_templates WHERE workspace_id = ? ORDER BY name`, [workspace_id])) as Array<{ id: string; name: string; profile: string; created_at: string; updated_at: string }>;
    return rows.map((r) => ({ ...r, profile: ContextProfile.parse(JSON.parse(r.profile)) }));
  }

  async getDataAgentTemplate(this: Repo, workspace_id: string, id: string): Promise<ContextProfileT | undefined> {
    const row = (await this.sql.one<any>(`SELECT profile FROM data_agent_templates WHERE workspace_id = ? AND id = ?`, [workspace_id, id])) as { profile: string } | undefined;
    return row ? ContextProfile.parse(JSON.parse(row.profile)) : undefined;
  }

  /** Create or overwrite-in-place (Save, §4.2) a custom template by id. */
  async saveDataAgentTemplate(this: Repo,
    workspace_id: string,
    opts: { id?: string; name: string; profile: ContextProfileT; forked_from?: string; created_by: string },
  ): Promise<{ id: string }> {
    const id = opts.id ?? `tpl_${nanoid(10)}`;
    const now = new Date().toISOString();
    const existing = (await this.sql.one<any>(`SELECT created_at FROM data_agent_templates WHERE workspace_id = ? AND id = ?`, [workspace_id, id])) as { created_at: string } | undefined;
    (await this.sql.exec(`INSERT OR REPLACE INTO data_agent_templates
           (workspace_id, id, name, profile, forked_from, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [workspace_id, id, opts.name, JSON.stringify(opts.profile), opts.forked_from ?? null, opts.created_by, existing?.created_at ?? now, now]));
    return { id };
  }

  /** Rejected if any subfolder still has this template actively attached —
   *  caller (routes.ts) checks `listActiveDataAgentSubgraphs`-style usage
   *  first and surfaces the count, matching the Subfolders card's own
   *  delete-guard UX (spec §4.2). */
  async deleteDataAgentTemplate(this: Repo, workspace_id: string, id: string): Promise<void> {
    (await this.sql.exec(`DELETE FROM data_agent_templates WHERE workspace_id = ? AND id = ?`, [workspace_id, id]));
  }

  /** How many subfolders currently have this template actively attached —
   *  the Setup card's "used by N subfolders" line and the delete guard. */
  async countActiveUsersOfTemplate(this: Repo, workspace_id: string, template_id: string): Promise<number> {
    const row = (await this.sql.one<any>(`SELECT COUNT(*) AS n FROM subfolder_data_agents
         WHERE workspace_id = ? AND template_id = ? AND status = 'active'`, [workspace_id, template_id])) as { n: number };
    return row.n;
  }

  // ---------- the Report (spec-data-agents-and-subfolder-wiki.md §4.3) ----------

  /** The subfolder's current Report, or undefined if never generated. ONE
   *  row, replaced wholesale by saveReport — no versioning/diffing. */
  async getReport(this: Repo, workspace_id: string, subgraph_id: string): Promise<{ content: ReportContentT; generated_at: string } | undefined> {
    const row = (await this.sql.one<any>(`SELECT content, generated_at FROM subfolder_reports WHERE workspace_id = ? AND subgraph_id = ?`, [workspace_id, subgraph_id])) as { content: string; generated_at: string } | undefined;
    if (!row) return undefined;
    return { content: ReportContent.parse(JSON.parse(row.content)), generated_at: row.generated_at };
  }

  async saveReport(this: Repo, workspace_id: string, subgraph_id: string, content: ReportContentT): Promise<{ generated_at: string }> {
    const generated_at = new Date().toISOString();
    (await this.sql.exec(`INSERT OR REPLACE INTO subfolder_reports (workspace_id, subgraph_id, content, generated_at)
         VALUES (?, ?, ?, ?)`, [workspace_id, subgraph_id, JSON.stringify(content), generated_at]));
    return { generated_at };
  }

  // ---- Ingestion/sharing rules (spec-directory-tracking-and-ingestion-rules.md) ----

  async rowToRule(this: Repo, r: Record<string, unknown>): Promise<Rule> {
    return {
      id: r.id as string,
      workspace_id: r.workspace_id as string,
      instructions: r.instructions as string,
      scopes: r.scopes ? (JSON.parse(r.scopes as string) as string[]) : [],
      phases: r.phases ? (JSON.parse(r.phases as string) as string[]) : [],
      action: (r.action as string | null) ?? null,
      target: (r.target as string) ?? 'node',
      enabled: !!(r.enabled as number),
      owner_user_id: (r.owner_user_id as string | null) ?? null,
      sort_order: (r.sort_order as number) ?? 0,
      created_at: r.created_at as string,
      updated_at: r.updated_at as string,
    };
  }

  async listRules(this: Repo, workspace_id: string): Promise<Rule[]> {
    return await Promise.all((
      (await this.sql.query<any>(`SELECT * FROM rules WHERE workspace_id = ? ORDER BY sort_order ASC, created_at ASC`, [workspace_id])) as Array<Record<string, unknown>>
    ).map(async (r) => await this.rowToRule(r)));
  }

  async getRule(this: Repo, workspace_id: string, id: string): Promise<Rule | undefined> {
    const r = (await this.sql.one<any>(`SELECT * FROM rules WHERE workspace_id = ? AND id = ?`, [workspace_id, id])) as
      | Record<string, unknown>
      | undefined;
    return r ? await this.rowToRule(r) : undefined;
  }

  /**
   * Insert or update a rule. Pass `id` to update an existing rule (idempotent
   * upsert by (workspace_id, id) — the shape the /sync/rule mirror push relies
   * on); omit it to mint a fresh `r_<nanoid>`. created_at is preserved on update.
   */
  async upsertRule(this: Repo,
    workspace_id: string,
    input: {
      id?: string;
      instructions: string;
      scopes: string[];
      phases: string[];
      action?: string | null;
      target?: string;
      enabled?: boolean;
      owner_user_id?: string | null;
      sort_order?: number;
      created_at?: string;
    },
  ): Promise<Rule> {
    const now = new Date().toISOString();
    const id = input.id ?? `r_${nanoid(10)}`;
    const prior = await this.getRule(workspace_id, id);
    const created_at = prior?.created_at ?? input.created_at ?? now;
    (await this.sql.exec(`INSERT INTO rules (id, workspace_id, instructions, scopes, phases, action, target, enabled, owner_user_id, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, id) DO UPDATE SET
           instructions = excluded.instructions,
           scopes = excluded.scopes,
           phases = excluded.phases,
           action = excluded.action,
           target = excluded.target,
           enabled = excluded.enabled,
           owner_user_id = excluded.owner_user_id,
           sort_order = excluded.sort_order,
           updated_at = excluded.updated_at`, [id, workspace_id, input.instructions, JSON.stringify(input.scopes), JSON.stringify(input.phases), input.action ?? null, input.target ?? 'node', input.enabled === false ? 0 : 1, input.owner_user_id ?? null, input.sort_order ?? 0, created_at, now]));
    return (await this.getRule(workspace_id, id))!;
  }

  async deleteRule(this: Repo, workspace_id: string, id: string): Promise<void> {
    (await this.sql.exec(`DELETE FROM rules WHERE workspace_id = ? AND id = ?`, [workspace_id, id]));
  }

  /**
   * Seed the three default rules for a workspace, once. Idempotent: only fires
   * when the workspace has zero rules, so an owner who deletes a default never
   * has it resurrected. See spec §5.6.
   */
  async seedDefaultRules(this: Repo, workspace_id: string, owner_user_id: string | null): Promise<void> {
    const count = (
      (await this.sql.one<any>(`SELECT COUNT(*) AS n FROM rules WHERE workspace_id = ?`, [workspace_id])) as { n: number }
    ).n;
    if (count > 0) return;
    const defaults: Array<Omit<Parameters<Repo['upsertRule']>[1], 'id'>> = [
      {
        instructions: 'Do not index casual chatter in call transcripts and Slack communication',
        scopes: ['private', 'team'],
        phases: ['store'],
        action: 'shape',
        sort_order: 0,
      },
      {
        instructions: 'Hide PII from customer call transcripts',
        scopes: ['only_me', 'private', 'team'],
        phases: ['store', 'use'],
        action: 'shape',
        sort_order: 1,
      },
      {
        instructions: 'Do not share timelines for product releases',
        scopes: ['team'],
        phases: ['use'],
        action: 'shape',
        sort_order: 2,
      },
    ];
    for (const d of defaults) await this.upsertRule(workspace_id, { ...d, owner_user_id });
  }

  // ---- Unified automations (supersedes `rules` — see migrateRulesToAutomations) ----

  async rowToAutomation(this: Repo, r: Record<string, unknown>): Promise<Automation> {
    return {
      id: r.id as string,
      workspace_id: r.workspace_id as string,
      kind: r.kind as AutomationKind,
      instructions: (r.instructions as string | null) ?? null,
      scopes: r.scopes ? (JSON.parse(r.scopes as string) as string[]) : [],
      phases: r.phases ? (JSON.parse(r.phases as string) as string[]) : [],
      action: (r.action as string | null) ?? null,
      target: (r.target as string) ?? 'node',
      connector: (r.connector as string | null) ?? null,
      criteria: r.criteria ? (JSON.parse(r.criteria as string) as IngestionCriteria) : null,
      subgraph_id: (r.subgraph_id as string | null) ?? null,
      run_instructions: (r.run_instructions as string | null) ?? null,
      cadence_ms: (r.cadence_ms as number | null) ?? null,
      status: (r.status as 'active' | 'paused') ?? 'active',
      last_run_at: (r.last_run_at as string | null) ?? null,
      next_run_at: (r.next_run_at as string | null) ?? null,
      watermark: (r.watermark as string | null) ?? null,
      fail_count: (r.fail_count as number) ?? 0,
      slack_team_id: (r.slack_team_id as string | null) ?? null,
      slack_channel_id: (r.slack_channel_id as string | null) ?? null,
      device_id: (r.device_id as string | null) ?? null,
      local_path: (r.local_path as string | null) ?? null,
      enabled: !!(r.enabled as number),
      owner_user_id: (r.owner_user_id as string | null) ?? null,
      sort_order: (r.sort_order as number) ?? 0,
      created_at: r.created_at as string,
      updated_at: r.updated_at as string,
    };
  }

  async listAutomations(this: Repo, workspace_id: string, kind?: AutomationKind): Promise<Automation[]> {
    const rows = kind
      ? ((await this.sql.query<any>(`SELECT * FROM automations WHERE workspace_id = ? AND kind = ? ORDER BY sort_order ASC, created_at ASC`, [workspace_id, kind])) as Array<Record<string, unknown>>)
      : ((await this.sql.query<any>(`SELECT * FROM automations WHERE workspace_id = ? ORDER BY sort_order ASC, created_at ASC`, [workspace_id])) as Array<Record<string, unknown>>);
    return await Promise.all(rows.map(async (r) => await this.rowToAutomation(r)));
  }

  async getAutomation(this: Repo, workspace_id: string, id: string): Promise<Automation | undefined> {
    const r = (await this.sql.one<any>(`SELECT * FROM automations WHERE workspace_id = ? AND id = ?`, [workspace_id, id])) as
      | Record<string, unknown>
      | undefined;
    return r ? await this.rowToAutomation(r) : undefined;
  }

  /**
   * Insert or update an automation. Pass `id` to update an existing row
   * (idempotent upsert by (workspace_id, id) — the shape both the shape-rule
   * mirror push and migrateRulesToAutomations rely on to preserve ids); omit
   * it to mint a fresh `au_<nanoid>`. created_at is preserved on update.
   */
  async upsertAutomation(this: Repo,
    workspace_id: string,
    input: {
      id?: string;
      kind: AutomationKind;
      instructions?: string | null;
      scopes?: string[];
      phases?: string[];
      action?: string | null;
      target?: string;
      connector?: string | null;
      criteria?: IngestionCriteria | null;
      subgraph_id?: string | null;
      run_instructions?: string | null;
      cadence_ms?: number | null;
      status?: 'active' | 'paused';
      last_run_at?: string | null;
      next_run_at?: string | null;
      watermark?: string | null;
      fail_count?: number;
      slack_team_id?: string | null;
      slack_channel_id?: string | null;
      device_id?: string | null;
      local_path?: string | null;
      enabled?: boolean;
      owner_user_id?: string | null;
      sort_order?: number;
      created_at?: string;
    },
  ): Promise<Automation> {
    const now = new Date().toISOString();
    const id = input.id ?? `au_${nanoid(10)}`;
    const prior = await this.getAutomation(workspace_id, id);
    const created_at = prior?.created_at ?? input.created_at ?? now;
    (await this.sql.exec(`INSERT INTO automations (
           id, workspace_id, kind, instructions, scopes, phases, action, target,
           connector, criteria, subgraph_id, run_instructions, cadence_ms, status,
           last_run_at, next_run_at, watermark, fail_count,
           slack_team_id, slack_channel_id, device_id, local_path,
           enabled, owner_user_id, sort_order, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, id) DO UPDATE SET
           kind = excluded.kind,
           instructions = excluded.instructions,
           scopes = excluded.scopes,
           phases = excluded.phases,
           action = excluded.action,
           target = excluded.target,
           connector = excluded.connector,
           criteria = excluded.criteria,
           subgraph_id = excluded.subgraph_id,
           run_instructions = excluded.run_instructions,
           cadence_ms = excluded.cadence_ms,
           status = excluded.status,
           last_run_at = excluded.last_run_at,
           next_run_at = excluded.next_run_at,
           watermark = excluded.watermark,
           fail_count = excluded.fail_count,
           slack_team_id = excluded.slack_team_id,
           slack_channel_id = excluded.slack_channel_id,
           device_id = excluded.device_id,
           local_path = excluded.local_path,
           enabled = excluded.enabled,
           owner_user_id = excluded.owner_user_id,
           sort_order = excluded.sort_order,
           updated_at = excluded.updated_at`, [id, workspace_id, input.kind, input.instructions ?? null, JSON.stringify(input.scopes ?? []), JSON.stringify(input.phases ?? []), input.action ?? null, input.target ?? 'node', input.connector ?? null, input.criteria ? JSON.stringify(input.criteria) : null, input.subgraph_id ?? null, input.run_instructions ?? null, input.cadence_ms ?? null, input.status ?? 'active', input.last_run_at ?? null, input.next_run_at ?? null, input.watermark ?? null, input.fail_count ?? 0, input.slack_team_id ?? null, input.slack_channel_id ?? null, input.device_id ?? null, input.local_path ?? null, input.enabled === false ? 0 : 1, input.owner_user_id ?? null, input.sort_order ?? 0, created_at, now]));
    return (await this.getAutomation(workspace_id, id))!;
  }

  async deleteAutomation(this: Repo, workspace_id: string, id: string): Promise<void> {
    (await this.sql.exec(`DELETE FROM automations WHERE workspace_id = ? AND id = ?`, [workspace_id, id]));
  }

  /**
   * Automations due for a scheduled run right now. `cadence_ms IS NOT NULL`
   * makes track_directory rows (always cadence_ms=NULL — the cloud can't scan
   * a filesystem) and shape rows (no cadence at all — standing policy, not a
   * scheduled job) structurally invisible here, not just conventionally so.
   */
  async dueAutomations(this: Repo, now: Date, kind?: AutomationKind): Promise<Automation[]> {
    const nowIso = now.toISOString();
    const rows = (
      kind
        ? (await this.sql.query(`SELECT * FROM automations WHERE status = 'active' AND cadence_ms IS NOT NULL AND next_run_at <= ? AND kind = ? ORDER BY next_run_at ASC`, [nowIso, kind]))
        : (await this.sql.query(`SELECT * FROM automations WHERE status = 'active' AND cadence_ms IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC`, [nowIso]))
    ) as Array<Record<string, unknown>>;
    return await Promise.all(rows.map(async (r) => await this.rowToAutomation(r)));
  }

  /** Advance an automation's schedule state after a run (scheduled or manual). */
  async advanceAutomation(this: Repo,
    workspace_id: string,
    id: string,
    opts: { last_run_at: string; next_run_at?: string | null; watermark?: string | null; fail_count?: number },
  ): Promise<void> {
    const a = await this.getAutomation(workspace_id, id);
    if (!a) return;
    (await this.sql.exec(`UPDATE automations SET last_run_at = ?, next_run_at = ?, watermark = ?, fail_count = ?, updated_at = ?
         WHERE workspace_id = ? AND id = ?`, [opts.last_run_at, opts.next_run_at !== undefined ? opts.next_run_at : a.next_run_at, opts.watermark !== undefined ? opts.watermark : a.watermark, opts.fail_count ?? a.fail_count, new Date().toISOString(), workspace_id, id]));
  }

  async recordAutomationRun(this: Repo,
    workspace_id: string,
    input: {
      id?: string;
      automation_id: string;
      trigger: 'scheduled' | 'manual_run';
      outcome: 'ok' | 'empty' | 'error';
      window_from?: string | null;
      window_to?: string | null;
      items_seen?: number;
      items_ingested?: number;
      document_ids?: string[];
      candidate_count?: number;
      summary?: string | null;
      error?: string | null;
    },
  ): Promise<AutomationRun> {
    const id = input.id ?? `ar_${nanoid(10)}`;
    const created_at = new Date().toISOString();
    (await this.sql.exec(`INSERT INTO automation_runs (
           id, workspace_id, automation_id, trigger, outcome, window_from, window_to,
           items_seen, items_ingested, document_ids, candidate_count, summary, error, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, workspace_id, input.automation_id, input.trigger, input.outcome, input.window_from ?? null, input.window_to ?? null, input.items_seen ?? 0, input.items_ingested ?? 0, JSON.stringify(input.document_ids ?? []), input.candidate_count ?? 0, input.summary ?? null, input.error ?? null, created_at]));
    return {
      id,
      workspace_id,
      automation_id: input.automation_id,
      trigger: input.trigger,
      outcome: input.outcome,
      window_from: input.window_from ?? null,
      window_to: input.window_to ?? null,
      items_seen: input.items_seen ?? 0,
      items_ingested: input.items_ingested ?? 0,
      document_ids: input.document_ids ?? [],
      candidate_count: input.candidate_count ?? 0,
      summary: input.summary ?? null,
      error: input.error ?? null,
      created_at,
    };
  }

  async listAutomationRuns(this: Repo, workspace_id: string, automation_id: string, limit = 50): Promise<AutomationRun[]> {
    const rows = (await this.sql.query<any>(`SELECT * FROM automation_runs WHERE workspace_id = ? AND automation_id = ? ORDER BY created_at DESC LIMIT ?`, [workspace_id, automation_id, limit])) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      workspace_id: r.workspace_id as string,
      automation_id: r.automation_id as string,
      trigger: r.trigger as 'scheduled' | 'manual_run',
      outcome: r.outcome as 'ok' | 'empty' | 'error',
      window_from: (r.window_from as string | null) ?? null,
      window_to: (r.window_to as string | null) ?? null,
      items_seen: (r.items_seen as number) ?? 0,
      items_ingested: (r.items_ingested as number) ?? 0,
      document_ids: r.document_ids ? (JSON.parse(r.document_ids as string) as string[]) : [],
      candidate_count: (r.candidate_count as number) ?? 0,
      summary: (r.summary as string | null) ?? null,
      error: (r.error as string | null) ?? null,
      created_at: r.created_at as string,
    }));
  }

  /**
   * Seed the three default automations (kind='shape') for a workspace, once.
   * Same idempotency contract as seedDefaultRules: only fires when the
   * workspace has zero shape automations, so a deleted default never comes
   * back.
   */
  async seedDefaultAutomations(this: Repo, workspace_id: string, owner_user_id: string | null): Promise<void> {
    const count = (
      (await this.sql.one<any>(`SELECT COUNT(*) AS n FROM automations WHERE workspace_id = ? AND kind = 'shape'`, [workspace_id])) as { n: number }
    ).n;
    if (count > 0) return;
    const defaults: Array<Omit<Parameters<Repo['upsertAutomation']>[1], 'id' | 'kind'>> = [
      {
        instructions: 'Do not index casual chatter in call transcripts and Slack communication',
        scopes: ['private', 'team'],
        phases: ['store'],
        action: 'shape',
        sort_order: 0,
      },
      {
        instructions: 'Hide PII from customer call transcripts',
        scopes: ['only_me', 'private', 'team'],
        phases: ['store', 'use'],
        action: 'shape',
        sort_order: 1,
      },
      {
        instructions: 'Do not share timelines for product releases',
        scopes: ['team'],
        phases: ['use'],
        action: 'shape',
        sort_order: 2,
      },
    ];
    for (const d of defaults) await this.upsertAutomation(workspace_id, { ...d, kind: 'shape', owner_user_id });
  }

  /**
   * Lazily copy every legacy `rules` row into `automations` (kind='shape'),
   * preserving ids so external references (e.g. `rule-test:<id>` source refs)
   * stay valid. Idempotent and safe to call repeatedly: only runs when the
   * workspace has zero shape automations AND at least one legacy rule — so a
   * workspace that migrated and then deleted every automation is never
   * resurrected. The `rules` table itself is left untouched (read-only from
   * here on); it is never dropped (no destructive migrations).
   */
  async migrateRulesToAutomations(this: Repo, workspace_id: string): Promise<void> {
    const shapeCount = (
      (await this.sql.one<any>(`SELECT COUNT(*) AS n FROM automations WHERE workspace_id = ? AND kind = 'shape'`, [workspace_id])) as { n: number }
    ).n;
    if (shapeCount > 0) return;
    const legacy = await this.listRules(workspace_id);
    if (legacy.length === 0) return;
    for (const r of legacy) {
      await this.upsertAutomation(workspace_id, {
        id: r.id,
        kind: 'shape',
        instructions: r.instructions,
        scopes: r.scopes,
        phases: r.phases,
        action: r.action,
        target: r.target,
        enabled: r.enabled,
        owner_user_id: r.owner_user_id,
        sort_order: r.sort_order,
        created_at: r.created_at,
      });
    }
  }

  /**
   * Latest version number for a source_ref, and whether any candidate of an
   * EARLIER version of the same ref was approved. Powers the triage
   * stale-duplicate check ("looks like the April version — its content is
   * already in the graph via v2").
   */
  async latestDocumentVersion(this: Repo, workspace_id: string, source_ref: string): Promise<number> {
    const r = (await this.sql.one<any>(`SELECT MAX(version) AS v FROM documents WHERE workspace_id = ? AND source_ref = ?`, [workspace_id, source_ref])) as { v: number | null };
    return r.v ?? 0;
  }

  /** Append a corroboration row. Idempotent on (node, document, quote). */
  async addNodeEvidence(this: Repo,
    workspace_id: string,
    ev: { node_id: string; document_id?: string; source_ref?: string; source_kind?: string; quote?: string },
    subgraph_id = 'default',
  ): Promise<void> {
    const document_id = ev.document_id ?? '';
    const quote = ev.quote ?? '';
    let stored = quote;
    if (this.crypto.sealing) {
      // A sealed quote differs on every write, so the (node, document, quote)
      // primary key can't de-duplicate; compare the opened quotes instead.
      // Bound to node + document: the row has no id of its own.
      const ref = evidenceSealRef(ev.node_id, document_id);
      const existing = (await this.sql.query<any>(`SELECT quote FROM node_evidence WHERE workspace_id = ? AND node_id = ? AND document_id = ?`, [workspace_id, ev.node_id, document_id])) as Array<{ quote: string | null }>;
      for (const e of existing) {
        if ((await openText(this, workspace_id, 'node_evidence.quote', ref, e.quote)) === quote) return;
      }
      stored = await sealText(this, workspace_id, 'node_evidence.quote', ref, quote);
    }
    (await this.sql.exec(`INSERT OR IGNORE INTO node_evidence (workspace_id, node_id, document_id, source_ref, source_kind, quote, captured_at, subgraph_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [workspace_id, ev.node_id, document_id, ev.source_ref ?? null, ev.source_kind ?? null, stored, new Date().toISOString(), subgraph_id]));
  }

  /** node_id → { sources, latest } for the workspace (prompt annotation). */
  async evidenceCounts(this: Repo, workspace_id: string, subgraph_id = 'default'): Promise<Map<string, { sources: number; latest: string }>> {
    const rows = (await this.sql.query<any>(`SELECT node_id, COUNT(DISTINCT COALESCE(NULLIF(document_id, ''), source_ref)) AS sources, MAX(captured_at) AS latest
         FROM node_evidence WHERE workspace_id = ? AND subgraph_id = ? GROUP BY node_id`, [workspace_id, subgraph_id])) as Array<{ node_id: string; sources: number; latest: string }>;
    return new Map(rows.map((r) => [r.node_id, { sources: r.sources, latest: r.latest }]));
  }

  async listNodeEvidence(this: Repo,
    workspace_id: string,
    node_id: string,
  ): Promise<Array<{ document_id: string; source_ref: string | null; source_kind: string | null; quote: string; captured_at: string }>> {
    const rows = (await this.sql.query<any>(`SELECT document_id, source_ref, source_kind, quote, captured_at FROM node_evidence WHERE workspace_id = ? AND node_id = ? ORDER BY captured_at ASC`, [workspace_id, node_id])) as Array<{ document_id: string; source_ref: string | null; source_kind: string | null; quote: string; captured_at: string }>;
    return openRows(rows, async (r) => { r.quote = await openText(this, workspace_id, 'node_evidence.quote', evidenceSealRef(node_id, r.document_id), r.quote); });
  }

  // ---------- cross-user context usage ----------

  /**
   * Record one context access. Single entry point for every path that reads
   * the workspace's context on a user's behalf (web query/context-pack/review
   * + the four MCP tools). Writes three places:
   *   1. context_usage_log   — actor identity + request shape + verbatim text
   *      (as of 2026-08; see table comment in db/schema.ts)
   *   2. context_request_texts — the anonymized copy of the same text, kept
   *      actor-free for the usage-analysis synthesis
   *   3. customer_audit_log  — `context_accessed` (shape payload) for the
   *      admin export / SIEM stream
   */
  async recordContextAccess(this: Repo, workspace_id: string, entry: ContextAccessEntry): Promise<void> {
    const actor_email = entry.actor_user_id
      ? ((await this.sql.one<any>(`SELECT email FROM users WHERE id = ?`, [entry.actor_user_id])) as { email: string } | undefined)?.email
      : undefined;
    // Owner flag for the anonymized store (self vs team narrative split).
    // Case-insensitive: owner_email keeps the casing from workspace creation.
    const owner_email = (await this.getWorkspace(workspace_id))?.owner_email;
    const by_owner =
      actor_email && owner_email && actor_email.toLowerCase() === owner_email.toLowerCase()
        ? 1
        : 0;
    const subgraph_id = entry.subgraph_id ?? 'default';
    (await this.sql.exec(`INSERT INTO context_usage_log
         (workspace_id, actor_user_id, actor_email, channel, tool, scope, deliverable_kind,
          has_answer, cited, node_count, latency_ms, request_text, detail, created_at, subgraph_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`, [workspace_id, entry.actor_user_id ?? null, actor_email ?? null, entry.channel, entry.tool, entry.scope ?? null, entry.deliverable_kind ?? null, entry.has_answer === undefined ? null : entry.has_answer ? 1 : 0, entry.cited ?? null, entry.node_count ?? null, entry.latency_ms ?? null, await sealText(this, workspace_id, 'context_usage_log.request_text', REQUEST_TEXT_REF, entry.request_text ?? null), entry.detail ?? null, subgraph_id]));
    if (entry.request_text) {
      (await this.sql.exec(`INSERT INTO context_request_texts
           (workspace_id, tool, scope, deliverable_kind, request_text, has_answer, cited_node_ids, by_owner, created_at, subgraph_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`, [workspace_id, entry.tool, entry.scope ?? null, entry.deliverable_kind ?? null, await sealText(this, workspace_id, 'context_request_texts.request_text', REQUEST_TEXT_REF, entry.request_text), entry.has_answer === undefined ? null : entry.has_answer ? 1 : 0, entry.cited_node_ids ? JSON.stringify(entry.cited_node_ids) : null, by_owner, subgraph_id]));
    }
    await this.logCustomerAudit(workspace_id, {
      event: 'context_accessed',
      actor_user_id: entry.actor_user_id,
      actor_email,
      source_ip: entry.source_ip,
      user_agent: entry.user_agent,
      resource_type: 'context',
      payload: {
        channel: entry.channel,
        tool: entry.tool,
        scope: entry.scope,
        deliverable_kind: entry.deliverable_kind,
        has_answer: entry.has_answer,
        cited: entry.cited,
        latency_ms: entry.latency_ms,
        ...(await this.documentAccessPayload(workspace_id, entry)),
      },
    });
  }

  /**
   * Document-level access log (on-prem audit setting): with
   * AUDIT_DOCUMENT_ACCESS=1 the attributed `context_accessed` audit event also
   * names the nodes and source documents the read drew on. Off by default —
   * elsewhere cited node ids stay only in the anonymized store
   * (attribution-without-content privacy model).
   */
  async documentAccessPayload(this: Repo, workspace_id: string, entry: ContextAccessEntry): Promise<Record<string, unknown>> {
    if (process.env.AUDIT_DOCUMENT_ACCESS !== '1') return {};
    const ids = [...new Set([...(entry.accessed_node_ids ?? []), ...(entry.cited_node_ids ?? [])])].slice(0, 500);
    if (ids.length === 0) return { node_ids: [], document_ids: [] };
    const rows = (await this.sql.query<any>(
      `SELECT DISTINCT document_id FROM graph_nodes WHERE workspace_id = ? AND document_id IS NOT NULL AND id IN (${ids.map(() => '?').join(',')})`,
      [workspace_id, ...ids],
    )) as Array<{ document_id: string }>;
    return { node_ids: ids, document_ids: rows.map((r) => r.document_id) };
  }

  /** Latest attributed usage of one workspace's context (dashboard widget). */
  /**
   * Newest first. `before` pages by id (rows older than that id), so rows
   * logged while someone is paging never shift a row onto the next page.
   * `unanswered` narrows to replies the vault couldn't answer.
   */
  async listContextUsage(this: Repo,
    workspace_id: string,
    opts: { limit?: number; before?: number; unanswered?: boolean } = {},
  ): Promise<ContextUsageRow[]> {
    const limit = Math.min(opts.limit ?? 20, 500);
    const where = ['cu.workspace_id = ?'];
    const params: SqlValue[] = [workspace_id];
    if (opts.before) { where.push('cu.id < ?'); params.push(opts.before); }
    if (opts.unanswered) where.push('cu.has_answer = 0');
    const rows = (await this.sql.query<any>(`SELECT cu.*, s.name AS subgraph_name FROM context_usage_log cu
         LEFT JOIN subgraphs s ON s.workspace_id = cu.workspace_id AND s.id = cu.subgraph_id
         WHERE ${where.join(' AND ')} ORDER BY cu.id DESC LIMIT ?`, [...params, limit])) as ContextUsageRow[];
    return openRows(rows, async (r: any) => { r.request_text = await openText(this, workspace_id, 'context_usage_log.request_text', REQUEST_TEXT_REF, r.request_text); });
  }

  async countContextUsage(this: Repo, workspace_id: string): Promise<{ total: number; unanswered: number }> {
    const row = (await this.sql.one<any>(
      `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN has_answer = 0 THEN 1 ELSE 0 END), 0) AS unanswered
         FROM context_usage_log WHERE workspace_id = ?`,
      [workspace_id],
    )) as { total: number; unanswered: number };
    return { total: Number(row.total), unanswered: Number(row.unanswered) };
  }

  /**
   * One user's own requests across every workspace they can see — the
   * "contexts I've been using" view. Joined with the workspace so the caller
   * can show whose context it was (name + owner_email).
   */
  async listContextUsageByUser(this: Repo,
    user_id: string,
    opts: { limit?: number } = {},
  ): Promise<Array<ContextUsageRow & { workspace_name: string; owner_email: string }>> {
    const limit = Math.min(opts.limit ?? 20, 500);
    const rows = (await this.sql.query<any>(`SELECT cu.*, w.name AS workspace_name, w.owner_email, s.name AS subgraph_name
         FROM context_usage_log cu JOIN workspaces w ON w.id = cu.workspace_id
         LEFT JOIN subgraphs s ON s.workspace_id = cu.workspace_id AND s.id = cu.subgraph_id
         WHERE cu.actor_user_id = ? ORDER BY cu.id DESC LIMIT ?`, [user_id, limit])) as Array<ContextUsageRow & { workspace_name: string; owner_email: string }>;
    return openRows(rows, async (r: any) => { r.request_text = await openText(this, r.workspace_id, 'context_usage_log.request_text', REQUEST_TEXT_REF, r.request_text); });
  }

  /**
   * Anonymized verbatim questions — input to the usage-analysis synthesis.
   * by_owner (1 owner / 0 or NULL team) is the only identity-adjacent bit;
   * it exists solely for the self-vs-team narrative split.
   */
  async listContextRequestTexts(this: Repo,
    workspace_id: string,
    opts: { limit?: number } = {},
  ): Promise<Array<{
    tool: string;
    scope: string | null;
    deliverable_kind: string | null;
    request_text: string;
    has_answer: number | null;
    cited_node_ids: string | null;
    by_owner: number | null;
    created_at: string;
  }>> {
    const limit = Math.min(opts.limit ?? 50, 500);
    const rows = (await this.sql.query<any>(`SELECT tool, scope, deliverable_kind, request_text, has_answer, cited_node_ids, by_owner, created_at
         FROM context_request_texts WHERE workspace_id = ? ORDER BY id DESC LIMIT ?`, [workspace_id, limit])) as any[];
    return openRows(rows, async (r) => { r.request_text = await openText(this, workspace_id, 'context_request_texts.request_text', REQUEST_TEXT_REF, r.request_text); });
  }

  // ---------- wiki (spec-wiki.md / wiki-milestones.md M1) ----------

  async getWiki(this: Repo,
    workspace_id: string,
    subgraph_id = 'default',
  ): Promise<{ profile_id: string; plan_signature: string | null; status: string; content_watermark: string | null; created_at: string; updated_at: string } | undefined> {
    return (await this.sql.one<any>(`SELECT profile_id, plan_signature, status, content_watermark, created_at, updated_at
         FROM wikis WHERE workspace_id = ? AND subgraph_id = ?`, [workspace_id, subgraph_id])) as
      | { profile_id: string; plan_signature: string | null; status: string; content_watermark: string | null; created_at: string; updated_at: string }
      | undefined;
  }

  /**
   * The most recent graph change in a subgraph — the max of any active node's
   * updated_at and any document's last-ingest time. Compared against a wiki's
   * content_watermark to decide staleness (spec §11.2). Returns '' when empty.
   */
  async latestGraphChangeAt(this: Repo, workspace_id: string, subgraph_id = 'default'): Promise<string> {
    // Nodes are subgraph-local, and the wiki is a projection of the node canon,
    // so a subgraph's newest node change is its wiki's staleness driver.
    // Documents are workspace-SHARED (one row, one workspace-wide
    // last_ingested_at that bumps on any subgraph's extraction), so they cannot
    // be attributed to a subgraph — folding them in here would make a change in
    // one subfolder read as staleness in every other. A doc re-ingest that
    // actually changes this subgraph's canon shows up as a node update anyway.
    const node = (await this.sql.one<any>(`SELECT MAX(updated_at) AS t FROM graph_nodes WHERE workspace_id = ? AND subgraph_id = ?`, [workspace_id, subgraph_id])) as { t: string | null };
    return node.t ?? '';
  }

  /** Distinct subgraphs the given nodes belong to — used to scope wiki
   *  staleness to the subfolder(s) a node-creating batch actually touched. */
  async subgraphIdsForNodes(this: Repo, workspace_id: string, node_ids: string[]): Promise<string[]> {
    if (node_ids.length === 0) return [];
    const placeholders = node_ids.map(() => '?').join(',');
    const rows = (await this.sql.query<any>(`SELECT DISTINCT subgraph_id FROM graph_nodes WHERE workspace_id = ? AND id IN (${placeholders})`, [workspace_id, ...node_ids])) as Array<{ subgraph_id: string }>;
    return rows.map((r) => r.subgraph_id);
  }

  /** Stamp the wiki's content watermark and mark it built (clears 'stale'). */
  async setWikiWatermark(this: Repo, workspace_id: string, subgraph_id: string, watermark: string): Promise<void> {
    (await this.sql.exec(`UPDATE wikis SET content_watermark = ?, status = 'built', updated_at = ?
         WHERE workspace_id = ? AND subgraph_id = ?`, [watermark, new Date().toISOString(), workspace_id, subgraph_id]));
  }

  /** Mark built wikis stale (cheap event-driven signal fired from the
   *  node-creating choke point). No-op on wikis already stale. Pass
   *  `subgraph_id` to flag only that subfolder's wiki — a node added to one
   *  subfolder must not read as staleness in the others; omit it only for a
   *  genuine workspace-wide invalidation. */
  async markWikisStale(this: Repo, workspace_id: string, subgraph_id?: string): Promise<void> {
    if (subgraph_id !== undefined) {
      (await this.sql.exec(`UPDATE wikis SET status = 'stale', updated_at = ?
           WHERE workspace_id = ? AND subgraph_id = ? AND status <> 'stale'`, [new Date().toISOString(), workspace_id, subgraph_id]));
      return;
    }
    (await this.sql.exec(`UPDATE wikis SET status = 'stale', updated_at = ? WHERE workspace_id = ? AND status <> 'stale'`, [new Date().toISOString(), workspace_id]));
  }

  async upsertWiki(this: Repo,
    workspace_id: string,
    subgraph_id: string,
    opts: { profile_id: string; plan_signature?: string | null; status?: string },
  ): Promise<void> {
    const now = new Date().toISOString();
    (await this.sql.exec(`INSERT INTO wikis (workspace_id, subgraph_id, profile_id, plan_signature, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, subgraph_id) DO UPDATE SET
           profile_id = excluded.profile_id,
           plan_signature = excluded.plan_signature,
           status = excluded.status,
           updated_at = excluded.updated_at`, [workspace_id, subgraph_id, opts.profile_id, opts.plan_signature ?? null, opts.status ?? 'built', now, now]));
  }

  async insertWikiPage(this: Repo,
    workspace_id: string,
    subgraph_id: string,
    p: {
      id?: string;
      kind?: 'category' | 'page';
      parent_id?: string | null;
      slug: string;
      title: string;
      anchor?: unknown;
      sections?: unknown;
      source_doc_ids?: string[];
      sort_order?: number;
      visibility?: 'team' | 'private' | 'only_me';
      owner_user_id?: string | null;
    },
  ): Promise<{ id: string }> {
    const id = p.id ?? `wp_${nanoid(10)}`;
    const now = new Date().toISOString();
    (await this.sql.exec(`INSERT INTO wiki_pages
           (workspace_id, subgraph_id, id, kind, parent_id, slug, title, anchor, sections,
            source_doc_ids, sort_order, visibility, owner_user_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`, [workspace_id, subgraph_id, id, p.kind ?? 'page', p.parent_id ?? null, p.slug, p.title, p.anchor != null ? JSON.stringify(p.anchor) : null, p.sections != null ? JSON.stringify(p.sections) : null, p.source_doc_ids != null ? JSON.stringify(p.source_doc_ids) : null, p.sort_order ?? 0, p.visibility ?? 'team', p.owner_user_id ?? null, now, now]));
    return { id };
  }

  async rowToWikiPage(this: Repo, r: Record<string, unknown>): Promise<WikiPage> {
    return {
      id: r.id as string,
      kind: r.kind as 'category' | 'page',
      parent_id: (r.parent_id as string | null) ?? null,
      slug: r.slug as string,
      title: r.title as string,
      anchor: r.anchor ? JSON.parse(r.anchor as string) : null,
      sections: r.sections ? JSON.parse(r.sections as string) : null,
      source_doc_ids: r.source_doc_ids ? (JSON.parse(r.source_doc_ids as string) as string[]) : [],
      sort_order: (r.sort_order as number) ?? 0,
      visibility: (r.visibility as WikiPage['visibility']) ?? 'team',
      owner_user_id: (r.owner_user_id as string | null) ?? null,
      status: r.status as 'active' | 'archived',
      created_at: r.created_at as string,
      updated_at: r.updated_at as string,
    };
  }

  async listWikiPages(this: Repo,
    workspace_id: string,
    subgraph_id = 'default',
    opts?: { includeArchived?: boolean },
  ): Promise<WikiPage[]> {
    const rows = (await this.sql.query<any>(`SELECT * FROM wiki_pages
         WHERE workspace_id = ? AND subgraph_id = ? ${opts?.includeArchived ? '' : "AND status = 'active'"}
         ORDER BY sort_order ASC, created_at ASC`, [workspace_id, subgraph_id])) as Array<Record<string, unknown>>;
    return await Promise.all(rows.map(async (r) => await this.rowToWikiPage(r)));
  }

  async getWikiPage(this: Repo, workspace_id: string, id: string): Promise<WikiPage | undefined> {
    const r = (await this.sql.one<any>(`SELECT * FROM wiki_pages WHERE workspace_id = ? AND id = ?`, [workspace_id, id])) as Record<string, unknown> | undefined;
    return r ? await this.rowToWikiPage(r) : undefined;
  }

  async updateWikiPage(this: Repo,
    workspace_id: string,
    id: string,
    patch: {
      title?: string;
      parent_id?: string | null;
      sort_order?: number;
      anchor?: unknown;
      sections?: unknown;
      source_doc_ids?: string[];
      slug?: string;
      visibility?: 'team' | 'private' | 'only_me';
      owner_user_id?: string;
    },
  ): Promise<void> {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    if (patch.title !== undefined) { sets.push('title = ?'); params.push(patch.title); }
    if (patch.slug !== undefined) { sets.push('slug = ?'); params.push(patch.slug); }
    if (patch.parent_id !== undefined) { sets.push('parent_id = ?'); params.push(patch.parent_id); }
    if (patch.sort_order !== undefined) { sets.push('sort_order = ?'); params.push(patch.sort_order); }
    if (patch.anchor !== undefined) { sets.push('anchor = ?'); params.push(patch.anchor != null ? JSON.stringify(patch.anchor) : null); }
    if (patch.sections !== undefined) { sets.push('sections = ?'); params.push(patch.sections != null ? JSON.stringify(patch.sections) : null); }
    if (patch.source_doc_ids !== undefined) { sets.push('source_doc_ids = ?'); params.push(JSON.stringify(patch.source_doc_ids)); }
    if (patch.visibility !== undefined) { sets.push('visibility = ?'); params.push(patch.visibility); }
    if (patch.owner_user_id !== undefined) { sets.push('owner_user_id = ?'); params.push(patch.owner_user_id); }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    params.push(new Date().toISOString(), workspace_id, id);
    (await this.sql.exec(`UPDATE wiki_pages SET ${sets.join(', ')} WHERE workspace_id = ? AND id = ?`, [...params]));
  }

  /** Archive a page and its whole subtree (never a hard delete — mirrors the
   *  archive-not-delete discipline used for subgraphs and nodes). */
  async archiveWikiPageSubtree(this: Repo, workspace_id: string, subgraph_id: string, id: string): Promise<number> {
    const pages = await this.listWikiPages(workspace_id, subgraph_id);
    const byParent = new Map<string | null, WikiPage[]>();
    for (const p of pages) {
      const k = p.parent_id;
      if (!byParent.has(k)) byParent.set(k, []);
      byParent.get(k)!.push(p);
    }
    const doomed: string[] = [];
    const walk = (pid: string) => {
      doomed.push(pid);
      for (const child of byParent.get(pid) ?? []) walk(child.id);
    };
    walk(id);
    const now = new Date().toISOString();
    await this.sql.tx(async (t) => {
      for (const pid of doomed) {
        await t.exec(`UPDATE wiki_pages SET status = 'archived', updated_at = ? WHERE workspace_id = ? AND id = ?`, [now, workspace_id, pid]);
      }
    });
    return doomed.length;
  }

  /** Replace the whole page tree for a (workspace, subgraph): archive existing
   *  active pages, then insert the supplied tree. Used by plan (re)build. */
  async replaceWikiPages(this: Repo,
    workspace_id: string,
    subgraph_id: string,
    pages: Array<Parameters<Repo['insertWikiPage']>[2]>,
  ): Promise<number> {
    const now = new Date().toISOString();
    let n = 0;
    await this.sql.tx(async () => {
      (await this.sql.exec(`UPDATE wiki_pages SET status = 'archived', updated_at = ? WHERE workspace_id = ? AND subgraph_id = ? AND status = 'active'`, [now, workspace_id, subgraph_id]));
      for (const p of pages) { await this.insertWikiPage(workspace_id, subgraph_id, p); n++; }
    });
    return n;
  }

  async insertWikiBlock(this: Repo,
    workspace_id: string,
    page_id: string,
    b: {
      id?: string;
      sort_order: number;
      type: string;
      content: unknown;
      cited_node_ids?: string[];
      provenance?: string;
      review_state?: string;
    },
  ): Promise<{ id: string }> {
    const id = b.id ?? `wb_${nanoid(10)}`;
    const now = new Date().toISOString();
    (await this.sql.exec(`INSERT INTO wiki_blocks
           (workspace_id, page_id, id, sort_order, type, content, cited_node_ids, provenance, review_state, edited_by_user, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`, [workspace_id, page_id, id, b.sort_order, b.type, await sealJson(this, workspace_id, 'wiki_blocks.content', id, JSON.stringify(b.content)), b.cited_node_ids != null ? JSON.stringify(b.cited_node_ids) : null, b.provenance ?? 'in_document', b.review_state ?? 'accepted', now, now]));
    return { id };
  }

  /** Replace a page's filled blocks (fill is idempotent per page). Does NOT
   *  touch blocks a human edited (edited_by_user=1) or explicitly REJECTED
   *  (review_state='rejected') — the first is protected from regeneration
   *  (spec §11.4), the second is remembered so a refill doesn't re-propose it
   *  (spec §7). Everything else is replaced. */
  async replaceWikiBlocks(this: Repo,
    workspace_id: string,
    page_id: string,
    blocks: Array<Parameters<Repo['insertWikiBlock']>[2]>,
  ): Promise<number> {
    let n = 0;
    await this.sql.tx(async () => {
      (await this.sql.exec(`DELETE FROM wiki_blocks WHERE workspace_id = ? AND page_id = ?
             AND edited_by_user = 0 AND review_state <> 'rejected'`, [workspace_id, page_id]));
      for (const b of blocks) { await this.insertWikiBlock(workspace_id, page_id, b); n++; }
    });
    return n;
  }

  /** Reconcile a page's EDITABLE body from the unified wiki editor (single
   *  continuous document → ordered block list). Preserves each kept block's
   *  citations / provenance / review by matching on id; new blocks (no id) are
   *  inserted as user-authored; blocks that vanished from the document are
   *  removed — but an INFERRED one is remembered as 'rejected' (spec §7) rather
   *  than hard-deleted so a later refill does not re-propose it. Blocks still
   *  PENDING review are left untouched: they live in the review strip, not the
   *  editable document. Everything runs in one transaction. */
  async replaceWikiPageBody(this: Repo,
    workspace_id: string,
    page_id: string,
    blocks: Array<{ id?: string; type: string; content: unknown }>,
  ): Promise<number> {
    await this.sql.tx(async () => {
      const existing = await this.listWikiBlocks(workspace_id, page_id);
      // Only accepted/user blocks (i.e. what the editor showed) participate.
      const editable = existing.filter((b) => b.review_state !== 'pending');
      const editableIds = new Set(editable.map((e) => e.id));
      const allIds = new Set(existing.map((e) => e.id));
      const incomingIds = new Set(blocks.map((b) => b.id).filter(Boolean) as string[]);
      const now = new Date().toISOString();

      for (const [i, b] of blocks.entries()) {
        if (b.id && editableIds.has(b.id)) {
          (await this.sql.exec(`UPDATE wiki_blocks SET type = ?, content = ?, sort_order = ?, edited_by_user = 1, updated_at = ?
               WHERE workspace_id = ? AND id = ?`, [b.type, await sealJson(this, workspace_id, 'wiki_blocks.content', b.id, JSON.stringify(b.content)), i, now, workspace_id, b.id]));
        } else {
          // New node → insert as a human-authored, refill-protected block. Honor
          // the editor's client-minted id (so a later save matches instead of
          // duplicating) unless it collides with an existing block.
          const useId = b.id && !allIds.has(b.id) ? b.id : undefined;
          const { id } = await this.insertWikiBlock(workspace_id, page_id, {
            id: useId,
            sort_order: i,
            type: b.type,
            content: b.content,
            provenance: 'user',
            review_state: 'accepted',
          });
          allIds.add(id);
          (await this.sql.exec(`UPDATE wiki_blocks SET edited_by_user = 1 WHERE workspace_id = ? AND id = ?`, [workspace_id, id]));
        }
      }

      for (const e of editable) {
        if (incomingIds.has(e.id)) continue;
        if (e.provenance === 'inferred') await this.setWikiBlockReview(workspace_id, e.id, 'rejected');
        else await this.deleteWikiBlock(workspace_id, e.id);
      }
    });
    return blocks.length;
  }

  /** Update a block's content. `markEdited` stamps edited_by_user=1 so a later
   *  refill leaves it alone (spec §11.4 human-edits-win). */
  async updateWikiBlockContent(this: Repo,
    workspace_id: string,
    id: string,
    content: unknown,
    opts?: { markEdited?: boolean },
  ): Promise<boolean> {
    const r = (await this.sql.exec(`UPDATE wiki_blocks SET content = ?, ${opts?.markEdited ? 'edited_by_user = 1,' : ''} updated_at = ?
         WHERE workspace_id = ? AND id = ?`, [await sealJson(this, workspace_id, 'wiki_blocks.content', id, JSON.stringify(content)), new Date().toISOString(), workspace_id, id]));
    return r.changes > 0;
  }

  async deleteWikiBlock(this: Repo, workspace_id: string, id: string): Promise<boolean> {
    const r = (await this.sql.exec(`DELETE FROM wiki_blocks WHERE workspace_id = ? AND id = ?`, [workspace_id, id]));
    return r.changes > 0;
  }

  /** Next sort_order for a new block appended to a page. */
  async nextWikiBlockOrder(this: Repo, workspace_id: string, page_id: string): Promise<number> {
    const r = (await this.sql.one<any>(`SELECT MAX(sort_order) AS m FROM wiki_blocks WHERE workspace_id = ? AND page_id = ?`, [workspace_id, page_id])) as { m: number | null };
    return (r.m ?? -1) + 1;
  }

  /** Visibility of specific nodes (id → 'team'|'private'|'only_me'). Backs the
   *  wiki page no-widening clamp (spec §9b). */
  async getNodeVisibilities(this: Repo, workspace_id: string, ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (ids.length === 0) return out;
    const q = `SELECT id, visibility FROM graph_nodes WHERE workspace_id = ? AND id IN (${ids.map(() => '?').join(',')})`;
    const rows = (await this.sql.query<any>(q, [workspace_id, ...ids])) as Array<{ id: string; visibility: string }>;
    for (const r of rows) out.set(r.id, r.visibility ?? 'team');
    return out;
  }

  /** Set a block's review_state (accept / reject an inferred or proposed block). */
  async setWikiBlockReview(this: Repo, workspace_id: string, id: string, review_state: 'accepted' | 'rejected' | 'pending'): Promise<boolean> {
    const r = (await this.sql.exec(`UPDATE wiki_blocks SET review_state = ?, updated_at = ? WHERE workspace_id = ? AND id = ?`, [review_state, new Date().toISOString(), workspace_id, id]));
    return r.changes > 0;
  }

  async getWikiBlock(this: Repo, workspace_id: string, id: string): Promise<WikiBlock | undefined> {
    const r = (await this.sql.one<any>(`SELECT * FROM wiki_blocks WHERE workspace_id = ? AND id = ?`, [workspace_id, id])) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id: r.id as string,
      page_id: r.page_id as string,
      sort_order: r.sort_order as number,
      type: r.type as string,
      content: JSON.parse(await openJson(this, workspace_id, 'wiki_blocks.content', id, r.content as string)),
      cited_node_ids: r.cited_node_ids ? (JSON.parse(r.cited_node_ids as string) as string[]) : [],
      provenance: r.provenance as string,
      review_state: r.review_state as string,
      edited_by_user: !!(r.edited_by_user as number),
      created_at: r.created_at as string,
      updated_at: r.updated_at as string,
    };
  }

  async listWikiBlocks(this: Repo, workspace_id: string, page_id: string): Promise<WikiBlock[]> {
    const rows = (await this.sql.query<any>(`SELECT id, page_id, sort_order, type, content, cited_node_ids, provenance, review_state, edited_by_user, created_at, updated_at
         FROM wiki_blocks WHERE workspace_id = ? AND page_id = ? ORDER BY sort_order ASC`, [workspace_id, page_id])) as Array<Record<string, unknown>>;
    await openRows(rows, async (r) => { r.content = await openJson(this, workspace_id, 'wiki_blocks.content', r.id as string, r.content as string); });
    return rows.map((r) => ({
      id: r.id as string,
      page_id: r.page_id as string,
      sort_order: r.sort_order as number,
      type: r.type as string,
      content: JSON.parse(r.content as string),
      cited_node_ids: r.cited_node_ids ? (JSON.parse(r.cited_node_ids as string) as string[]) : [],
      provenance: r.provenance as string,
      review_state: r.review_state as string,
      edited_by_user: !!(r.edited_by_user as number),
      created_at: r.created_at as string,
      updated_at: r.updated_at as string,
    }));
  }

  // ---------- Subscribe to Updates (spec-subscribe-to-updates.md / U1) ----------
  //
  // Subscriptions are USER-OWNED (not workspace-scoped): a person's watch may
  // span several folders they belong to. Membership on each target is re-checked
  // at RUN time (scheduler), not just at create time, so losing access to a
  // folder silently drops it from the next run.

  async createUpdateSubscription(this: Repo, opts: {
    owner_user_id: string;
    topic: string;
    topic_embedding?: Float32Array | null;
    targets: UpdateTarget[];
    cadence_ms: number;
    medium: UpdateMedium;
    kind?: UpdateKind;
    destination?: string | null;
    approval_mode?: UpdateApprovalMode;
    next_run_at: string;
  }): Promise<UpdateSubscription> {
    const id = `sub_${nanoid(12)}`;
    const now = new Date().toISOString();
    (await this.sql.exec(`INSERT INTO update_subscriptions
           (id, owner_user_id, topic, topic_embedding, targets, cadence_ms, medium, kind, destination,
            approval_mode, status, last_run_at, next_run_at, watermark, fail_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, NULL, 0, ?, ?)`, [id, opts.owner_user_id, opts.topic, opts.topic_embedding ? embeddingToBlob(opts.topic_embedding) : null, JSON.stringify(opts.targets), opts.cadence_ms, opts.medium, opts.kind ?? 'get', opts.destination ?? null, opts.approval_mode ?? 'autonomous', opts.next_run_at, now, now]));
    return (await this.getUpdateSubscription(id))!;
  }

  async getUpdateSubscription(this: Repo, id: string): Promise<UpdateSubscription | undefined> {
    const row = (await this.sql.one<any>(`SELECT * FROM update_subscriptions WHERE id = ?`, [id])) as UpdateSubscriptionRow | undefined;
    return row ? rowToUpdateSubscription(row) : undefined;
  }

  /** The owner's watches, newest first. `kind` keeps each agent to its own. */
  async listUpdateSubscriptions(this: Repo, owner_user_id: string, kind?: UpdateKind): Promise<UpdateSubscription[]> {
    return (
      (await this.sql.query<any>(`SELECT * FROM update_subscriptions
             WHERE owner_user_id = ?${kind ? ' AND kind = ?' : ''}
             ORDER BY created_at DESC`, [...(kind ? [owner_user_id, kind] : [owner_user_id])])) as UpdateSubscriptionRow[]
    ).map(rowToUpdateSubscription);
  }

  /** Active subscriptions whose next_run_at is due at `now`. */
  async dueUpdateSubscriptions(this: Repo, now: Date): Promise<UpdateSubscription[]> {
    return (
      (await this.sql.query<any>(`SELECT * FROM update_subscriptions
             WHERE status = 'active' AND next_run_at <= ?
             ORDER BY next_run_at ASC`, [now.toISOString()])) as UpdateSubscriptionRow[]
    ).map(rowToUpdateSubscription);
  }

  /** Patch any owner-editable field. Only fields present in `patch` change. */
  async updateUpdateSubscription(this: Repo,
    id: string,
    patch: {
      topic?: string;
      topic_embedding?: Float32Array | null;
      targets?: UpdateTarget[];
      cadence_ms?: number;
      medium?: UpdateMedium;
      destination?: string | null;
      approval_mode?: UpdateApprovalMode;
      next_run_at?: string;
      watermark?: string | null;
      status?: UpdateSubscriptionStatus;
    },
  ): Promise<UpdateSubscription | undefined> {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    const set = (col: string, val: SqlValue) => {
      sets.push(`${col} = ?`);
      params.push(val);
    };
    if (patch.topic !== undefined) set('topic', patch.topic);
    if (patch.topic_embedding !== undefined)
      set('topic_embedding', patch.topic_embedding ? embeddingToBlob(patch.topic_embedding) : null);
    if (patch.targets !== undefined) set('targets', JSON.stringify(patch.targets));
    if (patch.cadence_ms !== undefined) set('cadence_ms', patch.cadence_ms);
    if (patch.medium !== undefined) set('medium', patch.medium);
    if (patch.destination !== undefined) set('destination', patch.destination);
    if (patch.approval_mode !== undefined) set('approval_mode', patch.approval_mode);
    if (patch.next_run_at !== undefined) set('next_run_at', patch.next_run_at);
    if (patch.watermark !== undefined) set('watermark', patch.watermark);
    if (patch.status !== undefined) set('status', patch.status);
    set('updated_at', new Date().toISOString());
    (await this.sql.exec(`UPDATE update_subscriptions SET ${sets.join(', ')} WHERE id = ?`, [...params, id]));
    return await this.getUpdateSubscription(id);
  }

  // ---------- Saved recipient lists (the 'give' agent's address book) ----------
  // Workspace + owner scoped: you only ever see, reuse, or delete your own lists
  // in the folder you saved them from.

  async saveRecipientList(this: Repo, opts: {
    workspace_id: string;
    owner_user_id: string;
    name: string;
    recipients: string[];
  }): Promise<RecipientList> {
    // Re-saving under an existing name overwrites it — the UI offers "save this
    // list" from a form, and a same-name save means "update my list", not "make
    // a second list I can't tell apart".
    const existing = (await this.sql.one<any>(`SELECT id FROM recipient_lists
           WHERE workspace_id = ? AND owner_user_id = ? AND name = ?`, [opts.workspace_id, opts.owner_user_id, opts.name])) as { id: string } | undefined;
    const now = new Date().toISOString();
    const id = existing?.id ?? `rcp_${nanoid(12)}`;
    if (existing) {
      (await this.sql.exec(`UPDATE recipient_lists SET recipients = ?, updated_at = ?
             WHERE workspace_id = ? AND id = ?`, [JSON.stringify(opts.recipients), now, opts.workspace_id, id]));
    } else {
      (await this.sql.exec(`INSERT INTO recipient_lists
             (workspace_id, id, owner_user_id, name, recipients, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`, [opts.workspace_id, id, opts.owner_user_id, opts.name, JSON.stringify(opts.recipients), now, now]));
    }
    return (await this.getRecipientList(opts.workspace_id, id))!;
  }

  async getRecipientList(this: Repo, workspace_id: string, id: string): Promise<RecipientList | undefined> {
    const row = (await this.sql.one<any>(`SELECT * FROM recipient_lists WHERE workspace_id = ? AND id = ?`, [workspace_id, id])) as RecipientListRow | undefined;
    return row ? rowToRecipientList(row) : undefined;
  }

  async listRecipientLists(this: Repo, workspace_id: string, owner_user_id: string): Promise<RecipientList[]> {
    return (
      (await this.sql.query<any>(`SELECT * FROM recipient_lists
             WHERE workspace_id = ? AND owner_user_id = ? ORDER BY name ASC`, [workspace_id, owner_user_id])) as RecipientListRow[]
    ).map(rowToRecipientList);
  }

  async deleteRecipientList(this: Repo, workspace_id: string, id: string): Promise<void> {
    (await this.sql.exec(`DELETE FROM recipient_lists WHERE workspace_id = ? AND id = ?`, [workspace_id, id]));
  }

  async deleteUpdateSubscription(this: Repo, id: string, opts?: { purgeDeliveries?: boolean }): Promise<void> {
    // Delivered updates are retained by default so past updates + engagement
    // aren't lost when a watch ends. Purge only on explicit request.
    if (opts?.purgeDeliveries) {
      (await this.sql.exec(`DELETE FROM update_deliveries WHERE subscription_id = ?`, [id]));
    }
    (await this.sql.exec(`DELETE FROM update_subscriptions WHERE id = ?`, [id]));
  }

  /**
   * Advance a subscription after a run. On success, callers pass the new
   * watermark + reset backoff; on failure they omit `watermark` (never drop a
   * window) and pass a backed-off `next_run_at` with the bumped fail_count.
   */
  async advanceUpdateSubscription(this: Repo,
    id: string,
    opts: {
      last_run_at: string;
      next_run_at: string;
      watermark?: string;
      fail_count: number;
    },
  ): Promise<void> {
    const sets = ['last_run_at = ?', 'next_run_at = ?', 'fail_count = ?', 'updated_at = ?'];
    const params: SqlValue[] = [opts.last_run_at, opts.next_run_at, opts.fail_count, new Date().toISOString()];
    if (opts.watermark !== undefined) {
      sets.push('watermark = ?');
      params.push(opts.watermark);
    }
    (await this.sql.exec(`UPDATE update_subscriptions SET ${sets.join(', ')} WHERE id = ?`, [...params, id]));
  }

  async recordUpdateDelivery(this: Repo, opts: {
    subscription_id: string;
    owner_user_id: string;
    window_from: string | null;
    window_to: string;
    title: string;
    body: string;
    cited_node_ids: string[];
    change_count: number;
    medium: UpdateMedium;
    status?: UpdateDeliveryStatus;
    delivered_at?: string | null;
    delivery_error?: string | null;
  }): Promise<UpdateDelivery> {
    const id = `upd_${nanoid(12)}`;
    const now = new Date().toISOString();
    (await this.sql.exec(`INSERT INTO update_deliveries
           (id, subscription_id, owner_user_id, window_from, window_to, title, body,
            cited_node_ids, change_count, medium, status, delivered_at, delivery_error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, opts.subscription_id, opts.owner_user_id, opts.window_from, opts.window_to, opts.title, opts.body, JSON.stringify(opts.cited_node_ids), opts.change_count, opts.medium, opts.status ?? 'sent', opts.delivered_at ?? null, opts.delivery_error ?? null, now]));
    return (await this.getUpdateDelivery(id))!;
  }

  /**
   * Move a delivery through its lifecycle. `sent` also stamps `delivered_at`
   * (the actual send time) when given; `discarded` records an owner rejection.
   */
  async setUpdateDeliveryStatus(this: Repo,
    id: string,
    status: UpdateDeliveryStatus,
    opts?: { delivered_at?: string | null },
  ): Promise<void> {
    if (opts?.delivered_at !== undefined) {
      (await this.sql.exec(`UPDATE update_deliveries SET status = ?, delivered_at = ? WHERE id = ?`, [status, opts.delivered_at, id]));
    } else {
      (await this.sql.exec(`UPDATE update_deliveries SET status = ? WHERE id = ?`, [status, id]));
    }
  }

  /** Count of the owner's deliveries awaiting their approval (nav badge). */
  async countPendingDeliveries(this: Repo, owner_user_id: string): Promise<number> {
    const row = (await this.sql.one<any>(`SELECT COUNT(*) AS n FROM update_deliveries WHERE owner_user_id = ? AND status = 'pending'`, [owner_user_id])) as { n: number };
    return row.n;
  }

  async getUpdateDelivery(this: Repo, id: string): Promise<UpdateDelivery | undefined> {
    const row = (await this.sql.one<any>(`SELECT * FROM update_deliveries WHERE id = ?`, [id])) as UpdateDeliveryRow | undefined;
    return row ? rowToUpdateDelivery(row) : undefined;
  }

  /** Deliveries for an owner (optionally one subscription), reverse-chron. */
  async listUpdateDeliveries(this: Repo, opts: {
    owner_user_id: string;
    subscription_id?: string;
    limit?: number;
  }): Promise<UpdateDelivery[]> {
    const limit = Math.min(opts.limit ?? 50, 200);
    const rows = opts.subscription_id
      ? ((await this.sql.query<any>(`SELECT * FROM update_deliveries WHERE owner_user_id = ? AND subscription_id = ?
               ORDER BY created_at DESC LIMIT ?`, [opts.owner_user_id, opts.subscription_id, limit])) as UpdateDeliveryRow[])
      : ((await this.sql.query<any>(`SELECT * FROM update_deliveries WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT ?`, [opts.owner_user_id, limit])) as UpdateDeliveryRow[]);
    return rows.map(rowToUpdateDelivery);
  }

  /** In-app open: increment view_count (and set opened_at on first open). */
  async markUpdateDeliveryViewed(this: Repo, id: string): Promise<void> {
    (await this.sql.exec(`UPDATE update_deliveries
           SET view_count = view_count + 1,
               opened_at = COALESCE(opened_at, ?)
         WHERE id = ?`, [new Date().toISOString(), id]));
  }

  async markUpdateDeliveryClicked(this: Repo, id: string): Promise<void> {
    (await this.sql.exec(`UPDATE update_deliveries SET click_count = click_count + 1 WHERE id = ?`, [id]));
  }

  /**
   * Email open (tracking pixel): stamp `opened_at` on first open. Distinct from
   * `view_count`, which counts in-app reads — an email open is not an app view.
   */
  async markUpdateDeliveryOpened(this: Repo, id: string): Promise<void> {
    (await this.sql.exec(`UPDATE update_deliveries SET opened_at = COALESCE(opened_at, ?) WHERE id = ?`, [new Date().toISOString(), id]));
  }

  // ---------- moved from outside db/ (all SQL in repo/) ----------

  async listCandidatesForDigest(this: Repo, ws: string): Promise<unknown[]> {
    const rows = (await this.sql.query<any>(`SELECT id, flag, proposed_node, source_ref, conflicts_with, created_at
       FROM candidates WHERE workspace_id = ? AND status = 'pending'
       ORDER BY CASE flag WHEN 'red' THEN 0 WHEN 'yellow' THEN 1 ELSE 2 END, created_at DESC`, [ws]));
    return openRows(rows, async (r) => { r.proposed_node = await openJson(this, ws, 'candidates.proposed_node', r.id, r.proposed_node); });
  }

  async listReviewsSince(this: Repo, ws: string, since: string): Promise<unknown[]> {
    return (await this.sql.query(`SELECT caller, kind, findings, created_at FROM reviews
       WHERE workspace_id = ? AND created_at >= ? ORDER BY created_at DESC`, [ws, since]));
  }

  async countApprovalsByCuratorSince(this: Repo, ws: string, since: string): Promise<unknown[]> {
    return (await this.sql.query(`SELECT actor, COUNT(*) as n FROM audit_log
       WHERE workspace_id = ? AND event = 'candidate.approved' AND created_at >= ?
       GROUP BY actor HAVING n >= 3 ORDER BY n DESC LIMIT 5`, [ws, since]));
  }

  async insertDay1AuditReport(this: Repo, id: string, ws: string, requested_by: string | null, deliverables_count: number, report: string, created_at: string): Promise<ExecResult> {
    return (await this.sql.exec(`INSERT INTO day1_audit_reports
       (id, workspace_id, requested_by, deliverables_count, report, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`, [id, ws, requested_by, deliverables_count, report, created_at]));
  }

  async getDay1AuditReport(this: Repo, ws: string, id: string): Promise<unknown> {
    return (await this.sql.one(`SELECT report FROM day1_audit_reports WHERE workspace_id = ? AND id = ?`, [ws, id]));
  }

  async listDay1AuditReports(this: Repo, ws: string): Promise<unknown[]> {
    return (await this.sql.query(`SELECT id, created_at, deliverables_count FROM day1_audit_reports
       WHERE workspace_id = ? ORDER BY created_at DESC`, [ws]));
  }

  async watchSlackChannel(this: Repo, ws: string, channel: string, auto_scan: number, created_at: string): Promise<ExecResult> {
    return (await this.sql.exec(`INSERT OR REPLACE INTO slack_channels (workspace_id, channel, watching, auto_scan, created_at) VALUES (?, ?, 1, ?, ?)`, [ws, channel, auto_scan, created_at]));
  }

  async unwatchSlackChannel(this: Repo, ws: string, channel: string): Promise<ExecResult> {
    return (await this.sql.exec(`UPDATE slack_channels SET watching = 0, auto_scan = 0 WHERE workspace_id = ? AND channel = ?`, [ws, channel]));
  }

  async getSlackChannelWatch(this: Repo, ws: string, channel: string): Promise<unknown> {
    return (await this.sql.one(`SELECT watching, auto_scan FROM slack_channels WHERE workspace_id = ? AND channel = ?`, [ws, channel]));
  }

  async deleteUpdateDelivery(this: Repo, id: string): Promise<ExecResult> {
    return (await this.sql.exec(`DELETE FROM update_deliveries WHERE id = ?`, [id]));
  }

}
