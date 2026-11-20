import { describe, it, expect } from 'vitest';
import { parseConfig, assertTokensPresent } from '../config.js';
import { MissingToken } from '../errors.js';

const good = {
  teams: [{ slack_team_id: 'T1', pomegranate_api_url: 'http://localhost:3000' }],
  users: [
    {
      slack_team_id: 'T1',
      slack_user_id: 'U_ALICE',
      slack_handle: 'alice',
      pomegranate_user_id: 'u_alice',
      pomegranate_workspace_id: 'ws_alice',
      mcp_token_env: 'TOK_ALICE',
    },
  ],
};

describe('parseConfig', () => {
  it('accepts a valid config', () => {
    const cfg = parseConfig(good);
    expect(cfg.users[0]!.pomegranate_workspace_id).toBe('ws_alice');
  });

  it('rejects a non-url api', () => {
    expect(() =>
      parseConfig({ ...good, teams: [{ slack_team_id: 'T1', pomegranate_api_url: 'not-a-url' }] }),
    ).toThrow();
  });

  it('rejects a user referencing an unknown team', () => {
    expect(() =>
      parseConfig({ ...good, users: [{ ...good.users[0], slack_team_id: 'T_NOPE' }] }),
    ).toThrow(/unknown team/);
  });

  it('rejects duplicate user mappings', () => {
    expect(() =>
      parseConfig({ ...good, users: [good.users[0], good.users[0]] }),
    ).toThrow(/duplicate/);
  });

  it('rejects a missing required field', () => {
    const bad = JSON.parse(JSON.stringify(good));
    delete bad.users[0].mcp_token_env;
    expect(() => parseConfig(bad)).toThrow();
  });
});

describe('assertTokensPresent', () => {
  it('passes when every token env is set', () => {
    expect(() => assertTokensPresent(parseConfig(good), { TOK_ALICE: 'secret' })).not.toThrow();
  });

  it('throws MissingToken when a token env is unset', () => {
    expect(() => assertTokensPresent(parseConfig(good), {})).toThrow(MissingToken);
  });
});
