import type { ContextProfile } from '../schemas.js';

/**
 * The `notes` template — the single, general-purpose folder shape. Replaces
 * the twelve narrow templates Pomegranate Light shipped (2026-07-17/18):
 * `todo_list`, `project_status`, `brand_voice`, `policy_book`, `appointment`,
 * `decision_log`, `spec_sheet`, `strategy`, `evidence_log`, `user_insight`,
 * `goals_metrics`, `people_list`. That catalog optimized for per-template
 * extraction precision (see the R3/R4/R7 incidents documented on those files)
 * at the cost of breadth — a document that didn't fit one of twelve narrow
 * jobs had nowhere obvious to go. `notes` inverts the trade: one folder job
 * ("keep what arrives"), no classification risk, works for anything.
 *
 * SHAPE: `log`, with exactly ONE kind. A `log` shape batches everything a
 * document reports into one node per kind present — with only one kind
 * (`note`) that collapses to the simplest possible rule: one document, one
 * node. This is deliberately the same cardinality the pre-Light `default`
 * whole-doc profile gave (1 doc → 1 node, no dedup/curation gate), reached
 * here through the current shape system rather than the retired
 * `capture_mode: 'whole_doc'` field. Nothing to classify into means nothing
 * to get wrong: R3 (shape/kind cardinality contradiction) and R7
 * (source-type suppression) are structurally hard to hit with a single kind.
 *
 * LAYER DISCIPLINE (see the pomegranate-template-contract skill): this file
 * is the TEMPLATE — the shape of ANY notes folder. It must not assume what a
 * given folder is ABOUT (work, a project, a household) — that is the
 * subfolder's own content (its `description` + `generated_description`).
 * Hence no domain nouns here, only "document" / "note" / "information".
 */
export const notesTemplate: ContextProfile = {
  id: 'notes',
  name: 'Notes',
  shape: 'log',
  routing_hint:
    'Notes: a general record of information — anything a document states, reports, decides, or ' +
    'describes. Route here for any document with informational content; there is nothing this ' +
    'template excludes by topic. It is the catch-all: when no more specific reason to route ' +
    'elsewhere applies, this is where a document belongs.',
  description:
    'This folder holds notes — a running record of whatever information arrives, with no ' +
    'assumption about what it is about. Each document that arrives becomes ONE note: everything ' +
    'it states, reports, decides, or describes, restated compactly in one node. This is not a log ' +
    'of changes and not a curated registry; it is the document\'s own content, kept close to how ' +
    'it arrived.\n\n' +
    'WHAT THIS FOLDER IS ABOUT IS NOT YOURS TO DECIDE. This template does not assume a subject — ' +
    'a to-do list, a decision, a customer quote, a policy, a plan, a person, an idea: anything a ' +
    'document contains is in scope. The folder\'s own description and what it already holds say ' +
    'what it is actually being used for; never widen, narrow, or reject a document\'s content ' +
    'because of what you expect this kind of folder to hold.\n\n' +
    'ANY DOCUMENT WITH INFORMATIONAL CONTENT PRODUCES A NOTE. A plain paragraph, a list, a quick ' +
    'message, a long report, a transcript — all become one note apiece. This is the most common ' +
    'shape of document this folder receives and it is never empty of content. Silence is only for ' +
    'a document that states nothing at all (a blank file, a pure greeting, an automated ping with ' +
    'no content).\n\n' +
    'DO NOT EXTRACT: pure logistics with no informational content (scheduling chatter that settles ' +
    'nothing), boilerplate (signatures, headers, unsubscribe links), or a document empty of ' +
    'substance.',
  kinds: [
    {
      key: 'note',
      label: 'Note',
      label_plural: 'Notes',
      color: 1,
      description:
        'Everything ONE document states, reports, decides, or describes, as ONE node. Title: a ' +
        'short phrase naming what the document is about ("Q3 budget review", "Grocery list", ' +
        '"Client call notes"). Body: the document\'s content restated compactly — every fact, ' +
        'decision, item, or statement it contains, in the order that makes it easiest to read ' +
        'back, trimmed of greetings, signatures, and filler but never trimmed of information. A ' +
        'document covering several distinct things is still ONE node holding all of them; a ' +
        'document with ten items is one node with ten lines, not ten nodes.',
      body_spec:
        'body (string — the document\'s content restated compactly: every fact, decision, item, ' +
        'or statement it contains, preserving all information, trimmed only of greetings, ' +
        'signatures, and pure filler)',
    },
  ],
  edge_kinds: [],
  // Deliberate: a single generic `note` kind has no structural relation to
  // infer generically (unlike a template whose kinds are typed entities that
  // reference one another). Currency between notes on the same topic is
  // resolved by recency (`updated_at`) at read time, not by a declared edge.
  edges_deliberately_empty: true,
  source_types: [
    {
      key: 'chat',
      label: 'Chat message',
      description: 'A short chat message, DM, or quick note.',
      extraction_guidance:
        'Even a one-line message is a complete note if it states something — do not wait for more ' +
        'context before capturing it.',
      source_kinds: ['slack'],
    },
    {
      key: 'conversation',
      label: 'Meeting or conversation',
      description: 'Notes or a transcript of a spoken conversation or interaction.',
      extraction_guidance:
        'Capture what was said, decided, or reported — not the back-and-forth that led to it. Skip ' +
        'small talk and false starts.',
      source_kinds: ['transcript', 'interaction'],
    },
    {
      key: 'document',
      label: 'Written document',
      description: 'A written document, upload, or file — the default register when nothing more specific applies.',
      extraction_guidance: '',
      source_kinds: ['doc'],
    },
  ],
  feedback_dimensions: [
    {
      key: 'accuracy',
      label: 'Accuracy',
      description: 'whether the draft reflects what a note actually says, not a paraphrase drifting from it',
    },
    {
      key: 'coverage',
      label: 'Coverage',
      description: 'whether notes actually relevant were considered, not just the most recent one',
    },
  ],
  review_kinds: ['other'],
  query_scopes: [{ key: 'all', label: 'Everything', kind_keys: 'all' }],
  flag_semantics: {
    red: 'states something a note directly contradicts — the opposite of what was actually recorded',
    yellow: 'refers to information not found in any note here, or states something no note actually supports',
    green: 'consistent with what the notes record (default)',
  },
  seed_questions: [
    'What do we know about X?',
    'What was said or decided about X?',
    'What is the most recent note on X?',
    'What is in this folder?',
  ],
};
