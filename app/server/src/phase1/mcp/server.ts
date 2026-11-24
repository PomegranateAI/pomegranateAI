/**
 * MCP server — exposes the Pomegranate tools to any MCP-capable client.
 *
 * Two transports, one tool registry (registry.ts):
 *   - REST (HTTP/JSON): simple bearer-token endpoints mounted under
 *     /mcp/tools/* on the main API server — the Slack bot's transport, and
 *     curl-friendly for testing.
 *   - MCP streamable HTTP: a real MCP endpoint at POST /mcp/server (stateless,
 *     JSON responses) for native MCP clients — Claude Code (`claude mcp add
 *     --transport http … --header "Authorization: Bearer pmg_…"`), claude.ai
 *     connectors, Cursor, MCP Inspector.
 *
 * Both transports share the same tool implementations, the same per-call
 * audit log, and the same bearer tokens. A token is minted against one
 * workspace, but the ACCESS boundary is membership (surface unification):
 * the user's 'mcp' default folder, when set, becomes the effective workspace
 * for the connection, and every tool accepts a `folder` arg that can target
 * any workspace the token's USER is a member of (resolved + gated in
 * registry.ts/folder-resolve.ts). The endpoint lives under the /mcp/ path
 * prefix on purpose: Caddy proxies `/mcp/*` and would NOT match a bare
 * `/mcp` (it would fall through to the SPA) — keep new MCP routes under the
 * prefix.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { serveMediaContent } from '../data-agents/routes.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { withLlmContext } from '../../lib/llm-context.js';
import { AuthGuard } from '../api/rate-limit.js';
import { oauthScopeForTool, resolveOAuthAccess } from '../oauth/server.js';
import {
  createTools,
  toolJsonSchema,
  SERVER_INSTRUCTIONS,
  ToolError,
  type McpDeps,
  type ToolCtx,
  type ToolDef,
} from './registry.js';

export type { McpDeps } from './registry.js';

type McpVars = {
  workspace_id: string;
  home_workspace_id: string;
  user_id: string;
  mcp_token_id: string;
  // The credential behind this request: which table it lives in, and the
  // workspace it was minted against (not the retargeted one) — together they
  // address the row Repo.recordCredentialToolCall stamps.
  credential_kind: CredentialKind;
  credential_ws: string;
  // OAuth only: the granted scopes (filter the tool list) and the folders the
  // grant covers. Undefined for pmg_ tokens and connectors (unrestricted).
  oauth_scopes?: string[];
  allowed_workspace_ids?: string[];
};

/**
 * The workspace a resolved credential lands on: the user's 'mcp' default
 * folder when one is set (membership re-checked inside getUserDefault), else
 * the workspace the credential was minted against.
 */
async function effectiveResolution(
  deps: McpDeps,
  resolved: { workspace_id: string; user_id: string; id: string },
  // Which table `id` lives in. Needed to record a real tool call against the
  // credential (see Repo.recordCredentialToolCall) — the credential itself
  // always belongs to the HOME workspace, even when a `folder` arg or the
  // user's default retargets the call elsewhere.
  kind: CredentialKind = 'token',
): Promise<Resolution> {
  const dflt = await deps.repo.getUserDefault(resolved.user_id, 'mcp');
  return {
    workspace_id: dflt?.workspace_id ?? resolved.workspace_id,
    home_workspace_id: resolved.workspace_id,
    user_id: resolved.user_id,
    id: resolved.id,
    kind,
  };
}

// 'oauth' = an OAuth 2.1 access token (phase1/oauth). It has no row in
// mcp_tokens / claude_ai_connectors, so recordCredentialToolCall skips it.
type CredentialKind = 'token' | 'connector' | 'oauth';
type Resolution = {
  workspace_id: string;
  home_workspace_id: string;
  user_id: string;
  id: string;
  kind: CredentialKind;
  scopes?: string[];
  allowed_workspace_ids?: string[];
};

function requestMeta(c: any): { source_ip?: string; user_agent?: string; origin: string } {
  return {
    origin: process.env.PUBLIC_ORIGIN?.split(',')[0]?.trim() || new URL(c.req.url).origin,
    source_ip: c.req.header('x-forwarded-for')?.split(',')[0]?.trim(),
    user_agent: c.req.header('user-agent') ?? undefined,
  };
}

// The host app may carry its own Variables map (e.g. AppVars in api/server.ts);
// we don't constrain those — we just need our MCP-specific vars to be set/get
// safely inside this module, so we cast through a local typed reference.
/**
 * MCP_CAPABILITY_URLS (Azure contracts §C9): '0' turns off the secret-in-URL
 * connector paths. The default is '1'; a deployment can run
 * '0' and its MCP clients sign in with OAuth (decision I). Read per request so
 * tests can flip it. A8 moves this to config().flags.mcpCapabilityUrls.
 */
export function capabilityUrlsEnabled(): boolean {
  return process.env.MCP_CAPABILITY_URLS !== '0';
}

export function mountMcpHttp(app: Hono<any, any, any>, deps: McpDeps, guard: AuthGuard = new AuthGuard()): void {
  const router = app as unknown as Hono<{ Variables: McpVars }>;
  const tools = createTools(deps);

  function challenge(c: any) {
    const origin = process.env.PUBLIC_ORIGIN?.split(',')[0]?.trim() || new URL(c.req.url).origin;
    return c.json({ error: 'unauthorized' }, 401, {
      'WWW-Authenticate': `Bearer resource_metadata="${origin}/mcp/.well-known/oauth-protected-resource/server"`,
    });
  }

  /** Resolve the Bearer credential under the guard's per-IP failure budget. */
  async function resolveCredential(c: any): Promise<{ value?: Resolution; limited?: Response }> {
    const auth = c.req.header('Authorization');
    const token = auth?.startsWith('Bearer ') ? (auth.slice(7) as string) : undefined;
    return guard.check(c, token, () => (token ? lookupCredential(token, c) : undefined));
  }

  async function lookupCredential(token: string, c: any): Promise<Resolution | undefined> {
    const oauth = await resolveOAuthAccess(deps.repo, token, c.req.url);
    if (oauth) {
      await deps.repo.recordOAuthUse(oauth.id);
      const preferred = (await deps.repo.getUserDefault(oauth.user_id, 'mcp'))?.workspace_id;
      const workspace_id = preferred && oauth.workspace_ids.includes(preferred) ? preferred : oauth.workspace_ids[0]!;
      return { id: oauth.id, workspace_id, home_workspace_id: workspace_id, user_id: oauth.user_id, kind: 'oauth',
        scopes: oauth.scopes, allowed_workspace_ids: oauth.workspace_ids } satisfies Resolution;
    }
    if (!capabilityUrlsEnabled()) return undefined;
    const raw = await deps.repo.resolveMcpTokenWithId(token);
    if (!raw) return undefined;
    return await effectiveResolution(deps, raw, 'token');
  }

  // Auth: legacy pmg_ tokens and OAuth access tokens coexist.
  async function tokenGate(c: any, next: any) {
    const { value: resolved, limited } = await resolveCredential(c);
    if (limited) return limited;
    if (!resolved) return challenge(c);
    c.set('workspace_id', resolved.workspace_id);
    c.set('home_workspace_id', resolved.home_workspace_id);
    c.set('user_id', resolved.user_id);
    c.set('mcp_token_id', resolved.id);
    c.set('credential_kind', resolved.kind);
    c.set('credential_ws', resolved.home_workspace_id);
    c.set('oauth_scopes', resolved.scopes);
    c.set('allowed_workspace_ids', resolved.allowed_workspace_ids);
    // Customer-audit: every MCP call is an mcp_token_used event. Path is the
    // PRD's highest-risk egress channel; IT teams need to see what is leaving
    // their boundary even when the model is self-hosted.
    await deps.repo.logCustomerAudit(resolved.workspace_id, {
      event: 'mcp_token_used',
      actor_user_id: resolved.user_id,
      ...requestMeta(c),
      resource_type: 'mcp_token',
      resource_id: resolved.id,
      payload: { path: new URL(c.req.url).pathname },
    });
    // Every MCP call inherits workspace + user + token id on the LLM-log
    // context; the per-tool handler adds question/scope/deliverable_kind.
    await withLlmContext(
      {
        workspace_id: resolved.workspace_id,
        user_id: resolved.user_id,
        mcp_token_id: resolved.id,
      },
      () => next(),
    );
  }

  router.get('/mcp/workspaces/:ws/assets/:id/content', tokenGate, async (c) => {
    const ws = c.req.param('ws');
    if ((await deps.repo.getWorkspace(ws))?.ai_allowed === 0) return c.json({ error: 'not_found' }, 404);
    if (!await deps.repo.getMembership(ws, c.get('user_id'))) return c.json({ error: 'forbidden' }, 403);
    if (!deps.media) return c.json({ error: 'asset_unavailable' }, 503);
    return serveMediaContent(c, deps.media, ws, c.req.param('id'), c.get('user_id'));
  });

  // ---------- REST transport: GET /mcp/tools + POST /mcp/tools/<name> ----------

  // List tools (mirrors the MCP `tools/list` response). Schemas are derived
  // from the registry's zod shapes — one source of truth.
  router.get('/mcp/tools', tokenGate, (c) => {
    const scopes = c.get('oauth_scopes') as string[] | undefined;
    return c.json({
      tools: tools.filter((t) => !scopes || scopes.includes(oauthScopeForTool(t.name))).map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: toolJsonSchema(t),
      })),
    });
  });

  for (const tool of tools) {
    router.post(`/mcp/tools/${tool.name}`, tokenGate, async (c) => {
      const scopes = c.get('oauth_scopes') as string[] | undefined;
      const required = oauthScopeForTool(tool.name);
      if (scopes && !scopes.includes(required)) return c.json({ error: 'insufficient_scope', required_scope: required }, 403);
      // Tolerate empty/malformed bodies for tools whose args are all optional
      // (e.g. list_recent_changes with no `since`): zod decides, not JSON.parse.
      const body = await c.req.json().catch(() => ({}));
      const parsed = z.object(tool.inputShape).safeParse(body);
      if (!parsed.success) return c.json({ error: 'invalid' }, 400);
      // A named tool with valid arguments: the caller is a working client, not
      // a credential probe. This is the signal Get started's green state uses.
      const credKind = (c.get('credential_kind') as CredentialKind) ?? 'token';
      await deps.repo.recordCredentialToolCall(credKind, c.get('credential_ws') as string, c.get('mcp_token_id') as string);
      const ctx: ToolCtx = {
        ws: c.get('workspace_id') as string,
        home_ws: c.get('home_workspace_id') as string,
        user_id: c.get('user_id') as string,
        allowed_workspace_ids: c.get('allowed_workspace_ids') as string[] | undefined,
        ...requestMeta(c),
      };
      try {
        return c.json(await tool.handler(parsed.data, ctx));
      } catch (err) {
        if (err instanceof ToolError) return c.json(err.body(), err.httpStatus);
        throw err;
      }
    });
  }

  // ---------- MCP transport: streamable HTTP at POST /mcp/server ----------

  /**
   * One McpServer per request (stateless: no session ids, no SSE stream to
   * resume — plain JSON responses, which also keeps Caddy out of the SSE
   * business). The per-request cost is just closure setup; all heavy state
   * lives in deps.
   */
  function buildMcpServer(
    resolved: Resolution,
    meta: { source_ip?: string; user_agent?: string; origin?: string },
  ): McpServer {
    const server = new McpServer(
      { name: 'pomegranate', version: '0.1.0' },
      { instructions: SERVER_INSTRUCTIONS },
    );
    for (const tool of tools) {
      if (resolved.scopes && !resolved.scopes.includes(oauthScopeForTool(tool.name))) continue;
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputShape,
          annotations: tool.annotations,
        },
        async (args: any) => {
          // Same customer-audit event the REST tokenGate writes, but keyed by
          // tool name — over streamable HTTP every call shares one path, so
          // the path no longer identifies what left the boundary.
          await deps.repo.logCustomerAudit(resolved.workspace_id, {
            event: 'mcp_token_used',
            actor_user_id: resolved.user_id,
            source_ip: meta.source_ip,
            user_agent: meta.user_agent,
            resource_type: 'mcp_token',
            resource_id: resolved.id,
            payload: { tool: tool.name, transport: 'mcp' },
          });
          // A real tools/call on this credential — the SDK has already matched
          // the tool name and validated its arguments, so this is an assistant
          // using the connection, not a client validating the link.
          await deps.repo.recordCredentialToolCall(resolved.kind, resolved.home_workspace_id, resolved.id);
          const ctx: ToolCtx = {
            ws: resolved.workspace_id,
            home_ws: resolved.home_workspace_id,
            user_id: resolved.user_id,
            allowed_workspace_ids: resolved.allowed_workspace_ids,
            ...meta,
          };
          try {
            const result = await withLlmContext(
              {
                workspace_id: resolved.workspace_id,
                user_id: resolved.user_id,
                mcp_token_id: resolved.id,
              },
              () => tool.handler(args, ctx),
            );
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
          } catch (err) {
            // Tool-level failures go back as isError results (not protocol
            // errors) so the model can react — e.g. tell the user a candidate
            // was already resolved — instead of surfacing a raw failure.
            if (err instanceof ToolError) {
              return {
                content: [{ type: 'text' as const, text: JSON.stringify(err.body()) }],
                isError: true,
              };
            }
            throw err;
          }
        },
      );
    }
    return server;
  }

  router.post('/mcp/server', async (c) => {
    const { value: resolved, limited } = await resolveCredential(c);
    if (limited) return limited;
    if (!resolved) return challenge(c);

    // The streamable transport writes straight to the Node response; that
    // only exists under @hono/node-server (not in app.request() test calls).
    const env = c.env as { incoming?: any; outgoing?: any } | undefined;
    if (!env?.incoming || !env?.outgoing) {
      return c.json({ error: 'mcp transport requires the node server runtime' }, 501);
    }

    const server = buildMcpServer(resolved, requestMeta(c));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true, // plain JSON instead of SSE
    });
    env.outgoing.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    const body = await c.req.json().catch(() => undefined);
    await transport.handleRequest(env.incoming, env.outgoing, body);
    return RESPONSE_ALREADY_SENT;
  });

  // Stateless server: no SSE stream to GET, no session to DELETE.
  router.get('/mcp/server', (c) => c.json({ error: 'method not allowed' }, 405));
  router.delete('/mcp/server', (c) => c.json({ error: 'method not allowed' }, 405));

  // ---------- claude.ai connector: secret-in-URL transport ----------
  //
  // Same streamable transport as /mcp/server, but the credential is the path
  // secret instead of a bearer header — because claude.ai's custom connector
  // UI can't send one. The secret resolves in-app to (workspace, user), so
  // creating a connector is a DB row (self-serve from Settings), not a Caddy
  // block + env var like the legacy static connectors. The `/mcp/*`
  // proxy already forwards this path, so no reverse-proxy change is needed.
  router.post('/mcp/connector/:secret', async (c) => {
    if (!capabilityUrlsEnabled()) return c.json({ error: 'not found' }, 404);
    const secret = c.req.param('secret');
    const { value: raw, limited } = await guard.check(c, secret, () => deps.repo.resolveConnectorSecret(secret));
    if (limited) return limited;
    if (!raw) return c.json({ error: 'invalid connector' }, 401);
    const resolved = await effectiveResolution(deps, raw, 'connector');

    const env = c.env as { incoming?: any; outgoing?: any } | undefined;
    if (!env?.incoming || !env?.outgoing) {
      return c.json({ error: 'mcp transport requires the node server runtime' }, 501);
    }

    const server = buildMcpServer(resolved, requestMeta(c));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true, // plain JSON instead of SSE
    });
    env.outgoing.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    const body = await c.req.json().catch(() => undefined);
    await transport.handleRequest(env.incoming, env.outgoing, body);
    return RESPONSE_ALREADY_SENT;
  });
  router.get('/mcp/connector/:secret', (c) => c.json({ error: 'method not allowed' }, 405));
  router.delete('/mcp/connector/:secret', (c) => c.json({ error: 'method not allowed' }, 405));
}
