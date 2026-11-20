import { describe, it, expect, afterEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import {
  runSurfaceAgent,
  type CreateMessage,
  type SurfaceAgentParams,
} from './surface-agent.js';
import { setStructuredLLM, type StructuredLLMOverride } from '../../lib/anthropic.js';
import type { ToolCtx, ToolDef } from '../mcp/registry.js';

/**
 * Loop semantics of the surface agent — above all the confirm-first
 * interceptor, which is DETERMINISTIC (in the loop), not prompt policy:
 * a mutating tool call never executes on first attempt; a matching re-call
 * on the next turn (armed by the thread's pending action) does.
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

/** A tiny registry: one read tool, one mutating tool, both recording calls. */
function fakeTools() {
  const executed: Array<{ tool: string; args: unknown }> = [];
  const tools: ToolDef[] = [
    {
      name: 'peek',
      title: 'Peek',
      description: 'read something',
      inputShape: { key: z.string() },
      annotations: { readOnlyHint: true },
      async handler(args: { key: string }) {
        executed.push({ tool: 'peek', args });
        return { value: `<${args.key}>` };
      },
    },
    {
      name: 'smash',
      title: 'Smash',
      description: 'mutate something',
      inputShape: { target: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true },
      async handler(args: { target: string }) {
        executed.push({ tool: 'smash', args });
        return { ok: true, smashed: args.target };
      },
    },
    {
      // A mutating tool with a freeform `source` payload — the ingest_document
      // shape. Models can't reproduce the source verbatim on the yes-turn.
      name: 'stash',
      title: 'Stash',
      description: 'ingest a note',
      inputShape: { source: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false },
      async handler(args: { source: string }) {
        executed.push({ tool: 'stash', args });
        return { ok: true, stashed: args.source.length };
      },
    },
  ];
  return { tools, executed };
}

const CTX: ToolCtx = { ws: 'ws_t', home_ws: 'ws_t', user_id: 'u_t' };

function baseParams(overrides: Partial<SurfaceAgentParams> = {}): SurfaceAgentParams {
  const { tools } = fakeTools();
  return {
    tools,
    ctx: CTX,
    history: [],
    user_message: 'hello',
    pending_action: null,
    systemPrompt: 'test system prompt',
    promptTask: 'surface-agent-test',
    promptVersion: 1,
    ...overrides,
  };
}

describe('runSurfaceAgent — execute on first call (no confirm-first)', () => {
  it('read-only tools execute immediately, no pending action', async () => {
    const { tools, executed } = fakeTools();
    const model = scriptedModel([
      message([toolUse('t1', 'peek', { key: 'goals' })], 'tool_use'),
      message([textBlock('You have 3 goals.')], 'end_turn'),
    ]);
    const r = await runSurfaceAgent(baseParams({ tools }), model.create);
    expect(executed).toEqual([{ tool: 'peek', args: { key: 'goals' } }]);
    expect(r.pending_action).toBeNull();
    expect(r.message).toBe('You have 3 goals.');
    expect(r.receipts).toHaveLength(0);
  });

  it('a mutating call runs on the FIRST call and produces a receipt — no confirmation', async () => {
    const { tools, executed } = fakeTools();
    const model = scriptedModel([
      message([toolUse('t1', 'smash', { target: 'doc_1' })], 'tool_use'),
      message([textBlock('Done — doc_1 smashed.')], 'end_turn'),
    ]);
    const r = await runSurfaceAgent(baseParams({ tools, user_message: 'smash doc_1' }), model.create);
    expect(executed).toEqual([{ tool: 'smash', args: { target: 'doc_1' } }]);
    expect(r.receipts).toEqual([
      { tool: 'smash', args: { target: 'doc_1' }, result: { ok: true }, ok: true },
    ]);
    expect(r.pending_action).toBeNull();
    // The model saw the real outcome, never a needs_confirmation observation.
    const toolResult = JSON.stringify(model.calls[1]!.messages.at(-1)!.content);
    expect(toolResult).toContain('smashed');
    expect(toolResult).not.toContain('needs_confirmation');
  });

  it('an ingest-shaped mutating call with a freeform payload runs immediately', async () => {
    const { tools, executed } = fakeTools();
    const model = scriptedModel([
      message([toolUse('t1', 'stash', { source: 'there are three main coding agents' })], 'tool_use'),
      message([textBlock('Added your note.')], 'end_turn'),
    ]);
    const r = await runSurfaceAgent(baseParams({ tools, user_message: 'ingest this' }), model.create);
    expect(executed).toEqual([{ tool: 'stash', args: { source: 'there are three main coding agents' } }]);
    expect(r.receipts).toHaveLength(1);
    expect(r.receipts[0]).toMatchObject({ tool: 'stash', ok: true });
    expect(r.pending_action).toBeNull();
  });

  it('several mutating calls in one turn all execute', async () => {
    const { tools, executed } = fakeTools();
    const model = scriptedModel([
      message(
        [toolUse('t1', 'smash', { target: 'doc_1' }), toolUse('t2', 'smash', { target: 'doc_2' })],
        'tool_use',
      ),
      message([textBlock('Both done.')], 'end_turn'),
    ]);
    const r = await runSurfaceAgent(baseParams({ tools }), model.create);
    expect(executed).toEqual([
      { tool: 'smash', args: { target: 'doc_1' } },
      { tool: 'smash', args: { target: 'doc_2' } },
    ]);
    expect(r.receipts).toHaveLength(2);
    expect(r.pending_action).toBeNull();
  });

  it('invalid tool args surface as an error observation, not a crash', async () => {
    const { tools } = fakeTools();
    const model = scriptedModel([
      message([toolUse('t1', 'peek', { wrong: 1 })], 'tool_use'),
      message([textBlock('That did not work.')], 'end_turn'),
    ]);
    const r = await runSurfaceAgent(baseParams({ tools }), model.create);
    const toolResult = JSON.stringify(model.calls[1]!.messages.at(-1)!.content);
    expect(toolResult).toContain('invalid');
    expect(r.message).toBe('That did not work.');
  });

  it('no pending-action block is rendered into the model context', async () => {
    const { tools } = fakeTools();
    const model = scriptedModel([message([textBlock('ok')], 'end_turn')]);
    await runSurfaceAgent(baseParams({ tools, user_message: 'hi' }), model.create);
    const firstUserBlock = String(model.calls[0]!.messages[0]!.content);
    expect(firstUserBlock).not.toContain('Pending action');
    expect(firstUserBlock).not.toContain('awaiting confirmation');
  });

  it('restores an unresolved route id into the next-turn context', async () => {
    const { tools } = fakeTools();
    const model = scriptedModel([message([textBlock('ok')], 'end_turn')]);
    await runSurfaceAgent(
      baseParams({
        tools,
        user_message: 'approve it',
        pending_action: {
          tool: 'resolve_pending_route',
          args: { id: 'pr_123' },
          summary: 'Should I file this in Product?',
          created_at: '2026-09-11T00:00:00.000Z',
        },
      }),
      model.create,
    );
    const firstUserBlock = String(model.calls[0]!.messages[0]!.content);
    expect(firstUserBlock).toContain('Unresolved decision from the previous turn');
    expect(firstUserBlock).toContain('pr_123');
    expect(firstUserBlock).toContain('Do not ingest the source again');
  });
});

// ---- structured-per-turn mode (the hosted Together / local Qwen seam) ----

/** Scripted structured override: returns queued surface_step decisions. */
function scriptedOverride(steps: Array<Record<string, unknown>>) {
  const calls: Array<{ system: string; user: string; schema: Record<string, unknown> }> = [];
  let i = 0;
  const override: StructuredLLMOverride = {
    name: 'test-structured',
    async callStructured(opts) {
      calls.push({ system: opts.system, user: opts.user, schema: opts.schema });
      const s = steps[Math.min(i, steps.length - 1)];
      i++;
      return s;
    },
  };
  return { override, calls };
}

describe('runSurfaceAgent — structured seam (hosted Together / local Qwen)', () => {
  afterEach(() => setStructuredLLM(null));

  it('routes through the override when installed: read tool runs, reply returned', async () => {
    const { tools, executed } = fakeTools();
    const { override, calls } = scriptedOverride([
      { thought: 'look', tool: 'peek', key: 'goals' },
      { thought: 'done', tool: 'none', reply: 'You have 3 goals.' },
    ]);
    setStructuredLLM(override);
    const r = await runSurfaceAgent(baseParams({ tools })); // no createMessage → override path
    expect(executed).toEqual([{ tool: 'peek', args: { key: 'goals' } }]);
    expect(r.message).toBe('You have 3 goals.');
    expect(r.pending_action).toBeNull();
    // The protocol + tool catalog ride in the system prompt; the second turn
    // sees the observation.
    expect(calls[0]!.system).toContain('surface_step');
    expect(calls[0]!.system).toContain('- peek —');
    expect(calls[1]!.user).toContain('peek({"key":"goals"})');
  });

  it('a mutating step executes on the first emit in structured mode — no confirmation', async () => {
    const { tools, executed } = fakeTools();
    const { override, calls } = scriptedOverride([
      { thought: 'do it', tool: 'smash', target: 'doc_1' },
      { thought: 'done', tool: 'none', reply: 'Done — doc_1 smashed.' },
    ]);
    setStructuredLLM(override);
    const r = await runSurfaceAgent(baseParams({ tools, user_message: 'smash doc_1' }));
    expect(executed).toEqual([{ tool: 'smash', args: { target: 'doc_1' } }]);
    expect(r.receipts).toEqual([
      { tool: 'smash', args: { target: 'doc_1' }, result: { ok: true }, ok: true },
    ]);
    expect(r.pending_action).toBeNull();
    // The second turn saw the real outcome, never a needs_confirmation stub.
    expect(calls[1]!.user).toContain('"ok":true');
    expect(calls[1]!.user).not.toContain('needs_confirmation');
  });

  it('an ingest-shaped step with a freeform payload runs immediately in structured mode', async () => {
    // The exact transcript flow: "ingest this" → the note is stored in one turn,
    // no yes/confirm round-trip, no re-arm loop.
    const { tools, executed } = fakeTools();
    const { override } = scriptedOverride([
      { thought: 'ingest', tool: 'stash', source: 'there are three main coding agents' },
      { thought: 'done', tool: 'none', reply: 'Added your note.' },
    ]);
    setStructuredLLM(override);
    const r = await runSurfaceAgent(baseParams({ tools, user_message: 'ingest this' }));
    expect(executed).toEqual([{ tool: 'stash', args: { source: 'there are three main coding agents' } }]);
    expect(r.receipts.length).toBe(1);
    expect(r.receipts[0]).toMatchObject({ tool: 'stash', ok: true });
    expect(r.pending_action).toBeNull();
  });

  it('an injected createMessage still wins over the override (tests, native path)', async () => {
    const { tools, executed } = fakeTools();
    setStructuredLLM(scriptedOverride([{ tool: 'none', reply: 'wrong path' }]).override);
    const model = scriptedModel([
      message([toolUse('t1', 'peek', { key: 'x' })], 'tool_use'),
      message([textBlock('native path')], 'end_turn'),
    ]);
    const r = await runSurfaceAgent(baseParams({ tools }), model.create);
    expect(r.message).toBe('native path');
    expect(executed).toEqual([{ tool: 'peek', args: { key: 'x' } }]);
  });
});
