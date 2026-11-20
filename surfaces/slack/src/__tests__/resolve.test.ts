import { describe, it, expect } from 'vitest';
import { parseConfig } from '../config.js';
import { resolveCanon, resolveRequester, resolveTeam } from '../resolve.js';
import { TeamNotMapped, SubjectNotMapped, MissingToken } from '../errors.js';

const cfg = parseConfig({
  teams: [{ slack_team_id: 'T1', pomegranate_api_url: 'http://localhost:3000' }],
  users: [
    {
      slack_team_id: 'T1',
      slack_user_id: 'U_ALICE',
      pomegranate_user_id: 'u_alice',
      pomegranate_workspace_id: 'ws_alice',
      mcp_token_env: 'TOK_ALICE',
    },
    {
      slack_team_id: 'T1',
      slack_user_id: 'U_SAM',
      pomegranate_user_id: 'u_sam',
      pomegranate_workspace_id: 'ws_sam',
      mcp_token_env: 'TOK_SAM',
    },
  ],
});

const env = { TOK_ALICE: 'alice-secret', TOK_SAM: 'sam-secret' };

describe('resolveTeam', () => {
  it('returns the team for a mapped id', () => {
    expect(resolveTeam(cfg, 'T1').pomegranate_api_url).toBe('http://localhost:3000');
  });
  it('throws TeamNotMapped for an unknown team', () => {
    expect(() => resolveTeam(cfg, 'T_NOPE')).toThrow(TeamNotMapped);
  });
});

describe('resolveCanon', () => {
  it('resolves different subjects to different workspaces + tokens', () => {
    const h = resolveCanon(cfg, 'T1', 'U_ALICE', env);
    const b = resolveCanon(cfg, 'T1', 'U_SAM', env);
    expect(h.workspaceId).toBe('ws_alice');
    expect(h.token).toBe('alice-secret');
    expect(h.subjectUserId).toBe('u_alice');
    expect(b.workspaceId).toBe('ws_sam');
    expect(b.token).toBe('sam-secret');
    expect(h.workspaceId).not.toBe(b.workspaceId);
  });

  it('throws SubjectNotMapped for an unmapped subject', () => {
    expect(() => resolveCanon(cfg, 'T1', 'U_GHOST', env)).toThrow(SubjectNotMapped);
  });

  it('throws MissingToken when the subject token env is unset', () => {
    expect(() => resolveCanon(cfg, 'T1', 'U_ALICE', {})).toThrow(MissingToken);
  });
});

describe('resolveRequester', () => {
  it('returns the pomegranate user id for a mapped requester', () => {
    expect(resolveRequester(cfg, 'T1', 'U_SAM').pomegranateUserId).toBe('u_sam');
  });
  it('returns null for an unmapped requester (tolerated in v0)', () => {
    expect(resolveRequester(cfg, 'T1', 'U_GHOST').pomegranateUserId).toBeNull();
  });
});
