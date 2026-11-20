/**
 * The block-action (button click) pipeline, DECOUPLED from Slack — the
 * curation counterpart of `handlers.ts`. `createActionHandler` returns a
 * handler operating purely on an {@link ActionContext}; the Bolt adapter only
 * builds that context. Imports only from [shared] modules.
 *
 * Security model: a click is resolved against the CLICKER's own mapping
 * (own-workspace-only, like the `pending` verb that produced the buttons).
 * The clicker's MCP token can only reach their own workspace, so a candidate
 * id from any other workspace is a 404 upstream by construction.
 */
import type { ActionContext, Config, PomegranateClient, ResolveOutcome } from './types.js';
import { resolveCanon, resolveTeam } from './resolve.js';
import { resolveCandidateInBlocks } from './format.js';
import { SurfaceAgentClient } from './surface-client.js';
import { SurfaceError, UpstreamError } from './errors.js';
import { logEvent } from './log.js';

export interface ActionHandlerDeps {
  config: Config;
  client: PomegranateClient;
  /**
   * Relay mode: execute the click through the server's surface-action
   * endpoint (identity resolved server-side from the clicker's linked Slack
   * identity) instead of the legacy per-user token keyring.
   */
  surface?: SurfaceAgentClient;
  /** Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

export function createActionHandler(
  deps: ActionHandlerDeps,
): (ctx: ActionContext) => Promise<void> {
  const env = deps.env ?? process.env;

  /** Relay-mode resolution: server executes + authorizes; map to ResolveOutcome. */
  async function resolveViaSurface(ctx: ActionContext): Promise<ResolveOutcome> {
    const apiBaseUrl = resolveTeam(deps.config, ctx.teamId).pomegranate_api_url;
    const r = await deps.surface!.invokeAction(apiBaseUrl, {
      team_id: ctx.teamId,
      slack_user_id: ctx.actorUserId,
      tool: ctx.action === 'approve' ? 'approve_candidate' : 'reject_candidate',
      args: { id: ctx.candidateId },
    });
    if (r.ok) {
      return {
        ok: true,
        node_id: r.result.node_id as string | undefined,
        summary: r.result.summary as string | undefined,
      };
    }
    if (r.result?.error === 'already_resolved') {
      return { ok: false, reason: 'already_resolved', status: String(r.result.status ?? 'resolved') };
    }
    return { ok: false, reason: 'not_found' };
  }

  return async (ctx: ActionContext): Promise<void> => {
    const t0 = Date.now();
    let outcome = 'error';
    let errName: string | undefined;

    try {
      let result: ResolveOutcome;
      if (deps.surface) {
        result = await resolveViaSurface(ctx);
      } else {
        // Legacy: the clicker curates their OWN workspace — same rule as
        // `pending` — via their token from the env keyring.
        const canon = resolveCanon(deps.config, ctx.teamId, ctx.actorUserId, env);
        result =
          ctx.action === 'approve'
            ? await deps.client.approveCandidate(canon, ctx.candidateId)
            : await deps.client.rejectCandidate(canon, ctx.candidateId);
      }

      if (result.ok) {
        outcome = 'ok';
        const line =
          ctx.action === 'approve'
            ? `:white_check_mark: *Approved* by <@${ctx.actorUserId}>`
            : `:no_entry_sign: *Rejected* by <@${ctx.actorUserId}>`;
        // Best-effort: the resolution line is cosmetic; the approval already
        // happened upstream. A chat.update failure must not undo/confuse it.
        await ctx
          .updateMessageBlocks((blocks) =>
            resolveCandidateInBlocks(blocks, ctx.candidateId, line),
          )
          .catch(() => {});
      } else if (result.reason === 'already_resolved') {
        outcome = 'already_resolved';
        await ctx
          .updateMessageBlocks((blocks) =>
            resolveCandidateInBlocks(
              blocks,
              ctx.candidateId,
              `:information_source: Already ${result.status} (handled elsewhere)`,
            ),
          )
          .catch(() => {});
      } else {
        outcome = 'not_found';
        await ctx.reply(
          "That candidate doesn't exist anymore — say `pending` for a fresh list.",
        );
      }
    } catch (err) {
      if (err instanceof SurfaceError) {
        errName = err.name;
        outcome = err instanceof UpstreamError ? 'upstream_error' : 'mapped_error';
        await ctx.reply(err.userMessage).catch(() => {});
      } else {
        errName = (err as Error)?.name ?? 'Error';
        console.error('[slack-surface] unexpected action error:', err);
        await ctx.reply('Something went wrong — try again.').catch(() => {});
      }
    } finally {
      logEvent('info', 'candidate_action', {
        team_id: ctx.teamId,
        actor: ctx.actorUserId,
        action: ctx.action,
        candidate: ctx.candidateId,
        outcome,
        error: errName,
        latency_ms: Date.now() - t0,
      });
    }
  };
}
