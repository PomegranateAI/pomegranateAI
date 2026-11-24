/**
 * Automations scheduler unit tests (Stage 4). Mirrors the update-scheduler
 * discipline: no timer, no network, no real Hono app — inject a fixed clock
 * and a fake `dispatch` (standing in for app.request against
 * /apps/:app/preview|pull), then assert due-selection / backoff / empty-run
 * behaviour directly through runDueOnce()/runAutomation().
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../db/schema.js';
import { Repo } from '../db/repo.js';
import { createAutomationScheduler, ERROR_BACKOFF_CAP_MS, type AppsRouteDispatcher } from './scheduler.js';

let db: Database.Database;
let repo: Repo;
let wsId: string;
let ownerId: string;

const CLOCK = new Date('2026-07-08T12:00:00.000Z');
const CADENCE = 60 * 60 * 1000; // 1h

beforeEach(async () => {
  db = new Database(':memory:');
  migrate(db);
  repo = new Repo(db);
  const ws = await repo.createWorkspace({ name: 'W', owner_email: 'owner@test' });
  wsId = ws.id;
  ownerId = (await repo.findUserByEmail('owner@test'))!.id;
});

async function makeAutomation(overrides: Partial<Parameters<Repo['upsertAutomation']>[1]> = {}) {
  return await repo.upsertAutomation(wsId, {
    kind: 'apps_pull',
    connector: 'gmail',
    criteria: { query: 'weekly digest' },
    cadence_ms: CADENCE,
    next_run_at: CLOCK.toISOString(),
    owner_user_id: ownerId,
    ...overrides,
  });
}

describe('automations scheduler', () => {
  it('runDueOnce only picks up due apps_pull automations, never shape or track_directory rows', async () => {
    const due = await makeAutomation();
    // shape: no cadence at all — structurally never due.
    await repo.upsertAutomation(wsId, { kind: 'shape', instructions: 'Hide PII' });
    // track_directory: cadence_ms always NULL — structurally never due (see repo.dueAutomations).
    await repo.upsertAutomation(wsId, { kind: 'track_directory', device_id: 'dev1', local_path: '/tmp' });
    // apps_pull but not due yet (next_run_at in the future).
    await makeAutomation({ next_run_at: new Date(CLOCK.getTime() + CADENCE).toISOString() });

    const dueRows = await repo.dueAutomations(CLOCK);
    expect(dueRows.map((a) => a.id)).toEqual([due.id]);
  });

  it('a successful run ingests every previewed item, advances the schedule, and resets fail_count', async () => {
    const automation = await makeAutomation({ fail_count: 2 });
    const dispatch: AppsRouteDispatcher = async (_auth, _method, path) => {
      if (path.endsWith('/preview')) {
        return { status: 200, json: { app: 'gmail', unit: 'email', items: [{ id: 'e1' }, { id: 'e2' }] } };
      }
      return {
        status: 200,
        json: {
          results: [
            { id: 'e1', document_id: 'doc_1', candidates: 2 },
            { id: 'e2', document_id: 'doc_2', candidates: 1 },
          ],
          total_candidates: 3,
        },
      };
    };
    const scheduler = createAutomationScheduler({ repo, dispatch, now: () => CLOCK });

    const [report] = await scheduler.runDueOnce();
    expect(report.outcome).toBe('ok');
    expect(report.items_seen).toBe(2);
    expect(report.items_ingested).toBe(2);

    const after = (await repo.getAutomation(wsId, automation.id))!;
    expect(after.fail_count).toBe(0);
    expect(after.last_run_at).toBe(CLOCK.toISOString());
    expect(after.next_run_at).toBe(new Date(CLOCK.getTime() + CADENCE).toISOString());

    const runs = await repo.listAutomationRuns(wsId, automation.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.trigger).toBe('scheduled');
    expect(runs[0]!.outcome).toBe('ok');
    expect(runs[0]!.document_ids).toEqual(['doc_1', 'doc_2']);
    expect(runs[0]!.candidate_count).toBe(3);
  });

  it('an empty preview advances the schedule (not an error) and records an empty run', async () => {
    const automation = await makeAutomation();
    const dispatch: AppsRouteDispatcher = async () => ({ status: 200, json: { items: [] } });
    const scheduler = createAutomationScheduler({ repo, dispatch, now: () => CLOCK });

    const [report] = await scheduler.runDueOnce();
    expect(report.outcome).toBe('empty');

    const after = (await repo.getAutomation(wsId, automation.id))!;
    expect(after.next_run_at).toBe(new Date(CLOCK.getTime() + CADENCE).toISOString());
    expect((await repo.listAutomationRuns(wsId, automation.id))[0]!.outcome).toBe('empty');
  });

  it('a failed preview backs off WITHOUT skipping ahead past the retry window, and never silently drops the due run', async () => {
    const automation = await makeAutomation({ fail_count: 1 });
    const dispatch: AppsRouteDispatcher = async () => ({ status: 502, json: { error: 'gmail_unavailable' } });
    const scheduler = createAutomationScheduler({ repo, dispatch, now: () => CLOCK });

    const [report] = await scheduler.runDueOnce();
    expect(report.outcome).toBe('error');

    const after = (await repo.getAutomation(wsId, automation.id))!;
    expect(after.fail_count).toBe(2);
    // delayMs = min(cadence * 2^(failCount-1), CAP) = min(1h * 2^1, CAP) = 2h
    const expectedDelay = Math.min(CADENCE * 2 ** 1, ERROR_BACKOFF_CAP_MS);
    expect(after.next_run_at).toBe(new Date(CLOCK.getTime() + expectedDelay).toISOString());

    const runs = await repo.listAutomationRuns(wsId, automation.id);
    expect(runs[0]!.outcome).toBe('error');
    expect(runs[0]!.error).toContain('gmail_unavailable');
  });

  it('caps backoff at ERROR_BACKOFF_CAP_MS regardless of fail_count', async () => {
    const automation = await makeAutomation({ fail_count: 20 });
    const dispatch: AppsRouteDispatcher = async () => ({ status: 500, json: { error: 'boom' } });
    const scheduler = createAutomationScheduler({ repo, dispatch, now: () => CLOCK });

    await scheduler.runDueOnce();
    const after = (await repo.getAutomation(wsId, automation.id))!;
    expect(after.next_run_at).toBe(new Date(CLOCK.getTime() + ERROR_BACKOFF_CAP_MS).toISOString());
  });

  it('defensively refuses to execute a non-apps_pull row even if one were somehow due', async () => {
    const shapeLike = await repo.upsertAutomation(wsId, {
      kind: 'shape',
      instructions: 'Hide PII',
      cadence_ms: CADENCE,
      next_run_at: CLOCK.toISOString(),
    });
    const dispatch: AppsRouteDispatcher = async () => {
      throw new Error('dispatch should never be called for a non-apps_pull automation');
    };
    const scheduler = createAutomationScheduler({ repo, dispatch, now: () => CLOCK });
    const report = await scheduler.runAutomation((await repo.getAutomation(wsId, shapeLike.id))!);
    expect(report.outcome).toBe('error');
    expect(report.error).toContain('unsupported kind');
  });

  it('a disabled owner gets no session: the run fails (account_disabled) and backs off, never dispatching', async () => {
    const automation = await makeAutomation();
    await repo.disableUser(ownerId);
    let calls = 0;
    const dispatch: AppsRouteDispatcher = async () => {
      calls++;
      return { status: 200, json: { items: [] } };
    };
    const scheduler = createAutomationScheduler({ repo, dispatch, now: () => CLOCK });
    const report = await scheduler.runAutomation((await repo.getAutomation(wsId, automation.id))!);
    expect(report.outcome).toBe('error');
    expect(report.error).toBe('account_disabled');
    expect(calls).toBe(0);
    const after = (await repo.getAutomation(wsId, automation.id))!;
    expect(after.fail_count).toBe(1);
    expect(Date.parse(after.next_run_at!)).toBeGreaterThan(CLOCK.getTime());
  });
});
