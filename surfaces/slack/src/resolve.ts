/**
 * [shared] Resolve Slack identities to Pomegranate handles (DESIGN §3).
 *
 *  - resolveCanon: subject Slack user -> {workspace, token, api url}. The canon
 *    being queried. Throws if the subject isn't mapped or its token is missing.
 *  - resolveRequester: requester Slack user -> {pomegranateUserId|null}. The
 *    "who is asking" claim (on_behalf_of). Null-tolerant in v0 (reads public).
 */
import type { Config, CanonHandle, RequesterRef, TeamCfg, UserCfg } from './types.js';
import { TeamNotMapped, SubjectNotMapped, MissingToken } from './errors.js';

function findTeam(cfg: Config, teamId: string): TeamCfg | undefined {
  return cfg.teams.find((t) => t.slack_team_id === teamId);
}

function findUser(cfg: Config, teamId: string, slackUserId: string): UserCfg | undefined {
  return cfg.users.find(
    (u) => u.slack_team_id === teamId && u.slack_user_id === slackUserId,
  );
}

/** The connected team (for its API URL). Throws if the Slack workspace is unmapped. */
export function resolveTeam(cfg: Config, teamId: string): TeamCfg {
  const team = findTeam(cfg, teamId);
  if (!team) {
    throw new TeamNotMapped(
      "This Slack workspace isn't connected to Pomegranate yet.",
      `team ${teamId} not in config`,
    );
  }
  return team;
}

/**
 * Build the canon handle for a subject. The workspace id + token both come from
 * the subject's own user entry (decision #1), so different subjects resolve to
 * different graphs.
 */
export function resolveCanon(
  cfg: Config,
  teamId: string,
  subjectSlackUserId: string,
  env: Record<string, string | undefined> = process.env,
): CanonHandle {
  const team = resolveTeam(cfg, teamId);
  const user = findUser(cfg, teamId, subjectSlackUserId);
  if (!user) {
    throw new SubjectNotMapped(
      `I don't have <@${subjectSlackUserId}> mapped to a Pomegranate account.`,
      `subject ${subjectSlackUserId} not mapped in team ${teamId}`,
    );
  }
  const token = env[user.mcp_token_env];
  if (!token) {
    throw new MissingToken(
      "That person's Pomegranate vault isn't reachable right now.",
      `token env ${user.mcp_token_env} unset for subject ${subjectSlackUserId}`,
    );
  }
  return {
    workspaceId: user.pomegranate_workspace_id,
    subjectUserId: user.pomegranate_user_id,
    token,
    apiBaseUrl: team.pomegranate_api_url,
  };
}

/**
 * Resolve "who is asking". Never throws in v0 — an unmapped requester is
 * tolerated because reads are public. A future gated mode (req #3) would
 * require a non-null id before proceeding.
 */
export function resolveRequester(
  cfg: Config,
  teamId: string,
  requesterSlackUserId: string,
): RequesterRef {
  const user = findUser(cfg, teamId, requesterSlackUserId);
  return { pomegranateUserId: user?.pomegranate_user_id ?? null };
}
