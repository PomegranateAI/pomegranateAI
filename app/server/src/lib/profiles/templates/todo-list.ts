import type { ContextProfile } from '../../schemas.js';

/**
 * `todo_list` — PLACEHOLDER template (shape: `log`).
 *
 * The structure below (id, shape, kind keys, source channels) is what the
 * runtime depends on. Every prose string is a minimal working placeholder:
 * replace it with guidance for your own use case. The strings are sent to the
 * capture / routing / review prompts, so write them as instructions to the
 * model. See docs/llm-calls.md and src/lib/prompt-render.ts for where each
 * field lands. Keep descriptions >= 80 chars (profile) / 60 chars (kinds) or
 * validate.ts will warn.
 */
export const todoListTemplate: ContextProfile = {
  id: 'todo_list',
  name: 'To-do list',
  shape: 'log',
  // PLACEHOLDER: when should the router send a document to this folder?
  routing_hint:
    'To-do list: documents that add items to a list of things to do, mark items done or ' +
    'dropped, or change how urgent an item is.',
  // PLACEHOLDER: what this folder is for and how capture should read documents.
  description:
    'A running to-do list. Each document reports items added, items resolved, and items whose ' +
    'priority changed. Take each item exactly as the document states it. A plain list of things ' +
    'to do is all new tasks. Do not extract suggestions nobody committed to.',
  kinds: [
    {
      key: 'new_tasks',
      label: 'New tasks',
      label_plural: 'New tasks',
      color: 1,
      // PLACEHOLDER
      description:
        'Every task newly added in one document, as one node. Title: a short comma list of the ' +
        'tasks. Body: one task per line, with any owner or deadline the source gives.',
      body_spec: 'body (string — one task per line, every task this document adds)',
    },
    {
      key: 'status_update',
      label: 'Status update',
      label_plural: 'Status updates',
      color: 2,
      // PLACEHOLDER
      description:
        'Every task reported done or cancelled in one document, as one node. Body: one task per ' +
        'line, naming the task and its new state.',
      body_spec: 'body (string — one task per line, each with its new state)',
    },
    {
      key: 'priority_change',
      label: 'Priority change',
      label_plural: 'Priority changes',
      color: 3,
      // PLACEHOLDER
      description:
        'Every task reported more or less urgent (with no status change) in one document, as one ' +
        'node. Body: one task per line with its new priority, only when the source says so.',
      body_spec: 'body (string — one task per line, each with its new priority)',
    },
  ],
  edge_kinds: [],
  edges_deliberately_empty: true,
  source_types: [
    {
      key: 'standup',
      label: 'Standup / status note',
      description: 'A short update on what someone did, is doing, and is blocked on.',
      // PLACEHOLDER
      extraction_guidance: 'Read finished work as status updates and first mentions as new tasks.',
      source_kinds: ['slack'],
    },
    {
      key: 'meeting',
      label: 'Meeting notes / transcript',
      description: 'Notes or a transcript from a discussion where items got assigned.',
      // PLACEHOLDER
      extraction_guidance: 'Extract the commitments, not the discussion around them.',
      source_kinds: ['transcript', 'interaction'],
    },
    {
      key: 'mail',
      label: 'Mail thread',
      description: 'An email chain where items are requested, promised, or reported.',
      // PLACEHOLDER
      extraction_guidance: 'Read the last message first; the final state of a request is what matters.',
      source_kinds: ['doc'],
    },
  ],
  feedback_dimensions: [
    { key: 'completeness', label: 'Completeness', description: 'whether the items the draft refers to are tracked here' },
    { key: 'currency', label: 'Currency', description: 'whether the draft reflects the latest reported state of each item' },
  ],
  review_kinds: ['other'],
  query_scopes: [{ key: 'all', label: 'Everything', kind_keys: 'all' }],
  flag_semantics: {
    red: 'states an item is in a state the list most recently reported the opposite of',
    yellow: 'refers to an item not tracked here',
    green: 'consistent with what the list most recently reported (default)',
  },
  // PLACEHOLDER: the questions this folder should answer well.
  seed_questions: ['What is still pending?', 'What did we finish recently?'],
};
