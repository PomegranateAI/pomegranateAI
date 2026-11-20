/**
 * [shared] Load + validate the surface<->Pomegranate mapping (DESIGN §4, ENG §4).
 *
 * Each Slack user maps to their OWN Pomegranate workspace (decision #1): that
 * user's canon, plus the env-var name of the MCP token scoped to it. Secrets
 * are never inlined — only the env var name lives in the file.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { Config } from './types.js';
import { MissingToken } from './errors.js';

const TeamSchema = z.object({
  slack_team_id: z.string().min(1),
  pomegranate_api_url: z.string().url(),
});

const UserSchema = z.object({
  slack_team_id: z.string().min(1),
  slack_user_id: z.string().min(1),
  slack_handle: z.string().optional(),
  pomegranate_user_id: z.string().min(1),
  pomegranate_workspace_id: z.string().min(1),
  mcp_token_env: z.string().min(1),
});

const ConfigSchema = z
  .object({
    teams: z.array(TeamSchema).min(1),
    // Per-user entries power LEGACY mode only. In relay mode identity lives
    // server-side (user_identities + default folders), so `users` may be
    // omitted entirely.
    users: z.array(UserSchema).default([]),
  })
  .superRefine((cfg, ctx) => {
    const teamIds = new Set(cfg.teams.map((t) => t.slack_team_id));
    const seen = new Set<string>();
    for (const u of cfg.users) {
      const key = `${u.slack_team_id}:${u.slack_user_id}`;
      if (seen.has(key)) {
        ctx.addIssue({ code: 'custom', message: `duplicate user mapping ${key}` });
      }
      seen.add(key);
      if (!teamIds.has(u.slack_team_id)) {
        ctx.addIssue({
          code: 'custom',
          message: `user ${u.slack_user_id} references unknown team ${u.slack_team_id}`,
        });
      }
    }
  });

/** Parse + validate a raw config object. Throws ZodError on a bad shape. */
export function parseConfig(raw: unknown): Config {
  return ConfigSchema.parse(raw);
}

/** Load + validate config from a JSON file path. */
export function loadConfigFromFile(path: string): Config {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return parseConfig(raw);
}

/**
 * Fail fast at boot if any referenced MCP token env var is missing. Call once
 * after loading so the bot never starts half-credentialed. LEGACY mode only.
 */
export function assertTokensPresent(
  cfg: Config,
  env: Record<string, string | undefined> = process.env,
): void {
  const missing = cfg.users
    .map((u) => u.mcp_token_env)
    .filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new MissingToken(
      "Pomegranate isn't fully configured yet.",
      `missing token env vars: ${[...new Set(missing)].join(', ')}`,
    );
  }
}

/** Relay mode's one credential: the shared surface secret. Fail fast at boot. */
export function assertSurfaceSecret(
  env: Record<string, string | undefined> = process.env,
): string {
  const secret = env.SURFACE_AGENT_SECRET;
  if (!secret) {
    throw new MissingToken(
      "Pomegranate isn't fully configured yet.",
      'SURFACE_AGENT_SECRET is unset (required in relay mode)',
    );
  }
  return secret;
}
