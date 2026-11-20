import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { runAddSourceAgent, buildStepSchema, DEFER_TO_ROUTER, MAX_CLEANUP_SOURCE_CHARS, type AddSourceAgentParams } from './add-source-agent.js';
import type { CreateMessage, SurfaceAgentResult } from './surface-agent.js';
import type { ToolCtx, ToolDef } from '../mcp/registry.js';

/**
 * The Add Source instructions agent: same engine as the Slack surface agent
 * (see surface-agent.test.ts for the loop's own semantics — execute-on-first-
 * call, receipts, etc.), narrowed to the ingest_document/create_subfolder
 * tools and pointed at a document instead of a chat message. These tests
 * cover the two things specific to THIS task: picking an existing folder by
 * name, and creating a new one before ingesting into it.
 */

function textBlock(text: string): Anthropic.TextBlock {
  return { type: 'text', text, citations: null } as Anthropic.TextBlock;
}
function toolUse(id: string, name: string, input: Record<string, unknown>): Anthropic.ToolUseBlock {
  return { type: 'tool_use', id, name, input } as Anthropic.ToolUseBlock;
}
function message(content: Anthropic.ContentBlock[], stop: 'tool_use' | 'end_turn'): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'test',
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  } as unknown as Anthropic.Message;
}

function scriptedModel(responses: Anthropic.Message[]) {
  const calls: Array<Parameters<CreateMessage>[0]> = [];
  let i = 0;
  const create: CreateMessage = async (req) => {
    calls.push(req);
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return r!;
  };
  return { create, calls };
}

/** Fake ingest_document + create_subfolder — same shapes as registry.ts's
 *  real tools, recording every call. */
function fakeIngestTools() {
  const executed: Array<{ tool: string; args: unknown }> = [];
  const tools: ToolDef[] = [
    {
      name: 'ingest_document',
      title: 'Add a source to the vault',
      description: 'ingest',
      inputShape: {
        source: z.string().min(1),
        source_kind: z.enum(['doc', 'slack', 'transcript', 'interaction']).default('doc'),
        source_ref: z.string().optional(),
        audience: z.enum(['team', 'private', 'only_me']).default('team'),
        subgraph: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      async handler(args: { source: string; subgraph?: string }) {
        executed.push({ tool: 'ingest_document', args });
        return { candidates: 2, document_id: 'doc_1', routed: [{ subgraph_id: args.subgraph ?? 'default', candidates: 2 }] };
      },
    },
    {
      name: 'create_subfolder',
      title: 'Create a folder',
      description: 'create folder',
      inputShape: {
        template_id: z.string().min(1),
        name: z.string().min(1).optional(),
        slug: z.string().min(1).optional(),
        description: z.string().max(500).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      async handler(args: { template_id: string; name?: string }) {
        executed.push({ tool: 'create_subfolder', args });
        return { subgraph_id: 'sg_new', slug: 'people', name: args.name ?? 'People', template_id: args.template_id };
      },
    },
  ];
  return { tools, executed };
}

const CTX: ToolCtx = { ws: 'ws_t', home_ws: 'ws_t', user_id: 'u_t' };

function baseParams(overrides: Partial<AddSourceAgentParams> = {}): AddSourceAgentParams {
  const { tools } = fakeIngestTools();
  return {
    instructions: 'pull out the people mentioned into a People folder',
    source: 'Attendees: Priya, Marcus, and Jo.',
    source_kind: 'doc',
    ctx: CTX,
    tools,
    folders: [{ id: 'sg_people', slug: 'people', name: 'People', description: 'People we track' }],
    templates: [{ id: 'people_list', name: 'People list', description: 'A list of people' }],
    ...overrides,
  };
}

describe('runAddSourceAgent', () => {
  it('picks an existing folder from the ones in context', async () => {
    const { tools, executed } = fakeIngestTools();
    const model = scriptedModel([
      message([toolUse('t1', 'ingest_document', { source: 'Priya, Marcus, Jo', subgraph: 'people' })], 'tool_use'),
      message([textBlock('Filed the attendee list under People.')], 'end_turn'),
    ]);
    const r = await runAddSourceAgent(baseParams({ tools }), model.create);
    expect(executed).toEqual([
      {
        tool: 'ingest_document',
        args: { source: 'Priya, Marcus, Jo', subgraph: 'people', source_kind: 'doc', audience: 'team' },
      },
    ]);
    expect(r.receipts).toHaveLength(1);
    expect(r.receipts[0]).toMatchObject({ tool: 'ingest_document', ok: true });
    // Widened receipt keys (surface-agent.ts RECEIPT_KEYS) carry document_id/routed through.
    expect(r.receipts[0]!.result.document_id).toBe('doc_1');
    expect(r.message).toBe('Filed the attendee list under People.');

    // The composed context includes the instructions, document, and the
    // folder/template catalog — not just a bare user_message passthrough.
    const firstUserBlock = String(model.calls[0]!.messages[0]!.content);
    expect(firstUserBlock).toContain('pull out the people mentioned');
    expect(firstUserBlock).toContain('Attendees: Priya, Marcus, and Jo.');
    expect(firstUserBlock).toContain('people (id sg_people)');
    expect(firstUserBlock).toContain('people_list (People list)');
  });

  it('creates a new folder, then ingests into the id it returned', async () => {
    const { tools, executed } = fakeIngestTools();
    const model = scriptedModel([
      message(
        [toolUse('t1', 'create_subfolder', { template_id: 'people_list', name: 'People', description: 'People mentioned in docs' })],
        'tool_use',
      ),
      message([toolUse('t2', 'ingest_document', { source: 'Priya, Marcus, Jo', subgraph: 'sg_new' })], 'tool_use'),
      message([textBlock('Created a People folder and filed the attendee list there.')], 'end_turn'),
    ]);
    const r = await runAddSourceAgent(baseParams({ tools, folders: [] }), model.create);
    expect(executed).toEqual([
      {
        tool: 'create_subfolder',
        args: { template_id: 'people_list', name: 'People', description: 'People mentioned in docs' },
      },
      {
        tool: 'ingest_document',
        args: { source: 'Priya, Marcus, Jo', subgraph: 'sg_new', source_kind: 'doc', audience: 'team' },
      },
    ]);
    expect(r.receipts).toHaveLength(2);
    expect(r.receipts[0]).toMatchObject({ tool: 'create_subfolder', ok: true });
    expect(r.receipts[0]!.result.subgraph_id).toBe('sg_new');
    expect(r.receipts[1]).toMatchObject({ tool: 'ingest_document', ok: true });
  });

  it('falls back to the original document when the model leaves source unset (no transform)', async () => {
    const { tools, executed } = fakeIngestTools();
    const model = scriptedModel([
      message([toolUse('t1', 'ingest_document', { subgraph: 'people' })], 'tool_use'),
      message([textBlock('Filed the document under People as-is.')], 'end_turn'),
    ]);
    const original = 'Attendees: Priya, Marcus, and Jo.';
    const r = await runAddSourceAgent(baseParams({ tools, source: original }), model.create);
    expect(executed).toEqual([
      { tool: 'ingest_document', args: { subgraph: 'people', source_kind: 'doc', audience: 'team', source: original } },
    ]);
    // Self-auditing: the receipt records what the MODEL emitted, not the
    // code-substituted args — no `source` key here means no transform happened.
    expect(r.receipts[0]!.args.source).toBeUndefined();
  });

  it('uses the model-provided source when it deliberately transforms the text', async () => {
    const { tools, executed } = fakeIngestTools();
    const transformed = 'Priya, Marcus, Jo';
    const model = scriptedModel([
      message([toolUse('t1', 'ingest_document', { source: transformed, subgraph: 'people' })], 'tool_use'),
      message([textBlock('Extracted the names.')], 'end_turn'),
    ]);
    await runAddSourceAgent(baseParams({ tools, source: 'Attendees: Priya, Marcus, and Jo.' }), model.create);
    expect(executed[0]!.args.source).toBe(transformed);
  });

  it('the tool catalog is narrowed to ingest_document + create_subfolder even if more are passed in', async () => {
    const { tools: ingestTools } = fakeIngestTools();
    const extra: ToolDef = {
      name: 'list_folders',
      title: 'List folders',
      description: 'should not be offered to this agent',
      inputShape: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler() {
        return { folders: [] };
      },
    };
    const model = scriptedModel([message([textBlock('ok')], 'end_turn')]);
    await runAddSourceAgent(baseParams({ tools: [...ingestTools, extra] }), model.create);
    const toolNames = (model.calls[0]!.tools ?? []).map((t) => t.name);
    expect(toolNames.sort()).toEqual(['create_subfolder', 'ingest_document']);
  });

  it('rejects a document over MAX_CLEANUP_SOURCE_CHARS before ever calling the model', async () => {
    const { tools } = fakeIngestTools();
    // No scripted responses: a call reaching the model would throw
    // "unexpected model call" and fail this test for the wrong reason.
    const model = scriptedModel([]);
    const oversized = 'x'.repeat(MAX_CLEANUP_SOURCE_CHARS + 1);
    await expect(runAddSourceAgent(baseParams({ tools, source: oversized }), model.create)).rejects.toThrow(
      /too large/,
    );
    expect(model.calls).toEqual([]);
  });
});

describe('buildStepSchema (structured-mode per-step schema)', () => {
  const TOOLS = [{ name: 'ingest_document' }, { name: 'create_subfolder' }] as unknown as Parameters<typeof buildStepSchema>[0];
  const FOLDERS = [{ id: 'sg_people', slug: 'people', name: 'People' }];
  const TEMPLATES = [{ id: 'people_list', name: 'People list', description: 'A roster of people.' }];

  function subgraphField(receipts: SurfaceAgentResult['receipts'] = []) {
    const schema = buildStepSchema(TOOLS, receipts, FOLDERS, TEMPLATES) as {
      properties: Record<string, { enum?: unknown[] }>;
      required: string[];
    };
    return { enum: schema.properties.subgraph!.enum, required: schema.required };
  }

  it('subgraph is required and its enum is the shown folders plus the defer-to-router sentinel', () => {
    const { enum: choices, required } = subgraphField();
    expect(choices).toEqual(['people', DEFER_TO_ROUTER]);
    expect(required).toContain('subgraph');
  });

  it('a folder created earlier this run is added to the enum', () => {
    const receipts: SurfaceAgentResult['receipts'] = [
      { tool: 'create_subfolder', args: { template_id: 'people_list' }, result: { subgraph_id: 'sg_new' }, ok: true },
    ];
    const { enum: choices } = subgraphField(receipts);
    expect(choices).toEqual(['people', 'sg_new', DEFER_TO_ROUTER]);
  });

  it('a FAILED create_subfolder call does not pollute the enum', () => {
    const receipts: SurfaceAgentResult['receipts'] = [
      { tool: 'create_subfolder', args: { template_id: 'bogus' }, result: { error: 'invalid' }, ok: false },
    ];
    const { enum: choices } = subgraphField(receipts);
    expect(choices).toEqual(['people', DEFER_TO_ROUTER]);
  });

  it('template_id enum matches the passed-in template catalog', () => {
    const schema = buildStepSchema(TOOLS, [], FOLDERS, TEMPLATES) as { properties: Record<string, { enum?: unknown[] }> };
    expect(schema.properties.template_id!.enum).toEqual(['people_list', null]);
  });
});
