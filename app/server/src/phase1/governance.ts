// Directory governance for on-prem deployments.
//
//   viewer            a membership with read_only=1: may view and ask, may not
//                     add, change or delete — enforced in the web workspace
//                     gate (routes/core.ts) and on every MCP write tool.
//   sensitive         a directory flag: members need two-step sign-in to
//                     open it, and AI-assistant (MCP) connections are refused
//                     unless an admin sets assistants_allowed.
//   agents_read_only  a directory flag for folders that receive outside
//                     content: AI agents (MCP and the in-app instructions
//                     agent) may read but never write there.
//
// All three are additive columns (schema.ts), so existing directories keep
// their behaviour (every flag defaults to 0).

import { ToolError } from './mcp/errors.js';
import type { ToolCtx, ToolDef } from './mcp/registry.js';

export interface GovernanceRepo {
  getWorkspace(id: string): Promise<{ sensitive?: number | null; assistants_allowed?: number | null; agents_read_only?: number | null } | undefined>;
  getMembership(workspace_id: string, user_id: string): Promise<{ role: string; read_only?: number | null } | undefined>;
}

/**
 * Write requests a viewer may still make: asking, reviewing and drafting read
 * the directory without changing it. Paths are relative to /workspaces/:ws.
 */
const VIEWER_ALLOWED_POSTS: RegExp[] = [
  /^\/query$/,
  /^\/reviews$/,
  /^\/reviews\/[^/]+\/findings\/[^/]+\/wrong$/,
  /^\/align\/extract$/,
  /^\/work\/[^/]+$/,
  /^\/apps\/visibility\/[^/]+$/,
];

/** Whether a viewer (read-only member) may make this request. */
export function viewerMayRequest(method: string, path: string, ws: string): boolean {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return true;
  const prefix = `/workspaces/${ws}`;
  const rel = path.startsWith(prefix) ? path.slice(prefix.length) : path;
  if (m === 'POST' || m === 'DELETE') {
    if (m === 'DELETE' && /^\/apps\/visibility\/[^/]+$/.test(rel)) return true;
    if (m === 'POST') return VIEWER_ALLOWED_POSTS.some((r) => r.test(rel));
  }
  return false;
}

/**
 * MCP tools that write to the user's own settings, not the directory: allowed
 * for viewers and under agents_read_only.
 */
const PERSONAL_WRITE_TOOLS = new Set(['request_folder_access', 'set_default_folder', 'review_deliverable']);

/** A tool changes directory content (and is therefore refused for viewers / read-only agents). */
export function toolWritesDirectory(def: Pick<ToolDef, 'name' | 'annotations'>): boolean {
  if (PERSONAL_WRITE_TOOLS.has(def.name)) return false;
  return def.annotations.readOnlyHint !== true;
}

/**
 * Enforce the directory flags and the viewer role on one tool call, after the
 * effective directory (ctx.ws) is resolved. `ctx.via === 'in_app_agent'` marks
 * the in-process instructions agent (a web action, not an assistant
 * connection), which the sensitive-directory rule does not cover.
 */
export async function assertToolAllowed(repo: GovernanceRepo, def: Pick<ToolDef, 'name' | 'annotations'>, ctx: ToolCtx): Promise<void> {
  const ws = await repo.getWorkspace(ctx.ws);
  if (!ws) return; // unknown directory: the tool's own membership checks answer
  const viaAssistant = ctx.via !== 'in_app_agent';
  if (viaAssistant && ws.sensitive && !ws.assistants_allowed) {
    throw new ToolError('forbidden', 403, {
      detail: 'this directory is marked sensitive: AI-assistant connections are turned off by its admin',
    });
  }
  if (!toolWritesDirectory(def)) return;
  if (ws.agents_read_only) {
    throw new ToolError('forbidden', 403, { detail: 'AI agents are read-only in this directory' });
  }
  const mem = await repo.getMembership(ctx.ws, ctx.user_id);
  if (mem?.read_only) {
    throw new ToolError('forbidden', 403, { detail: 'you have view-only access to this directory' });
  }
}

/** Wrap a tool so every call passes assertToolAllowed first. */
export function withGovernance(repo: GovernanceRepo, def: ToolDef): ToolDef {
  return {
    ...def,
    async handler(args: any, ctx: ToolCtx) {
      await assertToolAllowed(repo, def, ctx);
      return def.handler(args, ctx);
    },
  };
}
